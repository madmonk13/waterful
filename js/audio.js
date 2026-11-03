// Synthesised sound effects; no audio files.

export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  // Must be called from a user gesture (iOS won't start audio otherwise).
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = this.ctx = new AC();
      this.master = ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(ctx.destination);
      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  out(pan) {
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(this.master);
      return p;
    }
    return this.master;
  }

  ok() {
    return this.ctx && !this.muted;
  }

  pump(pan = 0) {
    if (!this.ok()) return;
    const ctx = this.ctx, t = ctx.currentTime, dest = this.out(pan * 0.6);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.exponentialRampToValueAtTime(1100, t + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    src.connect(bp).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.45);
    const n = 6 + (Math.random() * 4 | 0);
    for (let i = 0; i < n; i++) {
      this.blip(t + 0.04 + Math.random() * 0.55, 260 + Math.random() * 700, 0.05 + Math.random() * 0.06, dest);
    }
  }

  blip(t, f, vol, dest = this.master, type = 'sine', rise = 2.2, len = 0.09) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * rise, t + len * 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + len + 0.02);
  }

  clink() {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    this.blip(t, 1500, 0.12, this.master, 'triangle', 1.02, 0.18);
    this.blip(t + 0.05, 2250, 0.07, this.master, 'triangle', 1.02, 0.2);
  }

  score(player) {
    if (!this.ok()) return;
    const t = this.ctx.currentTime, dest = this.out(player ? 0.5 : -0.5);
    [523, 659, 784].forEach((f, i) => this.blip(t + i * 0.08, f, 0.16, dest, 'triangle', 1.0, 0.22));
  }

  win() {
    if (!this.ok()) return;
    const t = this.ctx.currentTime;
    [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.blip(t + i * 0.11, f, 0.18, this.master, 'square', 1.0, 0.16));
  }
}
