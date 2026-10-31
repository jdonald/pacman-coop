// Transports: a WebSocket connection to the game server, or an in-browser
// room for offline solo play (same authoritative code, zero latency).

import { Room } from '../../shared/room.js';
import { TICK_DT } from '../../shared/constants.js';

/** Resolve the WebSocket URL of the game server. */
export function serverUrl(room) {
  let base = import.meta.env.VITE_GAME_SERVER_URL;
  if (!base) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    base = `${proto}//${location.host}`;
  }
  base = base.replace(/^http/, 'ws').replace(/\/+$/, '');
  if (!/\/ws$/.test(base)) base += '/ws';
  return room ? `${base}?room=${encodeURIComponent(room)}` : base;
}

/** HTTP health endpoint of the game server (also used to wake it up). */
export function healthUrl() {
  const ws = serverUrl('');
  return ws.replace(/^ws/, 'http').replace(/\/ws$/, '/health');
}

export class SocketTransport {
  constructor(url) {
    this.url = url;
    this.onmessage = () => {};
    this.onclose = () => {};
    this.onopen = () => {};
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.onopen();
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onmessage(msg);
    };
    this.ws.onclose = () => this.onclose();
    this.ws.onerror = () => {};
  }
  get online() {
    return true;
  }
  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  close() {
    this.ws.onclose = null;
    this.ws.close();
  }
  /** Called each animation frame; nothing to do for sockets. */
  update() {}
}

export class LocalTransport {
  constructor() {
    this.onmessage = () => {};
    this.onclose = () => {};
    this.onopen = () => {};
    this.room = new Room({ code: 'SOLO', isPublic: false });
    this.acc = 0;
    this.last = performance.now();
    this.queue = [];
    setTimeout(() => this.onopen(), 0);
  }
  get online() {
    return false;
  }
  send(msg) {
    msg = JSON.parse(JSON.stringify(msg));
    if (msg.t === 'hello') {
      this.room.addPlayer('p1', msg.profile, (m) => this.queue.push(JSON.parse(JSON.stringify(m))));
    } else {
      this.room.handleMessage('p1', msg);
    }
    this.flush();
  }
  flush() {
    const q = this.queue;
    this.queue = [];
    for (const m of q) this.onmessage(m);
  }
  close() {}
  update() {
    const now = performance.now();
    this.acc += Math.min(250, now - this.last) / 1000;
    this.last = now;
    while (this.acc >= TICK_DT) {
      this.room.tick(TICK_DT);
      this.acc -= TICK_DT;
    }
    this.flush();
  }
}
