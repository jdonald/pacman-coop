// Keyboard (arrows / WASD), touch swipes and gamepads.
import { UP, RIGHT, DOWN, LEFT } from '../../shared/constants.js';

const KEYS = {
  ArrowUp: UP, KeyW: UP,
  ArrowRight: RIGHT, KeyD: RIGHT,
  ArrowDown: DOWN, KeyS: DOWN,
  ArrowLeft: LEFT, KeyA: LEFT,
};

export function setupInput(target, onDir, isBlocked) {
  window.addEventListener('keydown', (e) => {
    if (isBlocked()) return;
    const d = KEYS[e.code];
    if (d) {
      onDir(d);
      e.preventDefault();
    }
  });

  // Swipe anywhere on the canvas; a short drag is enough.
  let start = null;
  target.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY };
  });
  target.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) < 18) return;
    onDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : dy > 0 ? DOWN : UP);
    start = { x: e.clientX, y: e.clientY };
  });
  const end = () => (start = null);
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
  target.style.touchAction = 'none';

  // Gamepads (d-pad or left stick), polled each frame.
  let lastPad = 0;
  return function pollGamepads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const b = (i) => p.buttons[i] && p.buttons[i].pressed;
      let d = b(12) ? UP : b(15) ? RIGHT : b(13) ? DOWN : b(14) ? LEFT : 0;
      if (!d && p.axes.length >= 2) {
        const [ax, ay] = p.axes;
        if (Math.max(Math.abs(ax), Math.abs(ay)) > 0.5) {
          d = Math.abs(ax) > Math.abs(ay) ? (ax > 0 ? RIGHT : LEFT) : ay > 0 ? DOWN : UP;
        }
      }
      if (d && d !== lastPad) onDir(d);
      lastPad = d;
      if (d) return;
    }
  };
}
