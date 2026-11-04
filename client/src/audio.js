// Retro arcade sound, synthesized live with WebAudio (no audio files):
// an original 8-bit level-start tune, the classic-style "waka" chomp, a
// ghost siren that speeds up as the maze empties, the frightened warble,
// the eyes-retreat whine, ghost-eaten blip, death spiral and level fanfare.

const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
function freq(n) {
  const m = /^([A-G]#?)(\d)$/.exec(n);
  const midi = (Number(m[2]) + 1) * 12 + NOTE[m[1]];
  return 440 * 2 ** ((midi - 69) / 12);
}

// Original level-start tune: 32 sixteenth notes (~4.3 s). [note, sixteenths]
const INTRO_LEAD = [
  ['C5', 1], ['E5', 1], ['G5', 1], ['C6', 1], ['B5', 1], ['G5', 1], ['E5', 2],
  ['D5', 1], ['F5', 1], ['A5', 1], ['D6', 1], ['C6', 1], ['A5', 1], ['F5', 2],
  ['E5', 1], ['G5', 1], ['C6', 1], ['E6', 2], ['D6', 1], ['C6', 1], ['B5', 1],
  ['A5', 1], ['B5', 1], ['C6', 2], ['G5', 2], ['C6', 2],
];
const INTRO_BASS = ['C3', 'G3', 'C3', 'G3', 'D3', 'A3', 'D3', 'A3', 'C3', 'G3', 'E3', 'G3', 'F3', 'G3', 'C3', 'C3'];
export const INTRO_STEP = 0.135; // seconds per sixteenth

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
    this.loops = null;
    this.musicUntil = 0;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.28;
      this.master.connect(this.ctx.destination);
      this.makeLoops();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.28, this.ctx.currentTime, 0.02);
    try {
      localStorage.setItem('pcoop.muted', m ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  get ready() {
    return !!this.ctx && !this.muted;
  }

  tone(f, dur, { type = 'square', vol = 0.3, slide = 0, delay = 0, attack = 0.005 } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  // ------------------------------------------------------------- music

  /** The full intro tune (first level) or a short sting (later levels). */
  levelStart(full) {
    if (!this.ready) return;
    const s = INTRO_STEP;
    if (!full) {
      ['C5', 'E5', 'G5', 'C6'].forEach((n, i) => this.tone(freq(n), s * 0.9, { delay: i * s, vol: 0.16 }));
      this.tone(freq('C6'), s * 3, { delay: 4 * s, vol: 0.16 });
      this.musicUntil = this.ctx.currentTime + s * 7;
      return;
    }
    let step = 0;
    for (const [n, len] of INTRO_LEAD) {
      this.tone(freq(n), s * len * 0.92, { delay: step * s, vol: 0.15, type: 'square' });
      step += len;
    }
    INTRO_BASS.forEach((n, i) => this.tone(freq(n), s * 1.8, { delay: i * 2 * s, vol: 0.32, type: 'triangle' }));
    this.musicUntil = this.ctx.currentTime + step * s;
  }

  clear() {
    if (!this.ready) return;
    const seq = ['G5', 'C6', 'E6', 'G6', 'E6', 'G6'];
    seq.forEach((n, i) => this.tone(freq(n), 0.14, { delay: i * 0.1, vol: 0.15 }));
    ['C4', 'G3', 'C4'].forEach((n, i) => this.tone(freq(n), 0.25, { delay: i * 0.2, vol: 0.3, type: 'triangle' }));
  }

  // ----------------------------------------------------------- effects

  /** The two-tone chomp, alternating like the arcade "waka-waka". */
  eat() {
    const now = performance.now();
    if (now - this.lastWaka < 105) return;
    this.lastWaka = now;
    this.waka ^= 1;
    if (this.waka) this.tone(560, 0.1, { type: 'triangle', vol: 0.4, slide: -330 });
    else this.tone(230, 0.1, { type: 'triangle', vol: 0.4, slide: 330 });
  }

  power() {
    this.tone(160, 0.25, { type: 'square', vol: 0.15, slide: 500 });
  }

  /** Ghost eaten: a fast rising "bwoop" sweep with a warble, ~0.5 s. */
  ghost() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const lfo = this.ctx.createOscillator();
    const depth = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(1900, t + 0.42);
    lfo.frequency.value = 30;
    depth.gain.value = 60;
    lfo.connect(depth).connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    g.gain.setValueAtTime(0.22, t + 0.38);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g).connect(this.master);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.52);
    lfo.stop(t + 0.52);
  }

  death() {
    if (!this.ready) return;
    // Descending warble spiral, then two pops.
    for (let i = 0; i < 9; i++) {
      const f = 820 * 0.86 ** i;
      this.tone(f, 0.12, { type: 'square', vol: 0.15, slide: -f * 0.45, delay: 0.25 + i * 0.105 });
    }
    this.tone(160, 0.08, { type: 'square', vol: 0.2, slide: 400, delay: 1.3 });
    this.tone(160, 0.08, { type: 'square', vol: 0.2, slide: 400, delay: 1.45 });
  }

  otherDeath() {
    this.tone(600, 0.45, { type: 'triangle', vol: 0.14, slide: -450 });
  }

  join() {
    this.tone(660, 0.1, { type: 'triangle', vol: 0.2 });
    this.tone(990, 0.14, { type: 'triangle', vol: 0.2, delay: 0.09 });
  }

  // ----------------------------------------------------- ambient loops

  makeLoops() {
    const ctx = this.ctx;
    const loop = (type, lfoType) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      const lfo = ctx.createOscillator();
      lfo.type = lfoType;
      const depth = ctx.createGain();
      lfo.connect(depth).connect(osc.frequency);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.master);
      osc.start();
      lfo.start();
      return { osc, lfo, depth, gain };
    };
    this.loops = {
      siren: loop('triangle', 'triangle'),
      fright: loop('square', 'sawtooth'),
      eyes: loop('square', 'sawtooth'),
    };
    const { fright, eyes } = this.loops;
    fright.osc.frequency.value = 230;
    fright.lfo.frequency.value = 7.5;
    fright.depth.gain.value = 110;
    eyes.osc.frequency.value = 1100;
    eyes.lfo.frequency.value = 14;
    eyes.depth.gain.value = 500;
  }

  /**
   * Called every frame. Exactly one loop plays: eyes > frightened > siren.
   * @param s { playing, fright, eyes, progress (0..1 of pellets eaten) }
   */
  updateLoops(s) {
    if (!this.loops) return;
    const t = this.ctx.currentTime;
    const musicPlaying = t < this.musicUntil;
    const want = !s.playing || musicPlaying ? null : s.eyes ? 'eyes' : s.fright ? 'fright' : 'siren';
    const vol = { siren: 0.07, fright: 0.045, eyes: 0.035 };
    for (const [name, l] of Object.entries(this.loops)) {
      l.gain.gain.setTargetAtTime(name === want ? vol[name] : 0, t, 0.03);
    }
    // The siren rises in pitch and speed as the maze empties.
    const p = Math.max(0, Math.min(1, s.progress || 0));
    const siren = this.loops.siren;
    siren.osc.frequency.setTargetAtTime(420 + p * 260, t, 0.2);
    siren.depth.gain.setTargetAtTime(140 + p * 60, t, 0.2);
    siren.lfo.frequency.setTargetAtTime(2.2 + p * 2.2, t, 0.2);
  }
}
