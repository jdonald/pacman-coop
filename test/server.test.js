import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 1000);

function client(path) {
  const ws = new WebSocket(`ws://localhost:${PORT}${path}`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  const until = (pred) =>
    new Promise((resolve, reject) => {
      const found = msgs.find(pred);
      if (found) return resolve(found);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout')), 4000);
    });
  const opened = new Promise((r) => ws.on('open', r));
  return { ws, msgs, until, opened, send: (m) => ws.send(JSON.stringify(m)) };
}

test('two players matchmake into the same public room and receive snapshots', async (t) => {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT) } });
  t.after(() => srv.kill());
  await new Promise((r) => srv.stdout.on('data', (d) => d.toString().includes('listening') && r()));

  const a = client('/ws');
  await a.opened;
  a.send({ t: 'hello', profile: { name: 'Alice' } });
  const wa = await a.until((m) => m.t === 'welcome');
  assert.equal(wa.profile.name, 'Alice');

  const b = client('/ws');
  await b.opened;
  b.send({ t: 'hello', profile: { name: 'Bob<script>' } });
  const wb = await b.until((m) => m.t === 'welcome');
  assert.equal(wb.room, wa.room, 'matchmade into the same room');
  assert.equal(wb.profile.name, 'Bobscript', 'names are sanitized');

  const roster = await a.until((m) => m.t === 'roster' && m.players.length === 2);
  assert.deepEqual(roster.players.map((p) => p.name).sort(), ['Alice', 'Bobscript']);
  const snap = await b.until((m) => m.t === 'snap' && m.players.length === 2);
  assert.equal(snap.ghosts.length, 4);

  // Join by explicit room code.
  const c = client(`/ws?room=${wa.room}`);
  await c.opened;
  c.send({ t: 'hello', profile: {} });
  const wc = await c.until((m) => m.t === 'welcome');
  assert.equal(wc.room, wa.room);

  const res = await fetch(`http://localhost:${PORT}/health`).then((r) => r.json());
  assert.equal(res.players, 3);
  for (const x of [a, b, c]) x.ws.close();
});
