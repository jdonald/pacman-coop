// Authoritative game room. Transport-agnostic: used by the Node server and by
// the browser for offline solo play. Each player is attached with a `send`
// callback that receives plain JSON-able objects.
//
// Netcode model:
//  * Ghosts, pellets, level flow and scores are simulated here (authoritative).
//  * Each client predicts its OWN pac locally (zero input lag) and streams its
//    position + pellets eaten. The room validates speed/walls/pellet distance
//    and sends a correction if a client is out of bounds.
//  * Collisions between a pac and ghosts are detected by that pac's client
//    against the ghosts it actually sees ("what you see is what you get"), and
//    validated here with a lag tolerance. In a co-op game this is the fairest
//    trade-off: nobody dies to a ghost that wasn't on their screen.

import {
  TICK_DT, SNAPSHOT_EVERY, MAX_PLAYERS, NONE, UP, LEFT, DX, DY, OPP, POINTS,
  readyTime, CLEAR_TIME, RESPAWN_TIME, INVULN_TIME, pacSpeed, ghostSpeed,
  GHOST_FRIGHT_SPEED, GHOST_TUNNEL_SPEED, GHOST_EYES_SPEED, GHOST_HOUSE_SPEED,
  frightDuration, MODE_SCHEDULE, ghostReleaseDelays, PELLET, POWER,
} from './constants.js';
import {
  getMaze, mazeForLevel, pacCanEnter, ghostCanEnter, isTunnel, wrapX, pelletsToString,
} from './maze.js';
import { advance, wrappedDist, wrapDelta } from './movement.js';
import { sanitizeProfile, SKIN_COLORS } from './profile.js';

// Ghost modes
export const G_HOUSE = 0;
export const G_LEAVE = 1;
export const G_ACTIVE = 2;
export const G_FRIGHT = 3; // only used in snapshots (active + frightened)
export const G_EATEN = 4;

const r2 = (v) => Math.round(v * 100) / 100;

export class Room {
  constructor({ code, isPublic = false, rand = Math.random } = {}) {
    this.code = code;
    this.isPublic = isPublic;
    this.rand = rand;
    this.players = new Map();
    this.time = 0; // simulation clock in seconds
    this.tickCount = 0;
    this.teamScore = 0;
    this.startLevel(1);
  }

  get size() {
    return this.players.size;
  }

  get full() {
    return this.players.size >= MAX_PLAYERS;
  }

  // ---------------------------------------------------------------- levels

  startLevel(level) {
    this.level = level;
    this.maze = getMaze(mazeForLevel(level));
    this.pellets = new Uint8Array(this.maze.initialPellets);
    this.pelletsLeft = this.maze.pelletCount;
    this.phase = 'ready';
    this.phaseEnd = this.time + readyTime(level);
    this.levelTime = 0; // time spent in 'play'
    this.modeIndex = 0;
    this.modeTime = 0;
    this.frightLeft = 0;
    this.frightCombo = 0;
    this.frightEndedAt = -Infinity;
    const delays = ghostReleaseDelays(level);
    this.ghosts = this.maze.ghostStarts.map(([x, y], i) => ({
      id: i,
      x,
      y,
      dir: i === 0 ? LEFT : NONE,
      next: NONE,
      face: i === 0 ? LEFT : UP,
      mode: i === 0 ? G_ACTIVE : G_HOUSE,
      fright: false,
      releaseAt: delays[i],
      lastFrightAt: -Infinity,
    }));
    for (const p of this.players.values()) this.spawnPlayer(p, false);
    this.broadcast(this.levelMessage());
  }

  levelMessage() {
    return {
      t: 'level',
      level: this.level,
      maze: this.maze.index,
      pellets: pelletsToString(this.pellets),
      phase: this.phase,
      phaseLeft: r2(this.phaseEnd - this.time),
      spawns: [...this.players.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, life: p.life })),
    };
  }

  // --------------------------------------------------------------- players

  addPlayer(id, profile, send) {
    const { name, skin } = sanitizeProfile(profile);
    // Auto-assigned skins avoid colors already used in the room.
    if (profile && profile.skin && profile.skin.auto) {
      const used = new Set([...this.players.values()].map((p) => p.skin.color));
      if (used.has(skin.color)) {
        const free = SKIN_COLORS.slice(0, 6).find((c) => !used.has(c.id));
        if (free) skin.color = free.id;
      }
    }
    const slot = [0, 1, 2, 3].find((s) => ![...this.players.values()].some((p) => p.slot === s));
    const p = {
      id,
      slot,
      name,
      skin,
      send,
      score: 0,
      life: 0,
      x: 0,
      y: 0,
      face: LEFT,
      moving: false,
      alive: true,
      respawnAt: 0,
      invulnUntil: 0,
      budget: 0,
      lastInputAt: this.time,
    };
    this.players.set(id, p);
    this.spawnPlayer(p, false);
    send({
      t: 'welcome',
      you: id,
      room: this.code,
      isPublic: this.isPublic,
      profile: { name: p.name, skin: p.skin },
      team: this.teamScore,
    });
    send(this.levelMessage());
    this.broadcastRoster();
    this.broadcast({ t: 'ev', k: 'join', id, name: p.name }, id);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.broadcastRoster();
    this.broadcast({ t: 'ev', k: 'leave', id, name: p.name });
  }

  spawnPlayer(p, announce) {
    const spawns = this.maze.spawns;
    const [x, y] = spawns[p.slot % spawns.length];
    p.x = x;
    p.y = y;
    p.face = p.slot % 2 === 0 ? LEFT : 2;
    p.moving = false;
    p.alive = true;
    p.life++;
    p.budget = 0;
    p.invulnUntil = this.time + INVULN_TIME;
    if (announce) this.broadcast({ t: 'ev', k: 'spawn', id: p.id, x, y, life: p.life, face: p.face });
  }

  broadcastRoster() {
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      slot: p.slot,
      name: p.name,
      skin: p.skin,
    }));
    this.broadcast({ t: 'roster', players });
  }

  broadcast(msg, exceptId) {
    for (const p of this.players.values()) if (p.id !== exceptId) p.send(msg);
  }

  // -------------------------------------------------------------- messages

  handleMessage(id, msg) {
    const p = this.players.get(id);
    if (!p || !msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'in':
        this.onInput(p, msg);
        break;
      case 'died':
        this.onDied(p, msg);
        break;
      case 'eatGhost':
        this.onEatGhost(p, msg);
        break;
      case 'profile': {
        const { name, skin } = sanitizeProfile(msg);
        p.name = name;
        p.skin = skin;
        this.broadcastRoster();
        break;
      }
      case 'ping':
        p.send({ t: 'pong', c: msg.c });
        break;
      default:
        break;
    }
  }

  onInput(p, msg) {
    if (msg.life !== p.life || !p.alive) return; // stale (from a previous life)
    if (this.phase !== 'play') return;
    const x = Number(msg.x);
    const y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const maze = this.maze;
    const tx = wrapX(maze, Math.round(x));
    const ty = Math.round(y);
    const offAxis = Math.min(Math.abs(x - Math.round(x)), Math.abs(y - Math.round(y)));
    const d = Math.abs(wrapDelta(maze, x - p.x)) + Math.abs(y - p.y);
    if (!pacCanEnter(maze, tx, ty) || offAxis > 0.05 || d > p.budget + 0.35) {
      this.correct(p);
      return;
    }
    p.budget = Math.max(0, p.budget - d);
    const oldX = p.x;
    const oldY = p.y;
    p.x = x;
    p.y = y;
    p.face = msg.face >= 1 && msg.face <= 4 ? msg.face : p.face;
    p.moving = !!msg.moving;
    p.lastInputAt = this.time;

    const eaten = [];
    const tryEat = (i) => {
      if (!Number.isInteger(i) || i < 0 || i >= this.pellets.length || !this.pellets[i]) return;
      const cx = i % maze.w;
      const cy = Math.floor(i / maze.w);
      const near =
        wrappedDist(maze, cx, cy, x, y) <= 1.5 || wrappedDist(maze, cx, cy, oldX, oldY) <= 1.5;
      if (!near) return;
      const kind = this.pellets[i];
      this.pellets[i] = 0;
      this.pelletsLeft--;
      eaten.push(i);
      this.addScore(p, kind === POWER ? POINTS.power : POINTS.pellet);
      if (kind === POWER) this.startFright(p);
    };
    if (Array.isArray(msg.eat)) for (const i of msg.eat.slice(0, 16)) tryEat(i);
    tryEat(ty * maze.w + tx); // backup: whatever tile we're on now
    if (eaten.length) this.broadcast({ t: 'eat', by: p.id, cells: eaten });
    if (this.pelletsLeft <= 0) this.clearLevel();
  }

  correct(p) {
    p.send({
      t: 'correct',
      x: p.x,
      y: p.y,
      face: p.face,
      life: p.life,
      pellets: pelletsToString(this.pellets),
    });
  }

  onDied(p, msg) {
    if (msg.life !== p.life || !p.alive || this.phase !== 'play') return;
    if (this.time < p.invulnUntil) return;
    p.alive = false;
    p.moving = false;
    p.respawnAt = this.time + RESPAWN_TIME;
    this.broadcast({ t: 'ev', k: 'death', id: p.id, g: msg.g | 0 });
  }

  onEatGhost(p, msg) {
    if (msg.life !== p.life || !p.alive || this.phase !== 'play') return;
    const g = this.ghosts[msg.g | 0];
    if (!g || g.mode !== G_ACTIVE) return;
    // Accept if frightened now, or was frightened very recently (lag tolerance).
    const recently = this.time - g.lastFrightAt < 0.35;
    if (!g.fright && !recently) return;
    if (wrappedDist(this.maze, g.x, g.y, p.x, p.y) > 2.6) return;
    g.fright = false;
    g.mode = G_EATEN;
    g.lastFrightAt = -Infinity;
    const pts = POINTS.ghost[Math.min(this.frightCombo, POINTS.ghost.length - 1)];
    this.frightCombo++;
    this.addScore(p, pts);
    this.broadcast({ t: 'ev', k: 'ghost', id: p.id, g: g.id, pts, x: r2(g.x), y: r2(g.y) });
  }

  addScore(p, pts) {
    p.score += pts;
    this.teamScore += pts;
  }

  startFright(p) {
    this.frightLeft = frightDuration(this.level);
    this.frightCombo = 0;
    for (const g of this.ghosts) {
      if (g.mode === G_ACTIVE) {
        if (!g.fright && g.dir) g.dir = OPP[g.dir];
        g.fright = true;
      }
    }
    this.broadcast({ t: 'ev', k: 'power', id: p.id, dur: this.frightLeft });
  }

  clearLevel() {
    if (this.phase === 'clear') return;
    this.phase = 'clear';
    this.phaseEnd = this.time + CLEAR_TIME;
    this.teamScore += POINTS.clear;
    this.broadcast({ t: 'ev', k: 'clear', level: this.level });
  }

  // ------------------------------------------------------------ simulation

  tick(dt = TICK_DT) {
    this.time += dt;
    this.tickCount++;

    if (this.phase === 'ready' && this.time >= this.phaseEnd) {
      this.phase = 'play';
    } else if (this.phase === 'clear' && this.time >= this.phaseEnd) {
      this.startLevel(this.level + 1);
    }

    for (const p of this.players.values()) {
      if (!p.alive && this.time >= p.respawnAt) this.spawnPlayer(p, true);
      // Movement budget for validating client positions (with slack).
      p.budget = Math.min(4, p.budget + pacSpeed(this.level) * dt * 1.25);
      if (p.moving && this.time - p.lastInputAt > 0.5) p.moving = false;
    }

    if (this.phase === 'play') this.updateGhosts(dt);

    if (this.tickCount % SNAPSHOT_EVERY === 0) this.broadcast(this.snapshot());
  }

  updateGhosts(dt) {
    this.levelTime += dt;
    if (this.frightLeft > 0) {
      this.frightLeft -= dt;
      if (this.frightLeft <= 0) {
        this.frightLeft = 0;
        for (const g of this.ghosts) {
          if (g.fright) g.lastFrightAt = this.time;
          g.fright = false;
        }
        this.frightEndedAt = this.time;
      }
    } else {
      this.modeTime += dt;
      if (this.modeTime >= MODE_SCHEDULE[this.modeIndex]) {
        this.modeTime = 0;
        this.modeIndex = Math.min(this.modeIndex + 1, MODE_SCHEDULE.length - 1);
        for (const g of this.ghosts) if (g.mode === G_ACTIVE && g.dir) g.dir = OPP[g.dir];
      }
    }
    const scatter = this.modeIndex % 2 === 0;
    const maze = this.maze;
    const base = ghostSpeed(this.level);

    for (const g of this.ghosts) {
      if (g.mode === G_HOUSE) {
        if (this.levelTime >= g.releaseAt) g.mode = G_LEAVE;
        else continue;
      }
      let speed = base;
      if (g.mode === G_EATEN) speed = GHOST_EYES_SPEED;
      else if (g.mode === G_LEAVE) speed = GHOST_HOUSE_SPEED;
      else if (g.fright) speed = GHOST_FRIGHT_SPEED;
      else if (isTunnel(maze, g.x, g.y)) speed = GHOST_TUNNEL_SPEED;

      const allowHouse = g.mode === G_LEAVE || g.mode === G_EATEN;
      const canEnter = (x, y) => ghostCanEnter(maze, x, y, allowHouse);
      advance(g, speed * dt, maze, canEnter, (e, tx, ty) => this.ghostDecide(e, tx, ty, scatter));
      if (g.dir === NONE) {
        // Stuck (e.g. just changed mode); pick any open direction next tick.
        g.next = NONE;
      }
    }
  }

  ghostDecide(g, tx, ty, scatter) {
    const maze = this.maze;
    if (g.mode === G_EATEN) {
      if (tx === maze.home[0] && ty === maze.home[1]) {
        g.mode = G_LEAVE;
      } else {
        g.next = this.bestByDist(g, tx, ty, maze.distToHome, true);
        return;
      }
    }
    if (g.mode === G_LEAVE) {
      if (tx === maze.exit[0] && ty === maze.exit[1]) {
        g.mode = G_ACTIVE;
        g.fright = false;
        g.dir = NONE;
        g.next = this.rand() < 0.5 ? LEFT : 2;
        return;
      }
      g.next = this.bestByDist(g, tx, ty, maze.distToExit, true);
      return;
    }
    // Active ghost: no reversing; choose among open exits.
    const options = [];
    for (let d = 1; d <= 4; d++) {
      if (g.dir && d === OPP[g.dir]) continue;
      if (ghostCanEnter(maze, tx + DX[d], ty + DY[d], false)) options.push(d);
    }
    if (!options.length) {
      g.next = g.dir ? OPP[g.dir] : NONE;
      return;
    }
    if (g.fright) {
      g.next = options[Math.floor(this.rand() * options.length)];
      return;
    }
    const [gx, gy] = this.ghostTarget(g, scatter);
    let best = options[0];
    let bestD = Infinity;
    for (const d of options) {
      const nx = tx + DX[d];
      const ny = ty + DY[d];
      const dd = wrapDelta(maze, gx - nx) ** 2 + (gy - ny) ** 2;
      if (dd < bestD - 1e-9) {
        bestD = dd;
        best = d;
      }
    }
    g.next = best;
  }

  bestByDist(g, tx, ty, distMap, allowReverse) {
    const maze = this.maze;
    let best = NONE;
    let bestD = Infinity;
    for (let d = 1; d <= 4; d++) {
      if (!allowReverse && g.dir && d === OPP[g.dir]) continue;
      const nx = wrapX(maze, tx + DX[d]);
      const ny = ty + DY[d];
      if (!ghostCanEnter(maze, nx, ny, true)) continue;
      const v = distMap[ny * maze.w + nx];
      if (v >= 0 && v < bestD) {
        bestD = v;
        best = d;
      }
    }
    return best;
  }

  ghostTarget(g, scatter) {
    const maze = this.maze;
    // Each ghost hunts the closest living pac.
    let target = null;
    let bestD = Infinity;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = wrappedDist(maze, g.x, g.y, p.x, p.y);
      if (d < bestD) {
        bestD = d;
        target = p;
      }
    }
    if (scatter || !target) return maze.scatter[g.id];
    const px = Math.round(target.x);
    const py = Math.round(target.y);
    const f = target.face || LEFT;
    switch (g.id) {
      case 0:
        return [px, py];
      case 1:
        return [px + DX[f] * 4, py + DY[f] * 4];
      case 2: {
        const ax = px + DX[f] * 2;
        const ay = py + DY[f] * 2;
        const red = this.ghosts[0];
        return [ax * 2 - red.x, ay * 2 - red.y];
      }
      default:
        return bestD > 8 ? [px, py] : maze.scatter[3];
    }
  }

  snapshot() {
    const ghosts = this.ghosts.map((g) => [
      r2(g.x),
      r2(g.y),
      g.face,
      g.mode === G_ACTIVE && g.fright ? G_FRIGHT : g.mode,
    ]);
    const players = [...this.players.values()].map((p) => [
      p.id,
      r2(p.x),
      r2(p.y),
      p.face,
      p.moving ? 1 : 0,
      p.alive ? 1 : 0,
      Math.max(0, r2(p.invulnUntil - this.time)),
      p.score,
    ]);
    return {
      t: 'snap',
      time: Math.round(this.time * 1000),
      phase: this.phase,
      phaseLeft: r2(Math.max(0, this.phaseEnd - this.time)),
      fright: r2(this.frightLeft),
      team: this.teamScore,
      left: this.pelletsLeft,
      ghosts,
      players,
    };
  }
}

export { PELLET, POWER };
