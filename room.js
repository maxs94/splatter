// One game: a lobby with its players and settings, and the match they play. Rooms run
// in worker threads (room-worker.js), any number side by side.

import {
  CONFIG as C, WEAPONS, GRENADE, PALETTE, LEVEL, segBox, segLevel, stepProjectile, hitPoint,
  groundHeight, lineOfSight, spawnYaw,
} from './shared/game.js';
import { NavGraph } from './bots/nav.js';
import { Bot, BOT_NAMES } from './bots/brain.js';
import { prof } from './profiler.js';

// Bots fill the arena up to this many players while at least one human is connected.
// A match holds at most this many players, humans and bots together.
export const MAX_PLAYERS = 10;
// Default number of bots for a new lobby; the lobby leader can change it.
export const DEFAULT_BOTS = Math.min(MAX_PLAYERS - 1, Math.max(0, Number(process.env.BOTS ?? 3)));
// Bot skill 0..1, each bot gets a bit of random variation around it.
const BOT_SKILL = Math.min(1, Math.max(0, Number(process.env.BOT_SKILL ?? 0.4)));

// The level never changes, so all rooms of a thread share one navigation graph. Built
// by prepare() or the first room, so the main thread can import this file without it.
let nav = null;
export function prepare() { nav ??= new NavGraph(); }

// Ids are unique across the rooms of a thread.
let nextPlayerId = 1;
let nextProjectileId = 1;

const r3 = x => Math.round(x * 1000) / 1000;
const vec = (v, n = 3) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
const seed = () => (Math.random() * 0x7fffffff) | 0;

export function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    const data = JSON.stringify(msg);
    ws.send(data);
    prof.sent(msg.t, data.length);
  }
}

export class Room {
  // hooks: changed() when anything shown in the lobby browser changes,
  // matchStart() / matchEnd(reason) around every match for the profiler.
  constructor(id, name, bots, hooks) {
    this.id = id;
    this.name = name;
    this.hooks = hooks;
    this.players = new Map();
    this.projectiles = [];
    this.splats = [];
    // Match flow: lobby -> loading (clients load the level) -> countdown -> playing -> ended -> lobby
    this.game = { phase: 'lobby', until: 0 };
    // Lobby settings chosen by the leader.
    this.settings = { bots, botCount: Math.max(1, DEFAULT_BOTS) };
    this.profiling = false;
    prepare();
    this.botGame = {
      players: this.players, nav,
      fire: (pl, o, d) => this.fire(pl, o, d),
      throwGrenade: (pl, o, d) => this.throwGrenade(pl, o, d),
      isPlaying: () => this.game.phase === 'playing',
    };
  }

  inMatch() { return this.game.phase !== 'lobby'; }

  broadcast(msg, exceptId) {
    const data = JSON.stringify(msg);
    let n = 0;
    for (const p of this.players.values()) {
      if (p.id !== exceptId && p.ws && p.ws.readyState === p.ws.OPEN) { p.ws.send(data); n++; }
    }
    prof.sent(msg.t, data.length, n);
  }

  humans() { return [...this.players.values()].filter(p => !p.bot); }
  humanCount() { return this.humans().length; }
  botCount() { return this.players.size - this.humanCount(); }
  // The longest connected human leads the lobby.
  leaderId() { return this.humans().reduce((best, p) => (best === null || p.id < best ? p.id : best), null); }

  makePlayer(id, ws, name, color) {
    return {
      id, ws, name, color, p: this.pickSpawn(id), v: [0, 0, 0], onGround: false, yaw: 0, pitch: 0,
      hp: C.MAX_HP, alive: false, life: 0, kills: 0, deaths: 0, respawnAt: 0, lastShot: 0,
      lastDamage: 0, sentHp: C.MAX_HP, paintHits: 0, ready: false, bot: null,
      // The gun of this life, the one picked for the next, and its magazine.
      weapon: 0, nextWeapon: 0, ammo: WEAPONS[0].ammo, reloadUntil: 0, grenades: C.GRENADES_PER_LIFE,
    };
  }

  // What the lobby browser shows about this room.
  summary() {
    const leader = this.players.get(this.leaderId());
    return {
      id: this.id, name: this.name, phase: this.game.phase, leader: leader ? leader.name : '',
      players: this.humanCount(), max: MAX_PLAYERS,
      bots: this.settings.bots, botCount: this.settings.botCount,
    };
  }

  lobbyInfo() {
    return {
      t: 'lobby', name: this.name, phase: this.game.phase, leader: this.leaderId(),
      players: this.humans().map(p => ({ id: p.id, name: p.name, color: p.color })),
      settings: { ...this.settings, maxPlayers: MAX_PLAYERS },
    };
  }

  publicInfo(p) {
    return { id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths, alive: p.alive, p: p.p.map(r3), yaw: p.yaw };
  }

  roundInfo() {
    return { state: this.game.phase, remaining: Math.max(0, this.game.until - Date.now()) };
  }

  matchState() {
    return { players: [...this.players.values()].map(p => this.publicInfo(p)), splats: this.splats, round: this.roundInfo() };
  }

  scores() {
    return [...this.players.values()]
      .map(p => ({ id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }

  // Spawn point furthest from living opponents, with a bit of randomness among the best.
  pickSpawn(forId) {
    const others = [...this.players.values()].filter(p => p.alive && p.id !== forId);
    const ranked = LEVEL.spawns
      .map(s => ({ s, d: others.length ? Math.min(...others.map(o => Math.hypot(o.p[0] - s[0], o.p[2] - s[2]))) : Math.random() }))
      .sort((a, b) => b.d - a.d);
    return ranked[Math.floor(Math.random() * Math.min(3, ranked.length))].s.slice();
  }

  addSplat(sp) {
    this.splats.push(sp);
    if (this.splats.length > C.MAX_SPLATS) this.splats.splice(0, this.splats.length - C.MAX_SPLATS);
    this.broadcast({ t: 'splat', ...sp });
  }

  respawn(p) {
    p.p = this.pickSpawn(p.id);
    p.v = [0, 0, 0];
    p.hp = p.sentHp = C.MAX_HP;
    p.alive = true;
    p.paintHits = 0;
    p.life++;
    if (p.bot) p.bot.pickWeapon();
    this.arm(p, p.nextWeapon);
    if (p.bot) p.bot.onRespawn();
    this.broadcast({ t: 'respawn', id: p.id, p: p.p, life: p.life, w: p.weapon });
  }

  kill(victim, killerId) {
    victim.alive = false;
    victim.deaths++;
    victim.respawnAt = Date.now() + C.RESPAWN_TIME * 1000;
    const killer = this.players.get(killerId);
    if (killer) killer.kills++;
    if (victim.bot) victim.bot.onDeath();
    for (const p of this.players.values()) if (p.bot) p.bot.forget(victim.id);
    this.broadcast({
      t: 'kill', killer: killerId, victim: victim.id,
      kk: killer ? killer.kills : 0, vd: victim.deaths,
    });
    // Big splat of the killer's color where the victim fell.
    const [x, y, z] = victim.p;
    this.addSplat({
      id: 0, p: [r3(x), r3(groundHeight(x, z, y + 0.5)), r3(z)], a: 1, sg: 1,
      c: killer ? killer.color : victim.color, r: r3(C.SPLAT_RADIUS * 2.2), s: seed(),
    });
  }

  setPhase(phase, seconds = 0) {
    this.game.phase = phase;
    this.game.until = Date.now() + seconds * 1000;
    this.hooks.changed();
  }

  // Leader pressed start: everybody loads the level, the countdown starts once all are ready.
  startMatch() {
    this.splats = [];
    this.projectiles.length = 0;
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.ready = false; p.alive = false;
    }
    this.setPhase('loading', C.LOADING_TIMEOUT);
    this.broadcast({ t: 'start', ...this.matchState() });
    console.log(`[${this.name}] match starting with ${this.humanCount()} humans`);
  }

  beginCountdown() {
    this.setPhase('countdown', C.COUNTDOWN);
    this.maintainBots();
    this.profiling = true;
    this.hooks.matchStart();
    for (const p of this.players.values()) this.respawn(p);
    this.broadcast({ t: 'round', round: this.roundInfo() });
  }

  endProfiling(reason) {
    if (!this.profiling) return;
    this.profiling = false;
    this.hooks.matchEnd(reason);
  }

  returnToLobby() {
    this.endProfiling('back to lobby');
    this.projectiles.length = 0;
    this.setPhase('lobby');
    for (const p of [...this.players.values()]) {
      if (p.bot) this.removeBot(p);
      else { p.alive = false; p.ready = false; }
    }
    this.broadcast(this.lobbyInfo());
  }

  // The last human left: the server drops the room.
  close() {
    this.endProfiling('everybody left');
    this.players.clear();
    this.projectiles.length = 0;
  }

  // Hands a player a gun with a full magazine and their grenades.
  arm(p, w) {
    p.weapon = w;
    p.ammo = WEAPONS[w].ammo;
    p.reloadUntil = 0;
    p.grenades = C.GRENADES_PER_LIFE;
  }

  startReload(pl) {
    const gun = WEAPONS[pl.weapon];
    if (pl.reloadUntil || pl.ammo >= gun.ammo) return;
    pl.reloadUntil = Date.now() + gun.reload * 1000;
  }

  fire(pl, o, d) {
    const now = Date.now();
    if (!pl.alive || this.game.phase !== 'playing') return null;
    const gun = WEAPONS[pl.weapon];
    if (pl.reloadUntil) {
      // Clients finish their reload on their own clock, allow them to be a bit early.
      if (now < pl.reloadUntil - C.RELOAD_SLACK * 1000) return null;
      pl.reloadUntil = 0;
      pl.ammo = gun.ammo;
    }
    if (pl.ammo <= 0) return null;
    if (now - pl.lastShot < gun.interval * 1000 - 40) return null;
    pl.lastShot = now;
    if (--pl.ammo <= 0) this.startReload(pl);
    const pr = {
      id: nextProjectileId++, owner: pl.id, color: pl.color, born: now, w: pl.weapon,
      p: o.slice(), v: d.map(x => x * gun.speed),
    };
    this.projectiles.push(pr);
    this.broadcast({ t: 'shot', id: pr.id, owner: pl.id, c: pl.color, w: pr.w, o: o.map(r3), v: pr.v.map(r3) }, pl.id);
    for (const p of this.players.values()) if (p.bot) p.bot.onShot(pl, o);
    return pr;
  }

  throwGrenade(pl, o, d) {
    const now = Date.now();
    if (!pl.alive || this.game.phase !== 'playing' || pl.grenades <= 0) return null;
    pl.grenades--;
    const pr = {
      id: nextProjectileId++, owner: pl.id, color: pl.color, born: now, nade: true,
      fuseAt: now + GRENADE.fuse * 1000, p: o.slice(), v: d.map(x => x * GRENADE.speed),
    };
    this.projectiles.push(pr);
    this.broadcast({ t: 'shot', id: pr.id, owner: pl.id, c: pl.color, g: 1, o: o.map(r3), v: pr.v.map(r3) }, pl.id);
    return pr;
  }

  // Grenade burst: paints every surface in reach and hurts players it can see.
  explode(pr) {
    const now = Date.now();
    const c = pr.p;
    this.broadcast({ t: 'boom', id: pr.id, c: pr.color, p: c.map(r3) });
    const owner = this.players.get(pr.owner);
    for (const p of this.players.values()) if (p.bot && owner) p.bot.onShot(owner, c);

    // Rays spread evenly over a sphere (Fibonacci) find the surfaces around the burst.
    const n = GRENADE.rays;
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = i * 2.39996323;
      const s = [Math.cos(a) * r * GRENADE.radius, y * GRENADE.radius, Math.sin(a) * r * GRENADE.radius];
      const hit = segLevel(c, s, 0);
      if (!hit) continue;
      const q = hitPoint(c, s, hit);
      this.addSplat({
        id: 0, p: q.map(r3), a: hit.axis, sg: hit.sign, c: pr.color, nade: 1,
        r: r3(C.SPLAT_RADIUS * GRENADE.splat * (1 - 0.5 * hit.t) * (0.85 + Math.random() * 0.3)), s: seed(),
      });
    }

    for (const target of [...this.players.values()]) {
      if (target.id === pr.owner || !target.alive) continue;
      const chest = [target.p[0], target.p[1] + 1.1, target.p[2]];
      const dist = Math.hypot(chest[0] - c[0], chest[1] - c[1], chest[2] - c[2]);
      if (dist > GRENADE.radius || !lineOfSight(c, chest)) continue;
      const dmg = GRENADE.damage - (GRENADE.damage - GRENADE.minDamage) * (dist / GRENADE.radius);
      const dir = dist > 1e-3 ? chest.map((x, i) => (x - c[i]) / dist) : [0, 1, 0];
      // Paint lands on the side facing the burst.
      const off = [-dir[0] * C.PLAYER_RADIUS, 1.1 - dir[1] * 0.5, -dir[2] * C.PLAYER_RADIUS];
      this.damage(target, pr, dmg, off, dir);
    }
  }

  // Applies a paint hit to a player and tells everybody. off: where the paint landed,
  // relative to the player's feet, dir: which way it pushed (for the ragdoll).
  damage(target, pr, dmg, off, dir) {
    target.hp -= dmg;
    target.lastDamage = Date.now();
    target.sentHp = Math.max(0, target.hp);
    target.paintHits++;
    if (target.bot) target.bot.onHurt(this.players.get(pr.owner), dir);
    this.broadcast({
      t: 'hitp', id: pr.id, owner: pr.owner, target: target.id, c: pr.color, s: seed(),
      off: off.map(r3), yaw: r3(target.yaw), hp: Math.max(0, Math.ceil(target.hp)),
      dir: dir.map(r3), // for the ragdoll push
    });
    if (target.hp <= 0) this.kill(target, pr.owner);
  }

  // ---------------------------------------------------------------- Bots

  addBot() {
    const id = nextPlayerId++;
    const used = new Set([...this.players.values()].map(p => p.color));
    const free = PALETTE.map((_, i) => i).filter(i => !used.has(i));
    const color = free.length ? free[Math.floor(Math.random() * free.length)] : Math.floor(Math.random() * PALETTE.length);
    const taken = new Set([...this.players.values()].map(p => p.name));
    const names = BOT_NAMES.map(n => `Bot ${n}`).filter(n => !taken.has(n));
    const name = names.length ? names[Math.floor(Math.random() * names.length)] : `Bot ${id}`;
    const pl = this.makePlayer(id, null, name, color);
    pl.yaw = spawnYaw(pl.p);
    pl.bot = new Bot(pl, this.botGame, Math.min(1, Math.max(0, BOT_SKILL + (Math.random() - 0.5) * 0.3)));
    this.players.set(id, pl);
    this.broadcast({ t: 'join', player: this.publicInfo(pl) });
    // Bots that fill in mid-match spawn right away; at match start everyone spawns together.
    if (this.game.phase === 'playing') this.respawn(pl);
  }

  removeBot(pl) {
    this.players.delete(pl.id);
    this.broadcast({ t: 'leave', id: pl.id });
  }

  maintainBots() {
    const humans = this.humanCount();
    const bots = [...this.players.values()].filter(p => p.bot);
    const phase = this.game.phase;
    const active = phase === 'countdown' || phase === 'playing' || phase === 'ended';
    // The leader's bot count, capped so humans and bots never exceed MAX_PLAYERS:
    // a human joining a full match takes a bot's place.
    const want = humans > 0 && active && this.settings.bots ? Math.max(0, Math.min(this.settings.botCount, MAX_PLAYERS - humans)) : 0;
    for (let i = bots.length; i < want; i++) this.addBot();
    for (let i = want; i < bots.length; i++) this.removeBot(bots[i]);
  }

  // ---------------------------------------------------------------- Humans

  // Adds a human (the server checked that the room has space) and returns the player.
  // ws is anything with send(data), readyState and OPEN.
  addHuman(ws, name, color, cid, weapon) {
    const id = nextPlayerId++;
    const me = this.makePlayer(id, ws, name, color);
    me.cid = cid;
    if (Number.isInteger(weapon) && WEAPONS[weapon]) me.nextWeapon = weapon;
    this.players.set(id, me);
    const room = { id: this.id, name: this.name };
    if (this.inMatch()) {
      // Drop in to the running match.
      send(ws, { t: 'welcome', id, life: me.life, phase: this.game.phase, room, ...this.matchState() });
      this.broadcast({ t: 'join', player: this.publicInfo(me) }, id);
      if (this.game.phase === 'countdown' || this.game.phase === 'playing') this.respawn(me);
      this.maintainBots();
    } else {
      send(ws, { t: 'welcome', id, life: me.life, phase: this.game.phase, room });
    }
    this.broadcast(this.lobbyInfo());
    this.hooks.changed();
    console.log(`[${this.name}] + ${name} (#${id}) joined, ${this.humanCount()} humans here`);
    return me;
  }

  // Removes a human player and tells everybody.
  removeHuman(pl) {
    if (this.players.get(pl.id) !== pl) return; // already gone
    this.players.delete(pl.id);
    this.broadcast({ t: 'leave', id: pl.id });
    console.log(`[${this.name}] - ${pl.name} (#${pl.id}) left, ${this.humanCount()} humans here`);
    if (this.humanCount() > 0) {
      this.maintainBots();
      this.broadcast(this.lobbyInfo());
    }
    this.hooks.changed();
  }

  handle(me, m) {
    if (m.t === 'start') {
      if (this.game.phase === 'lobby' && me.id === this.leaderId()) this.startMatch();
    } else if (m.t === 'settings') {
      if (this.game.phase !== 'lobby' || me.id !== this.leaderId()) return;
      if (typeof m.bots === 'boolean') this.settings.bots = m.bots;
      if (Number.isInteger(m.botCount)) this.settings.botCount = Math.min(MAX_PLAYERS - 1, Math.max(1, m.botCount));
      this.broadcast(this.lobbyInfo());
      this.hooks.changed();
    } else if (m.t === 'ready') {
      me.ready = true;
    } else if (m.t === 's') {
      if (!me.alive || m.l !== me.life || !vec(m.p) || !Number.isFinite(m.y) || !Number.isFinite(m.x)) return;
      const lim = LEVEL.half;
      me.p = [
        Math.max(-lim, Math.min(lim, m.p[0])),
        Math.max(-5, Math.min(20, m.p[1])),
        Math.max(-lim, Math.min(lim, m.p[2])),
      ];
      me.yaw = m.y;
      me.pitch = m.x;
    } else if (m.t === 'shoot' || m.t === 'nade') {
      if (!vec(m.o) || !vec(m.d)) return;
      const len = Math.hypot(...m.d);
      if (len < 1e-6) return;
      const d = m.d.map(x => x / len);
      const eye = [me.p[0], me.p[1] + C.EYE_HEIGHT, me.p[2]];
      const o = Math.hypot(m.o[0] - eye[0], m.o[1] - eye[1], m.o[2] - eye[2]) < 3
        ? m.o.slice()
        : eye.map((e, i) => e + d[i] * C.MUZZLE_OFFSET);
      const pr = m.t === 'shoot' ? this.fire(me, o, d) : this.throwGrenade(me, o, d);
      if (pr) send(me.ws, { t: 'ack', cid: m.cid, id: pr.id });
    } else if (m.t === 'reload') {
      if (me.alive) this.startReload(me);
    } else if (m.t === 'weapon') {
      if (!Number.isInteger(m.w) || !WEAPONS[m.w]) return;
      me.nextWeapon = m.w;
      // Before the round starts you can still change your mind.
      if (this.game.phase === 'loading' || this.game.phase === 'countdown') this.arm(me, m.w);
    }
  }

  // ---------------------------------------------------------------- Simulation

  step(dt) {
    const now = Date.now();
    const game = this.game;
    const players = this.players;
    const projectiles = this.projectiles;

    if (game.phase === 'playing') {
      const t = prof.begin();
      for (const p of players.values()) if (p.bot) p.bot.update(dt);
      prof.end('bots', t);
    }
    const tp = prof.begin();

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const pr = projectiles[i];
      const { o, s, hit } = stepProjectile(pr, dt);

      if (pr.nade) {
        if (now >= pr.fuseAt) {
          projectiles.splice(i, 1);
          this.explode(pr);
        } else if (pr.p[1] < -10) projectiles.splice(i, 1);
        continue;
      }

      let ph = null;
      for (const pl of players.values()) {
        if (pl.id === pr.owner || !pl.alive) continue;
        const r = C.PLAYER_RADIUS;
        const h = segBox(o, s, [pl.p[0] - r, pl.p[1], pl.p[2] - r], [pl.p[0] + r, pl.p[1] + C.PLAYER_HEIGHT, pl.p[2] + r], C.BLOB_RADIUS);
        if (h && (!ph || h.t < ph.t)) ph = { ...h, pl };
      }

      if (ph && (!hit || ph.t <= hit.t)) {
        projectiles.splice(i, 1);
        const q = hitPoint(o, s, ph);
        const target = ph.pl;
        const speed = Math.hypot(...pr.v) || 1;
        this.damage(target, pr, WEAPONS[pr.w].damage, q.map((x, k) => x - target.p[k]), pr.v.map(x => x / speed));
      } else if (hit) {
        projectiles.splice(i, 1);
        const q = hitPoint(o, s, hit);
        this.addSplat({
          id: pr.id, p: q.map(r3), a: hit.axis, sg: hit.sign, c: pr.color,
          r: r3(C.SPLAT_RADIUS * WEAPONS[pr.w].splat * (0.85 + Math.random() * 0.3)), s: seed(),
        });
      } else if (now - pr.born > WEAPONS[pr.w].lifetime * 1000 || pr.p[1] < -10) {
        projectiles.splice(i, 1);
      }
    }

    if (game.phase !== 'playing') {
      if (game.phase === 'loading' && (this.humans().every(p => p.ready) || now >= game.until)) this.beginCountdown();
      else if (game.phase === 'countdown' && now >= game.until) {
        this.setPhase('playing', C.ROUND_TIME);
        this.broadcast({ t: 'round', round: this.roundInfo() });
      } else if (game.phase === 'ended' && now >= game.until) this.returnToLobby();
      return;
    }

    prof.end('projectiles', tp);
    prof.count('projectiles.stepped', projectiles.length);

    for (const p of players.values()) {
      if (!p.alive && now >= p.respawnAt) this.respawn(p);
      // Health regenerates after a while without damage.
      if (p.alive && p.hp < C.MAX_HP && now - p.lastDamage > C.REGEN_DELAY * 1000) {
        p.hp = Math.min(C.MAX_HP, p.hp + C.REGEN_RATE * dt);
        if (!p.bot && (p.hp - p.sentHp >= 5 || p.hp === C.MAX_HP) && p.sentHp !== p.hp) {
          p.sentHp = p.hp;
          send(p.ws, { t: 'hp', hp: Math.round(p.hp) });
        }
      }
    }

    if (now >= game.until) {
      this.setPhase('ended', C.INTERMISSION);
      projectiles.length = 0;
      this.broadcast({ t: 'round', round: this.roundInfo(), scores: this.scores() });
      this.endProfiling('match ended');
    }
  }

  // Positions of everybody alive, sent a few times per second.
  sendStates() {
    const l = [];
    for (const p of this.players.values()) {
      if (p.alive) l.push([p.id, r3(p.p[0]), r3(p.p[1]), r3(p.p[2]), r3(p.yaw), r3(p.pitch)]);
    }
    if (l.length) this.broadcast({ t: 'st', l });
  }
}
