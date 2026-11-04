// Pixel-art "cutout" characters: every pixel becomes a little cube, so the
// pac and ghosts read as flat retro sprites with real thickness in the 3D view.

import * as THREE from 'three';

/**
 * Build one merged geometry from a pixel grid.
 * @param rows array of equal-length strings; '.' or ' ' = empty
 * @param colors map of char -> CSS color
 * @param px world size of one pixel
 * @param depth thickness (world units)
 * @param z0 front-face offset along +z (lets overlays sit on the front face)
 */
export function voxelGeometry(rows, colors, px, depth, z0 = 0) {
  const h = rows.length;
  const w = rows[0].length;
  const filled = (x, y) => x >= 0 && y >= 0 && x < w && y < h && !'. '.includes(rows[y][x]);
  const pos = [];
  const nor = [];
  const col = [];
  const cache = {};
  const colorOf = (ch) => (cache[ch] ??= new THREE.Color(colors[ch] || '#ff00ff'));
  const zf = z0 + depth / 2;
  const zb = z0 - depth / 2;
  const quad = (a, b, c, d, n, k) => {
    for (const v of [a, b, c, a, c, d]) {
      pos.push(v[0], v[1], v[2]);
      nor.push(n[0], n[1], n[2]);
      col.push(k.r, k.g, k.b);
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!filled(x, y)) continue;
      const k = colorOf(rows[y][x]);
      // Sprite is centered on x, with row 0 at the top.
      const x0 = (x - w / 2) * px;
      const x1 = x0 + px;
      const y1 = (h / 2 - y) * px;
      const y0 = y1 - px;
      quad([x0, y0, zf], [x1, y0, zf], [x1, y1, zf], [x0, y1, zf], [0, 0, 1], k);
      quad([x1, y0, zb], [x0, y0, zb], [x0, y1, zb], [x1, y1, zb], [0, 0, -1], k);
      const ks = k.clone().multiplyScalar(0.72); // darker edges add depth
      if (!filled(x, y - 1)) quad([x0, y1, zf], [x1, y1, zf], [x1, y1, zb], [x0, y1, zb], [0, 1, 0], ks);
      if (!filled(x, y + 1)) quad([x0, y0, zb], [x1, y0, zb], [x1, y0, zf], [x0, y0, zf], [0, -1, 0], ks);
      if (!filled(x + 1, y)) quad([x1, y0, zf], [x1, y0, zb], [x1, y1, zb], [x1, y1, zf], [1, 0, 0], ks);
      if (!filled(x - 1, y)) quad([x0, y0, zb], [x0, y0, zf], [x0, y1, zf], [x0, y1, zb], [-1, 0, 0], ks);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

// ----------------------------------------------------------------- the pac

const PW = 16;
const PH = 20;
const PCX = 8;
const PCY = 12.5;
const PR = 7;

/** Pac pixel grid facing right; mouth = full opening angle in radians. */
function pacRows(mouth, hat) {
  const g = [];
  for (let y = 0; y < PH; y++) {
    let row = '';
    for (let x = 0; x < PW; x++) {
      const dx = x + 0.5 - PCX;
      const dy = y + 0.5 - PCY;
      const d = Math.hypot(dx, dy);
      const a = Math.abs(Math.atan2(-dy, dx));
      const inMouth = mouth > 0 && a < mouth / 2 && d > 0.6;
      row += d <= PR && !inMouth ? 'B' : '.';
    }
    g.push(row.split(''));
  }
  const art = HAT_ART[hat];
  if (art) {
    art.rows.forEach((r, j) => {
      [...r].forEach((ch, i) => {
        const x = art.x + i;
        const y = art.y + j;
        if (ch !== '.' && x < PW && y < PH) g[y][x] = ch;
      });
    });
  }
  return g.map((r) => r.join(''));
}

const HAT_ART = {
  bow: {
    x: 1, y: 3,
    rows: ['RR...RR', 'RRR.RRR', 'RRRDRRR', 'RRR.RRR', 'RR...RR'],
  },
  cap: {
    x: 2, y: 3,
    rows: ['...CCCCCC...', '..CCCCCCCC..', '.CCCCCCCCCCCC', '.WWWWWWWW...'],
  },
  crown: {
    x: 4, y: 1,
    rows: ['G..G..G', 'G.GGG.G', 'GGGGGGG', 'GRGGGRG', 'GGGGGGG'],
  },
  tophat: {
    x: 3, y: 0,
    rows: ['..KKKKK..', '..KKKKK..', '..KKKKK..', '..KKKKK..', '..RRRRR..', 'KKKKKKKKK'],
  },
  shades: {
    x: 5, y: 8,
    rows: ['KKKKKKKKKK', '...KKKK.KK', '....KK....'],
  },
  propeller: {
    x: 3, y: 0,
    rows: ['TTTTSPPPP', '....S....', '..RRYYBB.', '.RRRYYBBB', 'RRRRYYBBBB'],
  },
};

const HAT_COLORS = {
  R: '#ff2d55', D: '#b0123a', C: '#2f6bff', W: '#1c3fae', G: '#ffcc22', K: '#16161c',
  T: '#ff4d4d', P: '#3a7bff', S: '#888888', Y: '#ffd60a', B: '#2ecc71',
};

export const CHOMP_ANGLES = [0.0, 0.55, 1.15, 0.55]; // cycle: closed, half, open, half
export const DEATH_FRAMES = 10;

const pacCache = new Map();

/**
 * Returns { chomp: Geometry[], death: Geometry[] } for a body color + hat.
 * Geometries are shared between players with the same look.
 */
export function pacGeometries(color, hat) {
  const key = `${color}/${hat}`;
  if (pacCache.has(key)) return pacCache.get(key);
  const colors = { ...HAT_COLORS, B: color };
  const px = 0.066;
  const depth = 0.46; // thick like a pie
  const uniq = [...new Set(CHOMP_ANGLES)];
  const byAngle = new Map(uniq.map((a) => [a, voxelGeometry(pacRows(a, hat), colors, px, depth)]));
  const chomp = CHOMP_ANGLES.map((a) => byAngle.get(a));
  const death = [];
  for (let i = 0; i < DEATH_FRAMES; i++) {
    const a = 1.2 + (i / (DEATH_FRAMES - 1)) * (Math.PI * 2 - 1.2);
    death.push(voxelGeometry(pacRows(a, 'none'), colors, px, depth));
  }
  const out = { chomp, death };
  pacCache.set(key, out);
  return out;
}

// --------------------------------------------------------------- the ghost

const GHOST_BODY = [
  '.....####.....',
  '...########...',
  '..##########..',
  '.############.',
  '.############.',
  '.############.',
  '##############',
  '##############',
  '##############',
  '##############',
  '##############',
  '##############',
];
const SKIRT_A = ['##.###..###.##', '#...##..##...#'];
const SKIRT_B = ['#.####..####.#', '...##....##...'];

const GPX = 0.072;
const GDEPTH = 0.44;

function blank() {
  return Array.from({ length: 14 }, () => Array(14).fill('.'));
}

/** Eye whites + pupils looking in a direction (1 up, 2 right, 3 down, 4 left). */
function eyeRows(dir) {
  const g = blank();
  const ox = dir === 2 ? 1 : dir === 4 ? -1 : 0;
  const oy = dir === 1 ? -1 : dir === 3 ? 1 : 0;
  const white = ['.WW.', 'WWWW', 'WWWW', 'WWWW', '.WW.'];
  const pupil = { 1: [1, 0], 2: [2, 2], 3: [1, 3], 4: [0, 2], 0: [1, 2] }[dir] || [1, 2];
  for (const ex of [2, 8]) {
    white.forEach((r, j) =>
      [...r].forEach((ch, i) => {
        if (ch === 'W') g[3 + oy + j][ex + ox + i] = 'W';
      }),
    );
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) g[3 + oy + pupil[1] + j][ex + ox + pupil[0] + i] = 'P';
  }
  return g.map((r) => r.join(''));
}

const SCARED = [
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
  '....##..##....',
  '....##..##....',
  '..............',
  '..............',
  '..##..##..##..',
  '.#..##..##..#.',
  '..............',
  '..............',
  '..............',
];

let ghostGeos = null;
export function ghostGeometries() {
  if (ghostGeos) return ghostGeos;
  const white = { '#': '#ffffff' };
  const body = [SKIRT_A, SKIRT_B].map((sk) => voxelGeometry([...GHOST_BODY, ...sk], white, GPX, GDEPTH));
  const front = GDEPTH / 2 + GPX * 0.25;
  const eyes = [0, 1, 2, 3, 4].map((d) =>
    voxelGeometry(eyeRows(d), { W: '#ffffff', P: '#2233dd' }, GPX, GPX * 0.5, front),
  );
  const scared = voxelGeometry(SCARED, white, GPX, GPX * 0.5, front);
  ghostGeos = { body, eyes, scared };
  return ghostGeos;
}
