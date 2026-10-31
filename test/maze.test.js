import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMaze, MAZE_COUNT, pacCanEnter, wrapX } from '../shared/maze.js';
import { DX, DY } from '../shared/constants.js';

for (let m = 0; m < MAZE_COUNT; m++) {
  test(`maze ${m} is well-formed`, () => {
    const maze = getMaze(m);
    const open = (x, y) => pacCanEnter(maze, x, y);
    assert.ok(maze.spawns.length >= 2, 'has spawns');
    assert.ok(open(...maze.exit), 'ghost exit tile is a corridor');
    let start = null;
    for (let y = 0; y < maze.h; y++) {
      for (let x = 0; x < maze.w; x++) {
        if (!open(x, y)) continue;
        start ??= [x, y];
        let n = 0;
        for (let d = 1; d <= 4; d++) if (open(x + DX[d], y + DY[d])) n++;
        assert.ok(n >= 2, `dead end at ${x},${y}`);
        const block = open(x + 1, y) && open(x, y + 1) && open(x + 1, y + 1);
        assert.ok(!block || x === maze.w - 1, `2x2 open area at ${x},${y}`);
      }
    }
    // Every corridor reachable by pacs; every corridor reachable by ghosts from home.
    const seen = new Set([start.join()]);
    const q = [start];
    while (q.length) {
      const [x, y] = q.pop();
      for (let d = 1; d <= 4; d++) {
        const nx = wrapX(maze, x + DX[d]);
        const ny = y + DY[d];
        if (open(nx, ny) && !seen.has(`${nx},${ny}`)) {
          seen.add(`${nx},${ny}`);
          q.push([nx, ny]);
        }
      }
    }
    for (let y = 0; y < maze.h; y++)
      for (let x = 0; x < maze.w; x++) {
        if (!open(x, y)) continue;
        assert.ok(seen.has(`${x},${y}`), `unreachable ${x},${y}`);
        assert.ok(maze.distToHome[y * maze.w + x] >= 0, `ghosts can't get home from ${x},${y}`);
      }
    for (const [x, y] of maze.ghostStarts) assert.ok(maze.distToExit[y * maze.w + x] >= 0);
  });
}
