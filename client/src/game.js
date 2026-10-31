// Client-side game state: local prediction of your own pac, snapshot
// interpolation for everything else, and message handling.

import {
  TICK_DT, INPUT_EVERY, NONE, HIT_DIST, INVULN_TIME, RESPAWN_TIME, POWER, pacSpeed,
} from '../../shared/constants.js';
import { getMaze, pacCanEnter, wrapX, pelletsFromString } from '../../shared/maze.js';
import { advance, wrappedDist, wrapDelta } from '../../shared/movement.js';

export const GM = { HOUSE: 0, LEAVE: 1, ACTIVE: 2, FRIGHT: 3, EATEN: 4 };

export class Game {
  constructor(transport, profile, emit) {
    this.transport = transport;
    this.profile = profile;
    this.emit = emit; // (type, data) => void, for audio / HUD / effects
    this.you = null;
    this.roomCode = '';
    this.isPublic = false;
    this.roster = new Map();
    this.level = 0;
    this.maze = null;
    this.pellets = null;
    this.phase = 'connecting';
    this.phaseLeft = 0;
    this.phaseAt = 0;
    this.fright = 0;
    this.team = 0;
    this.scores = new Map();
    this.snaps = [];
    this.offset = null;
    this.interpDelay = transport.online ? 100 : 35;
    this.me = { x: 0, y: 0, dir: NONE, next: NONE, face: 4, life: 0, alive: false, moving: false };
    this.prev = { x: 0, y: 0 };
    this.pendingEat = [];
    this.delayedEats = [];
    this.tickCount = 0;
    this.localFrightUntil = 0;
    this.eatenPending = new Map();
    this.deathAt = new Map(); // player id -> performance.now() of death
    this.invulnUntil = 0;
    this.rtt = null;
    this.lastPing = 0;
    this.ghostView = [];
    this.playerView = new Map();

    transport.onmessage = (m) => this.handle(m);
    transport.onopen = () => transport.send({ t: 'hello', profile });
  }

  // ------------------------------------------------------------- network

  handle(m) {
    const now = performance.now();
    switch (m.t) {
      case 'welcome':
        this.you = m.you;
        this.roomCode = m.room;
        this.isPublic = m.isPublic;
        this.team = m.team;
        this.emit('welcome', m);
        break;
      case 'level': {
        const firstLevel = this.level === 0;
        this.level = m.level;
        this.maze = getMaze(m.maze);
        this.pellets = pelletsFromString(m.pellets);
        this.setPhase(m.phase, m.phaseLeft);
        this.localFrightUntil = 0;
        this.eatenPending.clear();
        this.delayedEats = [];
        this.pendingEat = [];
        this.snaps = [];
        const mine = m.spawns.find((s) => s.id === this.you);
        if (mine) this.respawnMe(mine.x, mine.y, mine.life, 4);
        this.emit('level', { level: m.level, first: firstLevel });
        break;
      }
      case 'roster':
        this.roster = new Map(m.players.map((p) => [p.id, p]));
        this.emit('roster', m.players);
        break;
      case 'snap':
        this.onSnap(m, now);
        break;
      case 'eat':
        if (m.by === this.you) this.applyEats(m.cells);
        else this.delayedEats.push({ at: now + this.interpDelay, cells: m.cells, by: m.by });
        break;
      case 'correct':
        this.corrections = (this.corrections || 0) + 1;
        if (m.life === this.me.life) {
          this.me.x = this.prev.x = m.x;
          this.me.y = this.prev.y = m.y;
          this.me.dir = NONE;
          this.pellets = pelletsFromString(m.pellets);
          this.pendingEat = [];
        }
        break;
      case 'ev':
        this.onEvent(m, now);
        break;
      case 'pong':
        this.rtt = now - m.c;
        break;
      case 'error':
        this.emit('error', m);
        break;
      default:
        break;
    }
  }

  setPhase(phase, left) {
    if (phase !== this.phase) this.emit('phase', phase);
    this.phase = phase;
    this.phaseLeft = left;
    this.phaseAt = performance.now();
  }

  onSnap(m, now) {
    const sample = now - m.time;
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.002;
    this.snaps.push(m);
    if (this.snaps.length > 40) this.snaps.shift();
    this.setPhase(m.phase, m.phaseLeft);
    this.fright = m.fright;
    this.team = m.team;
    for (const p of m.players) this.scores.set(p[0], p[7]);
    // Watchdog: if we think we're dead but the server long since respawned us.
    const mine = m.players.find((p) => p[0] === this.you);
    if (mine && !this.me.alive && mine[5] && now - (this.deathAt.get(this.you) || 0) > (RESPAWN_TIME + 2) * 1000) {
      this.respawnMe(mine[1], mine[2], this.me.life, mine[3]);
    }
  }

  onEvent(m, now) {
    switch (m.k) {
      case 'spawn':
        if (m.id === this.you) this.respawnMe(m.x, m.y, m.life, m.face);
        this.deathAt.delete(m.id);
        break;
      case 'death':
        if (m.id !== this.you) this.deathAt.set(m.id, now + this.interpDelay);
        if (m.id !== this.you) this.emit('death', { id: m.id, mine: false });
        break;
      case 'ghost':
        this.eatenPending.set(m.g, now + 1500);
        this.emit('ghostEaten', m);
        break;
      case 'power':
        if (m.id !== this.you) this.emit('power', m);
        break;
      case 'clear':
        this.emit('clear', m);
        break;
      case 'join':
      case 'leave':
        this.emit(m.k, m);
        break;
      default:
        break;
    }
  }

  respawnMe(x, y, life, face) {
    const me = this.me;
    me.x = this.prev.x = x;
    me.y = this.prev.y = y;
    me.dir = NONE;
    me.next = NONE;
    me.face = face || 4;
    me.life = life;
    me.alive = true;
    me.moving = false;
    this.pendingEat = [];
    this.invulnUntil = performance.now() + INVULN_TIME * 1000;
    this.deathAt.delete(this.you);
  }

  applyEats(cells) {
    for (const i of cells) this.pellets[i] = 0;
  }

  setDirection(dir) {
    if (dir) this.me.next = dir;
  }

  // -------------------------------------------------------------- update

  /** Called once per animation frame. */
  frame(now) {
    if (this.delayedEats.length) {
      const due = this.delayedEats.filter((e) => e.at <= now);
      if (due.length) {
        this.delayedEats = this.delayedEats.filter((e) => e.at > now);
        for (const e of due) {
          this.applyEats(e.cells);
          this.emit('remoteEat', e);
        }
      }
    }
    if (now - this.lastPing > 2000 && this.transport.online) {
      this.lastPing = now;
      this.transport.send({ t: 'ping', c: now });
    }
    this.sampleView(now);
  }

  /** Fixed 60 Hz step for local prediction. */
  fixedStep(now) {
    this.tickCount++;
    const me = this.me;
    this.prev.x = me.x;
    this.prev.y = me.y;
    if (!this.maze || this.phase !== 'play' || !me.alive) {
      me.moving = false;
      return;
    }
    const maze = this.maze;
    const bx = me.x;
    const by = me.y;
    advance(me, pacSpeed(this.level) * TICK_DT, maze, (x, y) => pacCanEnter(maze, x, y));
    me.moving = me.x !== bx || me.y !== by;

    // Eat pellets on the tile we're on.
    const tx = wrapX(maze, Math.round(me.x));
    const ty = Math.round(me.y);
    const i = ty * maze.w + tx;
    const kind = this.pellets[i];
    if (kind) {
      this.pellets[i] = 0;
      this.pendingEat.push(i);
      if (kind === POWER) this.localFrightUntil = now + 700;
      this.emit('eat', { kind, mine: true });
    }

    this.checkCollisions(now);

    if (this.tickCount % INPUT_EVERY === 0) {
      this.transport.send({
        t: 'in',
        x: Math.round(me.x * 1000) / 1000,
        y: Math.round(me.y * 1000) / 1000,
        face: me.face,
        moving: me.moving,
        life: me.life,
        eat: this.pendingEat,
      });
      this.pendingEat = [];
    }
  }

  checkCollisions(now) {
    const me = this.me;
    this.sampleView(now);
    for (let g = 0; g < this.ghostView.length; g++) {
      const gv = this.ghostView[g];
      if (gv.mode === GM.HOUSE || gv.mode === GM.EATEN) continue;
      if (wrappedDist(this.maze, me.x, me.y, gv.x, gv.y) > HIT_DIST) continue;
      if (gv.mode === GM.FRIGHT) {
        if (!this.eatenPending.has(g)) {
          this.eatenPending.set(g, now + 1000);
          this.transport.send({ t: 'eatGhost', g, life: me.life });
          this.emit('chomp', { g });
        }
      } else if (now >= this.invulnUntil && !this.eatenPending.has(g)) {
        me.alive = false;
        me.moving = false;
        this.deathAt.set(this.you, now);
        this.transport.send({ t: 'died', g, life: me.life });
        this.emit('death', { id: this.you, mine: true });
        return;
      }
    }
  }

  /** Interpolate ghosts and other players at (estimated server time - delay). */
  sampleView(now) {
    for (const [g, until] of this.eatenPending) if (until < now) this.eatenPending.delete(g);
    const s = this.snaps;
    if (!s.length || !this.maze) return;
    const t = now - this.offset - this.interpDelay;
    let a = s[0];
    let b = null;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].time <= t) {
        a = s[i];
        b = s[i + 1] || null;
        break;
      }
    }
    const alpha = b ? Math.min(1, Math.max(0, (t - a.time) / (b.time - a.time))) : 0;
    const maze = this.maze;
    const lerp = (ax, ay, bx, by) => {
      const dx = wrapDelta(maze, bx - ax);
      const dy = by - ay;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) return alpha < 0.5 ? [ax, ay] : [bx, by];
      let x = ax + dx * alpha;
      if (x < -0.5) x += maze.w;
      else if (x >= maze.w - 0.5) x -= maze.w;
      return [x, ay + dy * alpha];
    };
    const localFright = now < this.localFrightUntil;
    this.ghostView = a.ghosts.map((ga, i) => {
      const gb = b ? b.ghosts[i] : ga;
      const [x, y] = lerp(ga[0], ga[1], gb[0], gb[1]);
      let mode = alpha < 0.5 ? ga[3] : gb[3];
      if (localFright && mode === GM.ACTIVE) mode = GM.FRIGHT;
      if (this.eatenPending.has(i) && mode !== GM.HOUSE && mode !== GM.LEAVE) mode = GM.EATEN;
      return { x, y, face: alpha < 0.5 ? ga[2] : gb[2], mode };
    });
    const view = new Map();
    for (const pa of a.players) {
      const pb = (b && b.players.find((p) => p[0] === pa[0])) || pa;
      const [x, y] = lerp(pa[1], pa[2], pb[1], pb[2]);
      view.set(pa[0], { x, y, face: pb[3], moving: !!pb[4], alive: !!pb[5], inv: pb[6] });
    }
    this.playerView = view;
  }

  /** Smoothly rendered position of your own pac. */
  myRenderPos(alpha) {
    const maze = this.maze;
    let dx = wrapDelta(maze, this.me.x - this.prev.x);
    if (Math.abs(dx) > 2) dx = 0;
    let x = this.prev.x + dx * alpha;
    if (x < -0.5) x += maze.w;
    else if (x >= maze.w - 0.5) x -= maze.w;
    return [x, this.prev.y + (this.me.y - this.prev.y) * alpha];
  }

  phaseRemaining(now) {
    return Math.max(0, this.phaseLeft - (now - this.phaseAt) / 1000);
  }
}
