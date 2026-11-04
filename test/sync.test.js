// End-to-end netcode tests: real client Game instances talk to a Room through
// a simulated laggy, jittery connection, on a simulated clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, G_ACTIVE } from '../shared/room.js';
import { TICK_DT, LEFT, RIGHT, PELLET } from '../shared/constants.js';
import { Game } from '../client/src/game.js';

let simNow = 0;
performance.now = () => simNow;

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Wire a client Game to the room with one-way latency `lag` ms (+ jitter). */
function connect(room, id, lag, jitter, rand) {
  const toClient = [];
  const toServer = [];
  let lastC = 0;
  let lastS = 0;
  const due = (last) => Math.max(last, simNow + lag + rand() * jitter);
  const transport = {
    online: true,
    onmessage: () => {},
    onopen: () => {},
    onclose: () => {},
    send(msg) {
      lastS = due(lastS);
      toServer.push({ at: lastS, msg: JSON.parse(JSON.stringify(msg)) });
    },
    close() {},
    update() {},
  };
  const game = new Game(transport, { name: id }, () => {});
  transport.onopen();
  const client = { id, game, joined: false };
  client.pump = () => {
    while (toServer.length && toServer[0].at <= simNow) {
      const { msg } = toServer.shift();
      if (msg.t === 'hello') {
        room.addPlayer(id, msg.profile, (m) => {
          lastC = due(lastC);
          toClient.push({ at: lastC, msg: JSON.parse(JSON.stringify(m)) });
        });
      } else room.handleMessage(id, msg);
    }
    while (toClient.length && toClient[0].at <= simNow) game.handle(toClient.shift().msg);
  };
  return client;
}

function step(room, clients, { drive = true } = {}) {
  simNow += TICK_DT * 1000;
  room.tick(TICK_DT);
  for (const c of clients) {
    c.pump();
    c.game.frame(simNow);
    if (drive) c.game.fixedStep(simNow);
  }
}

test('pellets stay identical on every client and the server under lag', () => {
  simNow = 0;
  const rand = rng(7);
  const room = new Room({ code: 'SYNC', rand });
  const clients = [connect(room, 'a', 45, 25, rand), connect(room, 'b', 70, 40, rand)];
  for (let n = 0; n < 60 * 90; n++) {
    for (const c of clients) {
      const me = c.game.me;
      if (!me.dir || rand() < 0.04) c.game.setDirection(1 + Math.floor(rand() * 4));
    }
    step(room, clients);
  }
  // Stop moving and let in-flight messages drain.
  for (let n = 0; n < 60 * 3; n++) step(room, clients, { drive: false });
  for (const c of clients) {
    const diff = [];
    for (let i = 0; i < room.pellets.length; i++) if (c.game.pellets[i] !== room.pellets[i]) diff.push(i);
    assert.deepEqual(diff, [], `client ${c.id} pellets match the server`);
    assert.equal(c.game.corrections || 0, 0, 'no corrections');
  }
  assert.ok(room.level > 1 || room.pelletsLeft < room.maze.pelletCount - 40, 'pellets were eaten');
});

test('eating the last pellet while hitting a ghost still clears the level', () => {
  simNow = 0;
  const rand = rng(3);
  const room = new Room({ code: 'CLUTCH', rand });
  const a = connect(room, 'a', 40, 10, rand);
  const b = connect(room, 'b', 60, 10, rand);
  const clients = [a, b];
  while (room.phase !== 'play' || !a.game.you || a.game.phase !== 'play') step(room, clients, { drive: false });
  for (let n = 0; n < 60 * 3; n++) step(room, clients, { drive: false }); // let invulnerability expire

  // Leave exactly one pellet, right next to player a, with a ghost parked on it.
  const p = room.players.get('a');
  const maze = room.maze;
  const dir = maze.cells[p.y * maze.w + p.x - 1] === 0 ? LEFT : RIGHT;
  const tx = p.x + (dir === LEFT ? -1 : 1);
  const cell = p.y * maze.w + tx;
  room.pellets.fill(0);
  room.pellets[cell] = PELLET;
  room.pelletsLeft = 1;
  room.broadcast({ t: 'pellets', s: [...room.pellets].join(''), left: 1 });
  const g = room.ghosts[0];
  Object.assign(g, { x: tx, y: p.y, mode: G_ACTIVE, fright: false, dir: 0 });
  room.pauseUntil = room.time + 10; // keep the ghost parked there
  room.frightLeft = 0;
  for (let n = 0; n < 30; n++) step(room, clients, { drive: false });
  a.game.invulnUntil = 0;
  p.invulnUntil = 0;

  a.game.setDirection(dir);
  let died = false;
  for (let n = 0; n < 60 && room.phase === 'play'; n++) {
    step(room, clients);
    died ||= !a.game.me.alive;
  }
  for (let n = 0; n < 30; n++) step(room, clients, { drive: false });
  assert.ok(died, 'player a collided with the ghost');
  assert.notEqual(room.phase, 'play', 'server saw the last pellet: level cleared');
  assert.equal(b.game.pellets[cell], 0, "the other player's screen shows it eaten too");
});

test('eating a ghost freezes the game for everyone', () => {
  simNow = 0;
  const rand = rng(5);
  const room = new Room({ code: 'FREEZE', rand });
  const a = connect(room, 'a', 30, 5, rand);
  const b = connect(room, 'b', 50, 5, rand);
  while (room.phase !== 'play' || b.game.phase !== 'play') step(room, [a, b], { drive: false });
  const p = room.players.get('a');
  room.startFright(p);
  const g = room.ghosts[0];
  Object.assign(g, { x: p.x, y: p.y });
  room.handleMessage('a', { t: 'eatGhost', g: 0, life: p.life });
  const frozen = room.ghosts.map((gh) => [gh.x, gh.y]);
  for (let n = 0; n < 50; n++) step(room, [a, b], { drive: false });
  assert.deepEqual(room.ghosts.map((gh) => [gh.x, gh.y]), frozen, 'ghosts stand still during the freeze');
  assert.ok(b.game.isPaused(simNow), 'the other player is frozen too');
  for (let n = 0; n < 60; n++) step(room, [a, b], { drive: false });
  assert.ok(!b.game.isPaused(simNow));
  assert.notDeepEqual(room.ghosts.map((gh) => [gh.x, gh.y]), frozen, 'ghosts move again afterwards');
});
