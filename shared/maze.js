import { MAZE_HALVES } from './mazeData.js';
import { PATH, WALL, DOOR, HOUSE, PELLET, POWER, DX, DY } from './constants.js';

export const MAZE_COUNT = MAZE_HALVES.length;

const cache = new Map();

/** Returns the parsed (immutable) maze for an index; cached. */
export function getMaze(index) {
  index = ((index % MAZE_COUNT) + MAZE_COUNT) % MAZE_COUNT;
  if (!cache.has(index)) cache.set(index, parseMaze(MAZE_HALVES[index], index));
  return cache.get(index);
}

/** Maze index used for a given level number (1-based). */
export function mazeForLevel(level) {
  return (level - 1) % MAZE_COUNT;
}

function parseMaze(def, index) {
  const rows = def.rows.map((h) => h + [...h].reverse().join(''));
  const h = rows.length;
  const w = rows[0].length;
  const cells = new Uint8Array(w * h);
  const pellets = new Uint8Array(w * h);
  const spawns = [];
  const doors = [];
  const house = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      const i = y * w + x;
      switch (ch) {
        case '#':
          cells[i] = WALL;
          break;
        case '-':
          cells[i] = DOOR;
          doors.push([x, y]);
          break;
        case 'H':
          cells[i] = HOUSE;
          house.push([x, y]);
          break;
        case '.':
          pellets[i] = PELLET;
          break;
        case 'o':
          pellets[i] = POWER;
          break;
        case 'P':
          spawns.push([x, y]);
          break;
        default:
          break;
      }
    }
  }
  // Ghost house geometry: door tiles sit on top of the house.
  const doorY = doors[0][1];
  const doorX = Math.min(...doors.map((d) => d[0]));
  const houseYs = house.map((c) => c[1]);
  const houseMidY = Math.round((Math.min(...houseYs) + Math.max(...houseYs)) / 2);
  const exit = [doorX, doorY - 1];
  const home = [doorX, houseMidY];
  // Where each of the 4 ghosts waits; ghost 0 starts outside on the exit tile.
  const ghostStarts = [
    [doorX, doorY - 1],
    [doorX, houseMidY],
    [doorX - 2, houseMidY],
    [doorX + 3, houseMidY],
  ];

  const maze = {
    index,
    name: def.name,
    w,
    h,
    cells,
    initialPellets: pellets,
    spawns,
    doors,
    exit,
    home,
    ghostStarts,
    scatter: [
      [w - 3, -3],
      [2, -3],
      [w - 1, h + 1],
      [0, h + 1],
    ],
    pelletCount: pellets.reduce((n, p) => n + (p ? 1 : 0), 0),
  };
  maze.distToExit = bfs(maze, exit);
  maze.distToHome = bfs(maze, home);
  return maze;
}

export function wrapX(maze, x) {
  return ((x % maze.w) + maze.w) % maze.w;
}

export function cellAt(maze, x, y) {
  if (y < 0 || y >= maze.h) return WALL;
  return maze.cells[y * maze.w + wrapX(maze, x)];
}

export function isTunnel(maze, x, y) {
  const tx = wrapX(maze, Math.round(x));
  if (tx > 4 && tx < maze.w - 5) return false;
  const ty = Math.round(y);
  return cellAt(maze, 0, ty) === PATH;
}

/** Passability for pacs. */
export function pacCanEnter(maze, x, y) {
  return cellAt(maze, x, y) === PATH;
}

/** Passability for ghosts, which may use the house when leaving / returning. */
export function ghostCanEnter(maze, x, y, allowHouse) {
  const c = cellAt(maze, x, y);
  if (c === PATH) return true;
  return allowHouse && (c === DOOR || c === HOUSE);
}

function bfs(maze, [sx, sy]) {
  const dist = new Int16Array(maze.w * maze.h).fill(-1);
  dist[sy * maze.w + sx] = 0;
  const q = [[sx, sy]];
  for (let qi = 0; qi < q.length; qi++) {
    const [x, y] = q[qi];
    const d = dist[y * maze.w + x];
    for (let dir = 1; dir <= 4; dir++) {
      const nx = wrapX(maze, x + DX[dir]);
      const ny = y + DY[dir];
      if (!ghostCanEnter(maze, nx, ny, true)) continue;
      const ni = ny * maze.w + nx;
      if (dist[ni] !== -1) continue;
      dist[ni] = d + 1;
      q.push([nx, ny]);
    }
  }
  return dist;
}

export function pelletsToString(p) {
  let s = '';
  for (let i = 0; i < p.length; i++) s += p[i];
  return s;
}

export function pelletsFromString(s) {
  const p = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) p[i] = s.charCodeAt(i) - 48;
  return p;
}

export { PELLET, POWER };
