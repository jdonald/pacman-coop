// Tiny WebAudio synth for retro blips; no audio files needed.

export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    try {
      this.muted = localStorage.getItem('pcoop.muted') === '1';
    } catch {
      /* ignore */
    }
    this.waka = 0;
    this.lastWaka = 0;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.25;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    try {
      localStorage.setItem('pcoop.muted', m ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  tone(freq, dur, { type = 'square', vol = 0.3, slide = 0, delay = 0 } = {}) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  eat() {
    const now = performance.now();
    if (now - this.lastWaka < 90) return;
    this.lastWaka = now;
    this.waka ^= 1;
    this.tone(this.waka ? 380 : 260, 0.08, { type: 'triangle', vol: 0.35, slide: this.waka ? -120 : 120 });
  }

  power() {
    for (let i = 0; i < 4; i++) this.tone(300 + i * 140, 0.1, { delay: i * 0.06, vol: 0.2 });
  }

  ghost() {
    this.tone(200, 0.35, { type: 'sawtooth', vol: 0.2, slide: 1400 });
  }

  death() {
    this.tone(700, 0.9, { type: 'square', vol: 0.18, slide: -620 });
  }

  otherDeath() {
    this.tone(500, 0.4, { type: 'triangle', vol: 0.12, slide: -380 });
  }

  clear() {
    [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this.tone(f, 0.16, { delay: i * 0.11, vol: 0.18 }));
  }

  ready() {
    [392, 523, 659].forEach((f, i) => this.tone(f, 0.12, { delay: i * 0.1, vol: 0.15, type: 'triangle' }));
  }

  join() {
    this.tone(660, 0.12, { type: 'triangle', vol: 0.15 });
    this.tone(880, 0.15, { type: 'triangle', vol: 0.15, delay: 0.1 });
  }
}
