# Splatter

A multiplayer first-person paint shooter in the browser. The whole arena and every player
is pure white, so you see nothing at first. Shoot paint blobs to reveal the level: paint
only shows up where it hits geometry, and it sticks to the players it hits.

Free for all: 4 hits splat a player, they respawn after 3 seconds, and whoever has the
most kills after 5 minutes wins. Health regenerates after a few seconds without being hit;
the screen edges turn red while you are hurt.

Paint looks wet: splats on walls and floors are rendered the same way, lit from the
paint's thickness with a glossy highlight. Paint in the air (shots in flight and the
droplets every impact throws off) is rendered as screen space metaballs
(`public/js/fluid.js`), the technique from Mix and Jam's
[Splatoon ink recreation](https://github.com/mixandjam/Splatoon-Ink): droplets add up
their density in an offscreen buffer, so nearby drops merge into gooey liquid, which a
final pass thresholds and shades. Paint on walls
runs down: a GPU simulation (`public/js/paintflow.js`) treats every
fresh wall splat as a thin film of paint at about 1 cm resolution. The blob sags, paint
breaks out onto the dry wall at a few spots and runs down in drips, and drips that reach
the floor leave small puddles. Thick paint runs, thin films barely move, so drips end in
rounded tips. Paint edges are drawn from a coverage mask with a shader, so they stay smooth
up close. Walking
through paint on the ground loads your shoes with it, and the next steps leave colored
footprints that fade after a while. That also works for invisible players, so their trail
gives them away.

## Guns

Pick a gun with **1** to **4**. It is yours from your next spawn until you are splatted
(before the round starts it switches right away). Every gun holds a magazine: **R** reloads,
an empty magazine reloads by itself, and there is no limit on reloads.

| Gun | Rounds | Fire | Range | Hits to splat |
|---|---|---|---|---|
| Color gun | 30 | hold | far, in an arc | 4 |
| Pistol | 10 | one shot per click | short (about 17 m) | 4 |
| Rifle | 30 | hold, fast | middle (about 48 m) | 5 |
| Sniper | 3 | one shot per click | whole arena, straight | 1 |

Everyone also carries one **color grenade** per life, thrown when you release **Q**. It bounces, bursts
after 1.6 seconds, paints every surface around it and hurts players within 13.5 m that it
can see (more the closer they are). Guns and the grenade are defined in `WEAPONS` and
`GRENADE` in `shared/game.js`.

## Match flow

1. Play as a **Guest** (pick a name and a paint color), or **Log in** / **Register**
   (see [Accounts](#accounts)), then **Find a game**.
2. The lobby browser lists every open lobby with its name, how many of the 10 player slots
   are taken, whether bots are on and whether a match is running. Join one, or create your
   own lobby and give it a name. Every lobby plays its own match, so several groups can
   play at the same time, each with their own bots.
3. The lobby shows everyone who joined as a 3D model in their color with their name above
   their head. The player who created the lobby leads it (crown) and gets the **Start match**
   button. If the leader leaves, the next player takes over. **Leave** (in the lobby or
   from the Esc menu in a match) takes you back to the lobby browser, and a lobby closes
   once its last player has left.
4. On start, every client loads the arena. Once all are ready (or after 12 seconds), bots fill
   the empty slots and a 5 second countdown runs in the arena before the round starts.
5. After the round the results show for 10 seconds, then everyone returns to the lobby.
   Players who join a lobby while its match runs drop straight into it.

With `?debug` in the URL, the **Animation viewer** button in the lobby opens a debug scene with the player model
looping every animation and the in-game combinations (gun pose, strafing, aiming).

## Accounts

Guests pick any name that no registered player owns. Registering takes a username
(3 to 16 characters), a password (8 or more) and the password again; there is no email.
Registered players always play under their username. After logging in they get a main
menu: their character dances one of the lobby loops (a new one each time) in front of a wall that paint shots keep splatting, with the
name at the top left, a logout button at the top right and **Find a game** and the colors
at the bottom. The character takes on the picked color right away, and the color is saved
with the account (`public/js/home.js`). The gear next to the logout button opens the
settings (sound volume, inverted mouse look); like the Esc menu in a match, changes are
saved with the account and applied again at the next login. The browser stays logged in
(for 180 days without playing), and logging in from another browser replaces the older
connection. After 10 wrong passwords for a username within 15 minutes, logins for it
pause until the 15 minutes are over.

Forgotten passwords: under **Log in > Forgot your password?** an admin enters the
`ADMIN_PASSWORD` from the server's environment, the username and a new password. That
also logs the player out everywhere. The reset only works when `ADMIN_PASSWORD` has at
least 32 characters (for example `openssl rand -base64 48`).

Accounts live in a SQLite database (`node:sqlite`, built into Node 22.5+) at `DB_PATH`
(default `data/splatter.db`; `docker compose` keeps it in `./data`). Passwords are hashed
with scrypt, and the server only keeps a hash of each login token.

## Experience and levels

Registered players earn experience (XP) and level up, modeled on Call of Duty: Modern
Warfare (2019); guests earn none. As in Modern Warfare, the score a player makes during a
match is XP, medals add to it, and a match bonus comes at the end:

| Event | XP |
| --- | --- |
| Splat | 100 |
| Assist (hit the player within 10 s before someone else splatted them) | 25 |
| First Blood, Revenge, Headshot (hit on the top of the body), Longshot (30 m or more) | +50 each |
| Double Splat / Triple Splat / Multi Splat (splats within 4 s of each other) | +50 / +100 / +150 |
| Splat streak (every 5 splats without being splatted) | +100 |
| Match bonus (only for players still there at the end) | 3 per second played, x1.5 for the top 3 |

XP is saved to the account as it is earned, so leaving early keeps what was earned but not
the match bonus. Levels 1 to 55 (like Modern Warfare's enlisted ranks) cost a bit more each:
800 XP for level 2 and 130 more for every level after it, about 229,000 XP in total, roughly
90 matches. Levels 56 to 155 (like the officer / season levels) cost 8,000 XP each. Numbers
and formulas are in `shared/progression.js`.

In a match, earned XP pops up under the crosshair, the results show the XP of the match and
any level up. In the lobby, registered players show their level and rank insignia; the main
menu shows the insignia, the level and a bar with the XP to the next level. The 16 insignia
(one per 5 enlisted levels, one per 20 officer levels) were made with OpenArt
(`assets/ranks-sheet.png`, cut into `public/ranks/`).

## Run

```sh
docker compose up --build
```

Then open http://localhost:3000. Friends on your network (or the internet, if you forward
the port) connect to `http://<your-host>:3000`. Put it behind a TLS proxy to serve it as
`https://`; the client switches to `wss://` automatically.

For development without rebuilding the image:

```sh
docker run --rm -v "$PWD":/app -w /app node:22-alpine npm install
docker run --rm -it -p 3000:3000 -v "$PWD":/app -w /app node:22-alpine node server.js
```

## Bots

A match holds up to 10 players. Whoever creates a lobby chooses whether it has bots, and
the lobby leader can change that and how many join (1 to 9). Bots never push the total over 10: a player who joins a full match takes a bot's
place, and the bot comes back when that player leaves. `BOTS` in `docker-compose.yml` sets
the default bot count of a new lobby, `BOT_SKILL` (0 to 1, default 0.4) makes them weaker
or stronger.

Bots follow the same visibility rules as you do:

- **Sight:** 110 degree field of view and line of sight through the level. An unpainted player
  is close to invisible to them. Paint on a player, firing a shot and being very close all
  make that player much easier to spot. Once spotted, a player is easier to keep tracking.
- **Hearing:** they hear shots within about 30m, but only get a rough position.
- **Getting hit:** they estimate where the shot came from, not who fired it or from exactly where.
- **Memory:** what they perceived fades after about 9 seconds.

Their decisions come from an HTN planner (`bots/htn.js`, domain in `bots/brain.js`). The
root task `Live` has prioritized methods: **retreat** to cover when low on health, **engage**
a visible enemy, **counter** after being hit by paint them spray towards the attacker,
**investigate** a heard or lost enemy by painting the spot or walking closer, and
**patrol** by painting the surroundings or wandering. When a higher priority method becomes
possible, the running plan is dropped and a new one is made. Each primitive task runs as a
small behavior (move along a path, aim, fire a burst, look around).

Bots are deliberately imperfect: reaction delay, limited turn speed, aim spread, misjudged
range, partial target leading, short bursts and a slower fire rate than humans. Paths come
from a navigation graph that is generated at startup by simulating real player movement
between grid cells (`bots/nav.js`).

Run with `BOT_DEBUG=1` to log every plan the bots make.

## Profiling the server

Set `PROFILE: "1"` in `docker-compose.yml` (and rebuild) to profile the server. While a
match runs it logs a line every 5 s (`docker compose logs -f`), and after every match it
writes a report to `./profiles/`. Every lobby thread profiles itself (log lines and
report files are tagged `t1`, `t2`, ...), and a report covers that thread from the first of
its matches starting until none of them runs any more: tick times against the 16.7 ms budget, time per code
section (bots split into perception, planning, cover search, pathfinding, behaviors,
movement), counters, network traffic per message type, event loop delay, GC, memory and
the slowest ticks. `PROFILE_CPU: "1"` also records a `.cpuprofile` per match, which opens
in the Performance tab of Chrome DevTools.

To profile the browser too, open the game with `?profile` (for example
`http://localhost:3000/?profile`). A small panel shows FPS, frame times, the work done per
frame by section, long tasks, the largest gap between the server's position updates
(they should arrive every 50 ms, so large gaps mean the server or network stalled while
the browser kept up) and paint, droplet and renderer stats. At the end of a match the
report is uploaded and saved in `./profiles/` as `browser-<time>-<name>.txt` next to the
server's reports (when the server runs with `PROFILE: "1"`), and recording starts over.
The "Download report" button saves everything recorded since then (usually the current
match so far) as a text file. Both reports use UTC times, so spikes on one side can be
matched with the other.

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows | Move |
| Space | Jump |
| C (hold) | Crouch: smaller, slower and quieter, behind low cover bots can't see you. You stand up once there is room |
| Mouse | Aim |
| Left click (hold) | Shoot |
| Tab (hold) | Stats (also shown while waiting to respawn) |
| Esc | Menu with sound volume and an option to invert the mouse Y axis (the match keeps running) |

## How it works

- `server.js` serves the static files, holds every WebSocket (`ws`) connection and the
  list of lobbies, and forwards messages between players and their lobby.
- Lobbies run in worker threads (`room-worker.js`), so several matches use several CPUs.
  By default there is one thread per CPU minus one (the main thread handles the network);
  `WORKERS` sets a fixed number. A new lobby goes to the thread with the fewest lobbies,
  and each thread advances its lobbies at 60 Hz.
- `accounts.js` keeps the registered players (SQLite) and serves the `/api/...` endpoints
  for registering, logging in and out and the admin password reset.
- `room.js` is one lobby and its authoritative match: it simulates every paint blob against
  the level and the players, applies damage, handles kills, respawns, rounds and bots, and
  keeps a list of splats for players who join late.
- `shared/game.js` holds the config, the level (axis-aligned boxes), the player movement and
  the projectile physics. Server and browser both import it.
- `public/client.js` renders with Three.js. Every visible box face is a quad with its own
  paint textures that start white. Splats are painted onto the textures of every face they
  touch, so they wrap over edges. Everything uses unlit materials, so an unpainted surface
  looks exactly like the white background.
- All paint lives on the GPU: splats are drawn straight into the surfaces' render targets
  (`public/js/surfaces.js`), and the paint running down walls is simulated for all splats at
  once in a shared texture, one draw call per step (`public/js/paintflow.js`). Settled paint
  is baked into the surfaces on the GPU as well; nothing is read back or uploaded per splat.
  Footprints look up the ground color in a small grid kept on the CPU.

## Player model and animations

`assets/character.blend` holds the player model, its skeleton, the gun and all actions. It
exports to `public/models/player.glb` (model, 5 actions) and `public/models/gun.glb`.

The animations are motion capture from the CMU Graphics Lab Motion Capture Database
(BVH conversion by Bruce Hahne), retargeted onto one skeleton and cleaned up to loop in place:

| Action | CMU clip | Frames (30 fps) |
| --- | --- | --- |
| idle | 82_08 (stand still) | 99 to 163 |
| run | 35_17 (run/jog) | 14 to 37 |
| jump | 13_39 (jump) | 37 to 69 |
| aim | posed with IK in Blender | two-handed gun hold |

Silly lobby loops (each player in the lobby loops one of them, the animation viewer shows all):

| Action | CMU clip | Frames (30 fps) |
| --- | --- | --- |
| fun_hop | 49_02 (jump up and down, hop on one foot) | 41 to 86 |
| fun_chickendance | 19_15 (chicken dance) | 273 to 318 |
| fun_elephant | 29_20 (elephant) | 489 to 544 |
| fun_stretch | 42_01 (stretch) | 89 to 134 |
| fun_boxing | 79_08 (boxing) | 27 to 108 |
| fun_drums | 79_18 (playing drums) | 89 to 140 |
| fun_monkey | 28_15 (monkey) | 555 to 616 |
| fun_lambada | 55_02 (lambada dance) | 3 to 48 |
| fun_jumpingjacks | 22_16 (synchronized jumping jacks) | 3 to 70 |
| fun_dancingbear | 55_12 (dancing bear) | 345 to 406 |

A splatted player goes limp as a ragdoll (`public/js/ragdoll.js`): a Verlet particle
skeleton that falls under gravity, collides with the level and gets pushed where the fatal
shot hit; the bones of the model follow it.

In game the legs and torso play the mocap while the arms are held in the aim pose, the legs
turn towards the direction of travel and the spine turns and bends towards where the
player aims. Running backwards plays the run clip in reverse.

The crouch clips are not mocap: `assets/crouch_anims.py` builds them in Blender on top of
the idle pose. The hips drop and lean forward, the head stays level and IK places the feet:
planted for `crouch_idle`, a stepping cycle in place for `crouch_walk` (1.6 m/s, sped up to
the crouch speed in game, like the run clip). The script's header explains how to rerun it
and export the model.

The data used in this project was obtained from mocap.cs.cmu.edu. The database was created
with funding from NSF EIA-0196217.

Open `http://localhost:3000/?debug` to render players in visible colors during development.

Tune gameplay (speed, damage, round length, splat size) in `CONFIG` in `shared/game.js`.
Change the arena by editing the `block(...)`, `stairs(...)` calls and `spawns` there.
