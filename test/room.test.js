import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, G_ACTIVE, G_EATEN, G_LEAVE, G_HOUSE } from '../shared/room.js';
import { TICK_DT, NONE, DX, DY, OPP, pacSpeed, LEFT } from '../shared/constants.js';
import { pacCanEnter, wrapX } from '../shared/maze.js';
import { advance } from '../shared/movement.js';

// Seeded RNG so the tests are deterministic.
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** A fake client that predicts its pac exactly like the browser does. */
function makeBot(room, id, rand) {
  const inbox = [];
  const bot = { inbox, me: null, life: 0 };
  room.addPlayer(id, { name: id }, (m) => inbox.push(m));
  const p = room.players.get(id);
  bot.me = { x: p.x, y: p.y, dir: NONE, next: LEFT, face: LEFT };
  bot.life = p.life;
  bot.tick = (n) => {
    for (const m of inbox.splice(0)) {
      if ((m.t === 'ev' && m.k === 'spawn' && m.id === id) || m.t === 'correct') {
        Object.assign(bot.me, { x: m.x, y: m.y, dir: NONE });
        bot.life = m.life;
        if (m.t === 'correct') bot.corrections = (bot.corrections || 0) + 1;
      }
      if (m.t === 'level') {
        const s = m.spawns.find((s) => s.id === id);
        Object.assign(bot.me, { x: s.x, y: s.y, dir: NONE });
        bot.life = s.life;
      }
    }
    if (room.phase !== 'play') return;
    const maze = room.maze;
    // Wander: occasionally pick a random open direction.
    if (bot.me.dir === NONE || rand() < 0.05) {
      const opts = [1, 2, 3, 4].filter((d) => d !== OPP[bot.me.dir]);
      bot.me.next = opts[Math.floor(rand() * opts.length)];
    }
    advance(bot.me, pacSpeed(room.level) * TICK_DT, maze, (x, y) => pacCanEnter(maze, x, y));
    if (n % 2 === 0) {
      const i = Math.round(bot.me.y) * maze.w + wrapX(maze, Math.round(bot.me.x));
      room.handleMessage(id, { t: 'in', x: bot.me.x, y: bot.me.y, face: bot.me.face, moving: true, life: bot.life, eat: [i] });
    }
  };
  return bot;
}

test('bots play for two minutes without corrections; ghosts behave', () => {
  const rand = rng(42);
  const room = new Room({ code: 'TEST', rand });
  const bots = [makeBot(room, 'a', rand), makeBot(room, 'b', rand)];
  const start = room.pelletsLeft;
  const seenModes = new Set();
  for (let n = 0; n < 60 * 120; n++) {
    room.tick(TICK_DT);
    for (const b of bots) b.tick(n);
    for (const g of room.ghosts) {
      seenModes.add(g.mode);
      assert.ok(Number.isFinite(g.x) && Number.isFinite(g.y));
      assert.ok(g.y >= 0 && g.y < room.maze.h, 'ghost inside maze');
    }
  }
  assert.equal(bots[0].corrections || 0, 0, 'no corrections for honest client');
  assert.equal(bots[1].corrections || 0, 0, 'no corrections for honest client');
  assert.ok(room.pelletsLeft < start - 50 || room.level > 1, 'pellets were eaten');
  assert.ok(room.ghosts.every((g) => g.mode !== G_HOUSE), 'all ghosts released');
  assert.ok(seenModes.has(G_ACTIVE) && seenModes.has(G_LEAVE));
});

test('speed hacks and wall clipping are corrected', () => {
  const room = new Room({ code: 'T2' });
  const msgs = [];
  room.addPlayer('x', {}, (m) => msgs.push(m));
  for (let i = 0; i < 300; i++) room.tick(TICK_DT); // past READY
  const p = room.players.get('x');
  room.handleMessage('x', { t: 'in', x: p.x + 8, y: p.y, life: p.life, face: 2 });
  assert.ok(msgs.some((m) => m.t === 'correct'));
  msgs.length = 0;
  room.handleMessage('x', { t: 'in', x: 0, y: 0, life: p.life, face: 2 }); // a wall
  assert.ok(msgs.some((m) => m.t === 'correct'));
});

test('power pellet frightens ghosts and they can be eaten, then return home', () => {
  const room = new Room({ code: 'T3' });
  const msgs = [];
  room.addPlayer('x', {}, (m) => msgs.push(m));
  for (let i = 0; i < 300; i++) room.tick(TICK_DT);
  const p = room.players.get('x');
  room.startFright(p);
  const g = room.ghosts[0];
  assert.equal(g.fright, true);
  p.x = Math.round(g.x);
  p.y = Math.round(g.y);
  room.handleMessage('x', { t: 'eatGhost', g: 0, life: p.life });
  assert.equal(g.mode, G_EATEN);
  assert.equal(p.score, 200);
  let back = false;
  for (let i = 0; i < 60 * 10 && !back; i++) {
    room.tick(TICK_DT);
    back = g.mode === G_ACTIVE;
  }
  assert.ok(back, 'eaten ghost returned home and left again');
});

test('death and respawn with infinite lives', () => {
  const room = new Room({ code: 'T4' });
  const msgs = [];
  room.addPlayer('x', {}, (m) => msgs.push(m));
  for (let i = 0; i < 60 * 8; i++) room.tick(TICK_DT); // past READY + invulnerability
  const p = room.players.get('x');
  const life = p.life;
  room.handleMessage('x', { t: 'died', g: 0, life });
  assert.equal(p.alive, false);
  for (let i = 0; i < 60 * 3; i++) room.tick(TICK_DT);
  assert.equal(p.alive, true);
  assert.equal(p.life, life + 1);
  assert.ok(msgs.some((m) => m.t === 'ev' && m.k === 'spawn'));
});

test('clearing all pellets advances the level', () => {
  const room = new Room({ code: 'T5' });
  room.addPlayer('x', {}, () => {});
  for (let i = 0; i < 300; i++) room.tick(TICK_DT);
  room.pelletsLeft = 0;
  room.clearLevel();
  assert.equal(room.phase, 'clear');
  for (let i = 0; i < 60 * 3; i++) room.tick(TICK_DT);
  assert.equal(room.level, 2);
  assert.equal(room.phase, 'ready');
  assert.equal(room.maze.index, 1);
});

test('room holds at most 4 players and tracks DX/DY sanity', () => {
  const room = new Room({ code: 'T6' });
  for (let i = 0; i < 4; i++) room.addPlayer(`p${i}`, {}, () => {});
  assert.equal(room.full, true);
  assert.equal(DX.length, DY.length);
});
