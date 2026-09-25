// Registered players: username, password and color, kept in a local SQLite database.
// Players who don't register play as guests, as before. There is no email: a forgotten
// password is reset by an admin with the ADMIN_PASSWORD from the environment.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(crypto.scrypt);
const DB_PATH = path.resolve(process.env.DB_PATH || 'data/splatter.db');
// A reset needs this secret; below 32 characters the reset is switched off.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
export const resetEnabled = ADMIN_PASSWORD.length >= 32;

export const NAME_CHARS = /[^\p{L}\p{N} _\-.!?]/gu; // characters a name may not contain
export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const SESSION_DAYS = 180;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password TEXT NOT NULL,
    color INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,           -- sha256 of the token the browser keeps
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    used_at INTEGER NOT NULL
  );
`);
// Columns added after the first release, for databases made before them.
const columns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!columns.includes('xp')) db.exec('ALTER TABLE users ADD COLUMN xp INTEGER NOT NULL DEFAULT 0');
// Sound volume and inverted mouse look, as JSON.
if (!columns.includes('settings')) db.exec("ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
console.log(`Accounts: ${DB_PATH}, password reset ${resetEnabled ? 'on' : 'off (ADMIN_PASSWORD needs 32+ characters)'}`);

const q = {
  byName: db.prepare('SELECT * FROM users WHERE username = ?'),
  insert: db.prepare('INSERT INTO users (username, password, color, created_at) VALUES (?, ?, ?, ?)'),
  setPassword: db.prepare('UPDATE users SET password = ? WHERE id = ?'),
  setColor: db.prepare('UPDATE users SET color = ? WHERE id = ?'),
  addXp: db.prepare('UPDATE users SET xp = xp + ? WHERE id = ?'),
  setSettings: db.prepare('UPDATE users SET settings = ? WHERE id = ?'),
  xp: db.prepare('SELECT xp FROM users WHERE id = ?'),
  newSession: db.prepare('INSERT INTO sessions (token, user_id, created_at, used_at) VALUES (?, ?, ?, ?)'),
  session: db.prepare('SELECT users.*, sessions.used_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?'),
  touch: db.prepare('UPDATE sessions SET used_at = ? WHERE token = ?'),
  dropSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  dropSessionsOf: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  dropOld: db.prepare('DELETE FROM sessions WHERE used_at < ?'),
};

export class AuthError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const sha256 = s => crypto.createHash('sha256').update(s).digest();

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(pw, stored) {
  const [, salt, key] = stored.split('$');
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(got, want);
}

// Same result time whether or not the user exists, so logins don't reveal usernames.
const DUMMY = await hashPassword(crypto.randomBytes(16).toString('hex'));

// Failed logins and resets: after 10 within 15 minutes, that username (or the reset
// form) is blocked until the window passes.
const failures = new Map(); // key -> [timestamps]
const WINDOW = 15 * 60 * 1000, MAX_FAILS = 10;
function checkThrottle(key) {
  const now = Date.now();
  const list = (failures.get(key) || []).filter(t => now - t < WINDOW);
  failures.set(key, list);
  if (list.length >= MAX_FAILS) {
    const mins = Math.ceil((list[0] + WINDOW - now) / 60000);
    throw new AuthError(`Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 429);
  }
}
const failed = key => failures.get(key).push(Date.now());

function validName(raw) {
  const name = String(raw ?? '').trim();
  if (name.length < 3 || name.length > 16) throw new AuthError('Usernames are 3 to 16 characters long.');
  if (name.replace(NAME_CHARS, '') !== name) throw new AuthError('Usernames may only use letters, digits, spaces and _ - . ! ?');
  return name;
}

function validPassword(pw, confirm) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw new AuthError(`Passwords need at least ${MIN_PASSWORD} characters.`);
  if (pw.length > MAX_PASSWORD) throw new AuthError('That password is too long.');
  if (confirm !== undefined && confirm !== pw) throw new AuthError('The passwords don\'t match.');
  return pw;
}

function newSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  q.newSession.run(sha256(token).toString('hex'), user.id, now, now);
  return { token, user: publicUser(user) };
}

const readSettings = u => { try { return JSON.parse(u.settings); } catch { return {}; } };
export const publicUser = u => ({ username: u.username, color: u.color, xp: u.xp, settings: readSettings(u) });

export function isRegistered(name) {
  return !!q.byName.get(String(name).trim());
}

export async function register({ username, password, confirm, color }) {
  const name = validName(username);
  validPassword(password, confirm);
  if (q.byName.get(name)) throw new AuthError('That username is taken.', 409);
  const c = Number.isInteger(color) && color >= 0 ? color : 0;
  const hash = await hashPassword(password);
  // someone may have registered the name while hashing
  if (q.byName.get(name)) throw new AuthError('That username is taken.', 409);
  q.insert.run(name, hash, c, Date.now());
  console.log(`Account registered: ${name}`);
  return newSession(q.byName.get(name));
}

export async function login({ username, password }) {
  const name = String(username ?? '').trim();
  const key = `login:${name.toLowerCase()}`;
  checkThrottle(key);
  const user = q.byName.get(name);
  const ok = await checkPassword(String(password ?? ''), user ? user.password : DUMMY);
  if (!user || !ok) {
    failed(key);
    throw new AuthError('Wrong username or password.', 401);
  }
  return newSession(user);
}

export function logout(token) {
  if (token) q.dropSession.run(sha256(token).toString('hex'));
}

// The account a browser's token belongs to, or null.
export function userForToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const id = sha256(token).toString('hex');
  const user = q.session.get(id);
  if (!user) return null;
  const now = Date.now();
  if (now - user.used_at > SESSION_DAYS * 86400000) { q.dropSession.run(id); return null; }
  if (now - user.used_at > 3600000) q.touch.run(now, id);
  return user;
}

export function setColor(user, color) {
  q.setColor.run(color, user.id);
}

// Only known settings with sane values are kept.
export function setSettings(user, s) {
  const out = readSettings(user);
  if (Number.isFinite(s.volume)) out.volume = Math.min(1, Math.max(0, s.volume));
  if (typeof s.invertY === 'boolean') out.invertY = s.invertY;
  q.setSettings.run(JSON.stringify(out), user.id);
  return out;
}

export function getXp(userId) {
  return q.xp.get(userId)?.xp ?? 0;
}

export function addXp(userId, amount) {
  if (amount > 0) q.addXp.run(Math.round(amount), userId);
}

// Admin: sets a new password for a user and logs them out everywhere.
export async function resetPassword({ admin, username, password, confirm }) {
  if (!resetEnabled) throw new AuthError('Password reset is switched off on this server.', 403);
  checkThrottle('reset');
  const a = sha256(String(admin ?? '')), b = sha256(ADMIN_PASSWORD);
  if (!crypto.timingSafeEqual(a, b)) {
    failed('reset');
    throw new AuthError('Wrong admin password.', 401);
  }
  validPassword(password, confirm);
  const user = q.byName.get(String(username ?? '').trim());
  if (!user) throw new AuthError('There is no user with that name.', 404);
  q.setPassword.run(await hashPassword(password), user.id);
  q.dropSessionsOf.run(user.id);
  console.log(`Password reset by admin: ${user.username}`);
  return { username: user.username };
}

// Sessions nobody used for half a year go away.
setInterval(() => q.dropOld.run(Date.now() - SESSION_DAYS * 86400000), 6 * 3600000).unref();
