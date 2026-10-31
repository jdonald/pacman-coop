// Runs the game server and the Vite dev server together: `npm run dev`.
import { spawn } from 'node:child_process';

const procs = [
  spawn('node', ['--watch', 'server/index.js'], { stdio: 'inherit' }),
  spawn('npx', ['vite'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', stop);
