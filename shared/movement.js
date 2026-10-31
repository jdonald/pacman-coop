import { DX, DY, OPP, NONE } from './constants.js';

const EPS = 1e-6;

/**
 * Grid movement shared by pacs and ghosts. Tile centers are at integer
 * coordinates. An entity travels along corridors and may only change to a
 * perpendicular direction exactly at a tile center; reversing is allowed
 * anywhere.
 *
 * Entity fields: x, y (floats), dir (current direction, 0 = stopped),
 * next (desired direction), face (last non-zero direction, for rendering).
 *
 * @param e entity
 * @param dist distance to travel this step (tiles)
 * @param maze parsed maze (for wrapping)
 * @param canEnter (tx, ty) => boolean
 * @param atCenter optional (e, tx, ty) => void; called whenever the entity is
 *   at a tile center before it decides where to go (ghost AI sets e.next here)
 */
export function advance(e, dist, maze, canEnter, atCenter) {
  let guard = 0;
  while (dist > EPS && guard++ < 16) {
    if (e.next && e.dir && e.next === OPP[e.dir]) e.dir = e.next;

    let toCenter;
    if (e.dir === NONE) {
      toCenter = 0;
    } else {
      const along = DX[e.dir] !== 0 ? e.x : e.y;
      const s = DX[e.dir] + DY[e.dir];
      toCenter = s > 0 ? Math.ceil(along) - along : along - Math.floor(along);
    }

    if (toCenter < EPS) {
      // At a tile center: snap, then decide.
      e.x = Math.round(e.x);
      e.y = Math.round(e.y);
      const tx = e.x;
      const ty = e.y;
      if (atCenter) atCenter(e, tx, ty);
      if (e.next && canEnter(tx + DX[e.next], ty + DY[e.next])) e.dir = e.next;
      if (e.dir === NONE || !canEnter(tx + DX[e.dir], ty + DY[e.dir])) {
        e.dir = NONE;
        break;
      }
      toCenter = 1;
    }

    const m = Math.min(toCenter, dist);
    e.x += DX[e.dir] * m;
    e.y += DY[e.dir] * m;
    dist -= m;
    // Snap tiny floating point drift.
    const rx = Math.round(e.x);
    const ry = Math.round(e.y);
    if (Math.abs(e.x - rx) < EPS) e.x = rx;
    if (Math.abs(e.y - ry) < EPS) e.y = ry;
    // Tunnel wrap.
    if (e.x < -0.5) e.x += maze.w;
    else if (e.x >= maze.w - 0.5) e.x -= maze.w;
    if (e.dir) e.face = e.dir;
  }
}

/** Shortest horizontal delta taking tunnel wrap-around into account. */
export function wrapDelta(maze, dx) {
  if (dx > maze.w / 2) return dx - maze.w;
  if (dx < -maze.w / 2) return dx + maze.w;
  return dx;
}

export function wrappedDist(maze, ax, ay, bx, by) {
  const dx = wrapDelta(maze, bx - ax);
  const dy = by - ay;
  return Math.hypot(dx, dy);
}
