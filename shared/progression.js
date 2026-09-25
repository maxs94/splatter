// Experience and levels, modeled on Call of Duty: Modern Warfare (2019). Server and
// browser both use it.
//
// Levels 1-55 ("enlisted") cost a bit more XP each (800 for level 2, +130 per level),
// then levels 56-155 ("officer", like MW's seasonal levels) cost a flat 8000 each.
// A 5 minute match earns roughly 1500-3000 XP, so level 55 takes about 90 matches.

export const ENLISTED_MAX = 55;
export const MAX_LEVEL = 155;
const OFFICER_STEP = 8000;

// XP needed to get from `level` to the next one.
export function xpToNext(level) {
  if (level >= MAX_LEVEL) return 0;
  return level < ENLISTED_MAX ? 800 + 130 * (level - 1) : OFFICER_STEP;
}

// Level for a total XP: { level, into (XP since this level), need (XP this level costs), toNext }.
export function levelInfo(xp) {
  let level = 1, rest = Math.max(0, Math.floor(xp || 0));
  while (level < MAX_LEVEL && rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level++;
  }
  const need = xpToNext(level);
  return { level, into: need ? rest : 0, need, toNext: need ? need - rest : 0 };
}

// XP awards (see room.js for when they are given).
export const XP = {
  SPLAT: 100,
  ASSIST: 25,          // hit the victim in the last ASSIST_WINDOW seconds
  FIRST_BLOOD: 50,
  REVENGE: 50,
  HEADSHOT: 50,
  LONGSHOT: 50,        // from LONGSHOT_DISTANCE or further
  DOUBLE: 50,          // two splats, each within MULTI_WINDOW seconds of the last
  TRIPLE: 100,
  MULTI: 150,          // four or more
  STREAK: 100,         // every 5 splats without being splatted
  MATCH_PER_SECOND: 3, // match bonus for the time played, when the match ends
  TOP3_FACTOR: 1.5,    // match bonus for finishing in the top 3 (a win in free for all)
};
export const ASSIST_WINDOW = 10;
export const MULTI_WINDOW = 4;
export const LONGSHOT_DISTANCE = 30;

// Rank insignia (public/ranks/1.png ... 16.png, made with OpenArt): one per 5 enlisted
// levels (1-5 ... 51-55), then one per 20 officer levels (56-75 ... 136-155).
export function rankIcon(level) {
  const tier = level <= ENLISTED_MAX
    ? Math.ceil(level / 5)
    : 11 + Math.ceil((Math.min(level, MAX_LEVEL) - ENLISTED_MAX) / 20);
  return `/ranks/${Math.max(1, tier)}.png`;
}
