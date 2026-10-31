// Shared tuning constants used by both the authoritative server and the client
// (client-side prediction must use exactly the same movement rules).

export const TICK_RATE = 60; // simulation steps per second
export const TICK_DT = 1 / TICK_RATE;
export const SNAPSHOT_EVERY = 2; // server broadcasts a snapshot every N ticks (30 Hz)
export const INPUT_EVERY = 2; // client sends its position every N ticks (30 Hz)
export const MAX_PLAYERS = 4;

// Directions: 0 = none, 1 = up, 2 = right, 3 = down, 4 = left
export const NONE = 0;
export const UP = 1;
export const RIGHT = 2;
export const DOWN = 3;
export const LEFT = 4;
export const DX = [0, 0, 1, 0, -1];
export const DY = [0, -1, 0, 1, 0];
export const OPP = [0, 3, 4, 1, 2];

// Cell types
export const PATH = 0;
export const WALL = 1;
export const DOOR = 2;
export const HOUSE = 3;

// Pellet types
export const PELLET = 1;
export const POWER = 2;

export const POINTS = { pellet: 10, power: 50, ghost: [200, 400, 800, 1600], clear: 500 };

// Seconds of "READY!" before a level starts: the first level waits for the
// full intro tune, later levels only for a short sting.
export function readyTime(level) {
  return level === 1 ? 4.5 : 2.2;
}
export const CLEAR_TIME = 2.6; // seconds of celebration after clearing a level
export const RESPAWN_TIME = 2.2; // seconds a player stays dead (infinite lives!)
export const INVULN_TIME = 2.5; // seconds of blinking invulnerability after (re)spawn

// Speeds are in tiles per second.
export function pacSpeed(level) {
  return Math.min(9.4, 7.6 + (level - 1) * 0.3);
}
export function ghostSpeed(level) {
  return Math.min(9.1, 7.0 + (level - 1) * 0.35);
}
export const GHOST_FRIGHT_SPEED = 4.6;
export const GHOST_TUNNEL_SPEED = 4.2;
export const GHOST_EYES_SPEED = 15;
export const GHOST_HOUSE_SPEED = 3.5;

export function frightDuration(level) {
  return Math.max(2.5, 8 - (level - 1) * 0.75);
}
export const FRIGHT_FLASH_TIME = 2.0;

// Alternating scatter / chase phases, in seconds (last chase lasts forever).
export const MODE_SCHEDULE = [7, 20, 7, 20, 5, 20, 5, Infinity];

// Ghosts in the house are released after these many seconds into a level.
export function ghostReleaseDelays(level) {
  const s = Math.max(0.4, 1 - (level - 1) * 0.15);
  return [0, 1.5 * s, 5 * s, 9 * s];
}

export const GHOST_NAMES = ['Blaze', 'Rosie', 'Splash', 'Tango'];
export const GHOST_COLORS = ['#ff3b4e', '#ff9ad5', '#3bf0ff', '#ffb547'];

// Collision radius (tile units) between a pac and a ghost.
export const HIT_DIST = 0.6;
