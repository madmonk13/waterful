import { Fluid } from './fluid.js';

// World is a fixed 360 x 600 box; the renderer scales it to the screen.
export const W = 360;
export const H = 600;
export const FRAME = 14;

const CELL = 12;
const GRAVITY = 420;        // px/s^2, already net of buoyancy
const PULSE = 0.3;          // seconds a single press keeps pushing
const SUCK = 0.18;          // seconds of back-flow when the button is let go

// Live-tweakable from devtools via window.__tune.
export const TUNE = {
  jet: 24000,      // px/s^2 pushed up the nozzle column at the peak of a pump
  jetRadius: 11,
  source: 3000,    // volume pushed out of the nozzle at the peak
  suck: 0.05,      // back-flow strength after the button is let go, relative to jet
  ringWeight: 0.55, // share of GRAVITY each piece feels underwater
  ballWeight: 0.9,
  ballDrag: 0.02,  // low, so a launched ball carries its momentum in an arc
  kick: 24000,     // px/s^2 the jet applies straight to a ball in its nozzle
  kickReach: 60,
  aimJitter: 0.12, // random spread in jet direction from press to press
  flatten: 3,      // how strongly sinking rings level out (1/s)
  pegShield: 0.6,  // share of upward current a ring already on a peg still feels
};
const AIR_FRACTION = 0.045; // share of the case that is the air pocket
const SPECKS = 130;
const MAX_BUBBLES = 320;
const BUBBLE_PUSH = 18;      // px/s^2 per px of bubble radius that rising bubbles add to the water

const RING_COLORS = ['#3fcf4f', '#2fa8ff', '#ffd23d', '#ff4b4b'];
const RINGS = 12;
const BALLS = 1;
const BALL_R = 9;

export const LAYOUTS = {
  rings: {
    // Classic single-pump arrangement: one nozzle in the bottom-left corner, a ramp that
    // rolls rings back to it, and two pegs at staggered heights right of centre.
    floor: [[0, 540], [40, 568], [360, 488]],
    pumps: [{ x: 40, y: 560, dx: 0.35, dy: -1 }],
    pegs: [{ x: 170, tip: 300, base: 395 }, { x: 252, tip: 255, base: 350 }],
    hoops: [],
  },
  hoops: {
    // Classic arrangement: rails slope in from the walls, a tall peak splits the middle,
    // a nozzle sits in each gap, and two hoops hang up top with backboards on the rear wall.
    floor: [[0, 370], [118, 525], [138, 566], [180, 410], [222, 566], [242, 525], [360, 370]],
    rails: true,
    peak: [[138, 566], [180, 410], [222, 566]],
    pumps: [{ x: 138, y: 560, dx: -0.3, dy: -1 }, { x: 222, y: 560, dx: 0.3, dy: -1 }],
    pegs: [],
    hoops: [
      { l: 56, r: 108, y: 160, board: { top: 92, bot: 170 }, player: 0 },
      { l: 252, r: 304, y: 160, board: { top: 92, bot: 170 }, player: 1 },
    ],
  },
};

// ---------- small geometry helpers ----------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const tmp = { x: 0, y: 0 };
const tmp2 = { x: 0, y: 0 };
const cs = { s: 0, t: 0, x1: 0, y1: 0, x2: 0, y2: 0 };

// Closest points between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9).
function closestSegSeg(p1x, p1y, q1x, q1y, p2x, p2y, q2x, q2y) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d2x = q2x - p2x, d2y = q2y - p2y;
  const rx = p1x - p2x, ry = p1y - p2y;
  const a = d1x * d1x + d1y * d1y, e = d2x * d2x + d2y * d2y, f = d2x * rx + d2y * ry;
  const c = d1x * rx + d1y * ry;
  let s, t;
  if (e <= 1e-9) {
    t = 0;
    s = clamp01(-c / a);
  } else {
    const b = d1x * d2x + d1y * d2y, den = a * e - b * b;
    s = den > 1e-9 ? clamp01((b * f - c * e) / den) : 0;
    t = (b * s + f) / e;
    if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
  }
  cs.s = s; cs.t = t;
  cs.x1 = p1x + d1x * s; cs.y1 = p1y + d1y * s;
  cs.x2 = p2x + d2x * t; cs.y2 = p2y + d2y * t;
}

const pt = (x, y) => ({ x, y, px: x, py: y });

// Verlet step with water drag: velocity relaxes toward the local current.
function integrate(p, f, g, drag, dt) {
  let vx = p.x - p.px, vy = p.y - p.py;
  vx += (f.x * dt - vx) * drag + g.x * dt * dt;
  vy += (f.y * dt - vy) * drag + g.y * dt * dt;
  p.px = p.x; p.py = p.y;
  p.x += vx; p.y += vy;
}

// Push a point out along n and reflect its implied velocity.
function resolve(p, nx, ny, pen, bounce, friction) {
  let vx = p.x - p.px, vy = p.y - p.py;
  p.x += nx * pen; p.y += ny * pen;
  const vn = vx * nx + vy * ny;
  if (vn < 0) {
    vx -= (1 + bounce) * vn * nx;
    vy -= (1 + bounce) * vn * ny;
    vx *= 1 - friction;
    vy *= 1 - friction;
  }
  p.px = p.x - vx; p.py = p.y - vy;
}

function circleVsSeg(p, r, s, bounce) {
  const dx = s.bx - s.ax, dy = s.by - s.ay;
  const t = clamp01(((p.x - s.ax) * dx + (p.y - s.ay) * dy) / (dx * dx + dy * dy));
  let nx = p.x - (s.ax + dx * t), ny = p.y - (s.ay + dy * t);
  const min = r + s.r;
  const d2 = nx * nx + ny * ny;
  if (d2 >= min * min) return;
  const d = Math.sqrt(d2);
  if (d < 1e-6) { nx = 0; ny = -1; } else { nx /= d; ny /= d; }
  resolve(p, nx, ny, min - d, bounce, 0.03);
}

function circleVsCircle(p, r, cx, cy, cr, bounce) {
  let nx = p.x - cx, ny = p.y - cy;
  const min = r + cr, d2 = nx * nx + ny * ny;
  if (d2 >= min * min) return;
  const d = Math.sqrt(d2) || 1e-6;
  nx /= d; ny /= d;
  resolve(p, nx, ny, min - d, bounce, 0.02);
}

// Move a ring's two rim points so the contact point at parameter s shifts by (nx, ny) * pen.
function pushRing(ring, s, nx, ny, pen) {
  const wa = 1 - s, wb = s, k = pen / (wa * wa + wb * wb);
  ring.a.x += nx * wa * k; ring.a.y += ny * wa * k;
  ring.b.x += nx * wb * k; ring.b.y += ny * wb * k;
}

function ringVsSeg(ring, ax, ay, bx, by, r2) {
  const A = ring.a, B = ring.b;
  closestSegSeg(A.x, A.y, B.x, B.y, ax, ay, bx, by);
  let nx = cs.x1 - cs.x2, ny = cs.y1 - cs.y2;
  const min = ring.t + r2, d2 = nx * nx + ny * ny;
  if (d2 >= min * min) return;
  const d = Math.sqrt(d2);
  if (d < 1e-6) {
    nx = -(by - ay); ny = bx - ax;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    if (ny > 0) { nx = -nx; ny = -ny; }
  } else { nx /= d; ny /= d; }
  pushRing(ring, cs.s, nx, ny, min - d);
}

// A ring already on a peg is slippery: a loose ring touching it slides off sideways
// instead of coming to rest on its rim next to the peg.
function ringVsStacked(r, o) {
  closestSegSeg(r.a.x, r.a.y, r.b.x, r.b.y, o.peg.x - o.R, o.cy, o.peg.x + o.R, o.cy);
  const dx = cs.x1 - cs.x2, dy = cs.y1 - cs.y2, min = r.t + o.t;
  if (dx * dx + dy * dy >= min * min) return;
  const mx = (r.a.x + r.b.x) / 2;
  const side = mx === o.peg.x ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(mx - o.peg.x);
  pushRing(r, cs.s, side, 0, 0.8);
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

class Pump {
  constructor(d) {
    const l = Math.hypot(d.dx, d.dy);
    this.x = d.x; this.y = d.y; this.dx = d.dx / l; this.dy = d.dy / l;
    this.baseDx = d.dx; this.baseDy = d.dy;
    this.t = 99;
    this.rt = 99;
    this.down = false;
    this.power = 1;
  }
  // No two thumb presses are quite alike.
  press() {
    this.t = 0;
    this.down = true;
    this.power = 0.8 + Math.random() * 0.4;
    const dx = this.baseDx + (Math.random() - 0.5) * TUNE.aimJitter, l = Math.hypot(dx, this.baseDy);
    this.dx = dx / l;
    this.dy = this.baseDy / l;
  }
  release() { if (this.down) { this.down = false; this.rt = 0; } }
}

// ---------- the game ----------

export class Game {
  constructor(mode, onEvent = () => {}) {
    this.mode = mode;
    this.onEvent = onEvent;
    const L = LAYOUTS[mode];
    this.layout = L;
    this.fluid = new Fluid(W / CELL, H / CELL, CELL);
    this.pumps = L.pumps.map((d) => new Pump(d));
    this.g = { x: 0, y: GRAVITY };
    this.gn = { x: 0, y: 1 };
    this.surfC = 0;
    this.surfTarget = 0;
    this.waveAmp = 0;
    this.time = 0;

    this.segs = [];
    for (let i = 0; i < L.floor.length - 1; i++) {
      const [ax, ay] = L.floor[i], [bx, by] = L.floor[i + 1];
      this.segs.push({ ax, ay, bx, by, r: 0 });
    }
    this.segs.push({ ax: 0, ay: 0, bx: W, by: 0, r: 0 });
    this.segs.push({ ax: 0, ay: 0, bx: 0, by: H, r: 0 });
    this.segs.push({ ax: W, ay: 0, bx: W, by: H, r: 0 });
    this.segs.push({ ax: 0, ay: H, bx: W, by: H, r: 0 });

    this.pegs = L.pegs.map((p) => ({ ...p, r: 2.6 }));

    this.hoops = L.hoops.map((h) => ({ ...h, knob: 3 }));
    this.knobs = [];
    for (const h of this.hoops) {
      this.knobs.push({ x: h.l, y: h.y, r: 3 }, { x: h.r, y: h.y, r: 3 });
    }

    this.scores = [0, 0];
    this.target = 10;
    this.over = false;

    this.bubbles = [];
    this.specks = [];
    for (let i = 0; i < SPECKS; i++) this.specks.push(this.newSpeck({}));
    this.reset();
  }

  floorY(x) {
    const f = this.layout.floor;
    for (let i = 0; i < f.length - 1; i++) {
      const [ax, ay] = f[i], [bx, by] = f[i + 1];
      if (x >= ax && x <= bx) return ay + (by - ay) * ((x - ax) / (bx - ax));
    }
    return H;
  }

  reset() {
    this.fluid.reset();
    this.bubbles.length = 0;
    this.scores = [0, 0];
    this.over = false;
    this.rings = [];
    this.balls = [];
    if (this.mode === 'rings') {
      for (let i = 0; i < RINGS; i++) {
        const color = RING_COLORS[i % RING_COLORS.length];
        const R = 15, x = 30 + ((i * 97) % 300), y = 380 + (i % 4) * 28;
        const ang = (Math.random() - 0.5) * 1.2;
        const c = Math.cos(ang) * R, s = Math.sin(ang) * R;
        this.rings.push({
          a: pt(x - c, y - s), b: pt(x + c, y + s), R, t: 3.6,
          psi: Math.random() * Math.PI, psiV: 0,
          peg: null, cy: 0, vy: 0, vis: 0,
          color, dark: shade(color, 0.6), light: shade(color, 1.35),
        });
      }
    } else {
      for (let i = 0; i < BALLS; i++) {
        const x = 180 + (Math.random() < 0.5 ? -30 : 30) + i * 20, y = 330;
        this.balls.push({ ...pt(x, y), oy: y, r: BALL_R, spin: Math.random() * 6.28, blocked: -1 });
      }
    }
  }

  press(i) { if (this.pumps[i]) { this.pumps[i].press(); this.waveAmp = Math.min(3, this.waveAmp + 1.2); } }
  release(i) { if (this.pumps[i]) this.pumps[i].release(); }

  // gx, gy: gravity direction on screen (unit-ish, from the tilt sensor).
  setGravity(gx, gy) {
    this.g.x = gx * GRAVITY;
    this.g.y = gy * GRAVITY;
    const l = Math.hypot(gx, gy) || 1;
    this.gn.x = gx / l;
    this.gn.y = gy / l;
  }

  // ---------- simulation ----------

  step(dt) {
    this.time += dt;
    const fluid = this.fluid;

    for (const p of this.pumps) {
      if (p.t < PULSE) {
        const s = Math.sin(Math.PI * p.t / PULSE);
        const a = TUNE.jet * p.power * s * dt;
        for (let k = 0; k < 4; k++) {
          const d = 4 + k * 14;
          fluid.splat(p.x + p.dx * d, p.y + p.dy * d, p.dx * a, p.dy * a, TUNE.jetRadius);
        }
        fluid.source(p.x + p.dx * 6, p.y + p.dy * 6, TUNE.source * s, 8);
        const n = 2 + (Math.random() * 3 | 0);
        for (let k = 0; k < n && this.bubbles.length < MAX_BUBBLES; k++) {
          this.bubbles.push({
            x: p.x + (Math.random() - 0.5) * 10, y: p.y - 4,
            r: 1.2 + Math.random() * Math.random() * 4.5,
            ph: Math.random() * 6.28,
          });
        }
      }
      p.t += dt;
      if (p.rt < SUCK && p.t >= PULSE) {
        const a = -TUNE.jet * TUNE.suck * Math.sin(Math.PI * p.rt / SUCK) * dt;
        fluid.splat(p.x + p.dx * 12, p.y + p.dy * 12, p.dx * a, p.dy * a, 14);
      }
      if (p.t >= PULSE) p.rt += dt;
    }

    this.updateSurface(dt);
    this.updateBubbles(dt);
    fluid.step(dt);
    this.updateSpecks(dt);

    if (this.mode === 'rings') this.stepRings(dt);
    else this.stepBalls(dt);
  }

  // Water line is perpendicular to gravity, placed so the air pocket keeps a fixed area.
  updateSurface(dt) {
    const { gn } = this;
    const dots = [0, gn.x * W, gn.x * W + gn.y * H, gn.y * H];
    let lo = Math.min(...dots), hi = Math.max(...dots);
    const want = AIR_FRACTION * W * H;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (this.clipArea(mid, false) < want) lo = mid; else hi = mid;
    }
    this.surfTarget = (lo + hi) / 2;
    if (!this.surfInit) { this.surfC = this.surfTarget; this.surfInit = true; }
    this.surfC += (this.surfTarget - this.surfC) * Math.min(1, dt * 6);
    this.waveAmp *= Math.exp(-dt * 1.5);
  }

  // Clip the case rectangle by the water line. water=true keeps the water side.
  clipPoly(c, water) {
    const { gn } = this;
    const pts = [[0, 0], [W, 0], [W, H], [0, H]];
    const out = [];
    const side = (p) => (water ? 1 : -1) * (p[0] * gn.x + p[1] * gn.y - c);
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      const sa = side(a), sb = side(b);
      if (sa >= 0) out.push(a);
      if ((sa >= 0) !== (sb >= 0)) {
        const t = sa / (sa - sb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, true]);
      }
    }
    return out;
  }

  clipArea(c, water) {
    const p = this.clipPoly(c, water);
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const q = p[i], r = p[(i + 1) % p.length];
      a += q[0] * r[1] - r[0] * q[1];
    }
    return Math.abs(a) / 2;
  }

  inAir(x, y) {
    return x * this.gn.x + y * this.gn.y < this.surfC;
  }

  updateBubbles(dt) {
    const { fluid, gn, bubbles } = this;
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      fluid.sample(b.x, b.y, tmp);
      const rise = 45 + b.r * 26;
      b.ph += dt * (8 + b.r);
      const wob = Math.sin(b.ph) * 14;
      b.x += (tmp.x - gn.x * rise + gn.y * wob) * dt;
      b.y += (tmp.y - gn.y * rise - gn.x * wob) * dt;
      // Rising bubbles drag the water along with them, which keeps the plume going.
      const push = b.r * BUBBLE_PUSH * dt;
      fluid.splat(b.x, b.y, -gn.x * push, -gn.y * push, 8);
      if (this.inAir(b.x, b.y) || b.x < 0 || b.x > W || b.y < 0 || b.y > H) {
        bubbles[i] = bubbles[bubbles.length - 1];
        bubbles.pop();
        this.waveAmp = Math.min(3, this.waveAmp + 0.02);
      }
    }
  }

  newSpeck(s) {
    for (let k = 0; k < 20; k++) {
      s.x = Math.random() * W;
      s.y = Math.random() * H;
      if (!this.inAir(s.x, s.y) && s.y < this.floorY(s.x) - 4) break;
    }
    s.vx = 0; s.vy = 0;
    s.life = 4 + Math.random() * 8;
    s.z = Math.random();
    return s;
  }

  updateSpecks(dt) {
    for (const s of this.specks) {
      this.fluid.sample(s.x, s.y, tmp);
      s.vx = tmp.x; s.vy = tmp.y;
      s.x += tmp.x * dt;
      s.y += tmp.y * dt + 2 * dt;
      s.life -= dt;
      if (s.life <= 0 || s.x < 1 || s.x > W - 1 || s.y < 1 || s.y > this.floorY(s.x) || this.inAir(s.x, s.y)) this.newSpeck(s);
    }
  }

  stepBalls(dt) {
    const { fluid, balls } = this;
    const g = { x: this.g.x * TUNE.ballWeight, y: this.g.y * TUNE.ballWeight };
    for (const b of balls) {
      fluid.sample(b.x, b.y, tmp);
      b.oy = b.y;
      const ox = b.x;
      integrate(b, tmp, this.inAir(b.x, b.y) ? { x: this.g.x * 2.2, y: this.g.y * 2.2 } : g, TUNE.ballDrag, dt);
      b.x += (Math.random() - 0.5) * 0.01; // so nothing balances forever on the centre ridge
      // A ball sitting in a nozzle takes the jet full on and gets flung, not just carried.
      for (const p of this.pumps) {
        if (p.t >= PULSE) continue;
        const rx = b.x - p.x, ry = b.y - p.y;
        const along = rx * p.dx + ry * p.dy, across = Math.abs(rx * p.dy - ry * p.dx);
        if (along > -b.r && along < TUNE.kickReach && across < b.r + 8) {
          const a = TUNE.kick * p.power * Math.sin(Math.PI * p.t / PULSE) * dt * dt;
          b.px -= p.dx * a;
          b.py -= p.dy * a;
        }
      }
      b.spin += (b.x - ox) / b.r;
    }
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        for (const s of this.segs) circleVsSeg(b, b.r, s, 0.35);
        for (const k of this.knobs) circleVsCircle(b, b.r, k.x, k.y, k.r, 0.45);
        for (let j = i + 1; j < balls.length; j++) {
          const c = balls[j];
          let nx = b.x - c.x, ny = b.y - c.y;
          const min = b.r + c.r, d2 = nx * nx + ny * ny;
          if (d2 < min * min) {
            const d = Math.sqrt(d2) || 1e-6, pen = (min - d) / 2;
            nx /= d; ny /= d;
            b.x += nx * pen; b.y += ny * pen;
            c.x -= nx * pen; c.y -= ny * pen;
          }
        }
      }
    }
    if (this.over) return;
    this.hoops.forEach((h, hi) => {
      for (const b of balls) {
        const inside = b.x > h.l + 4 && b.x < h.r - 4;
        if (!inside) { if (b.blocked === hi) b.blocked = -1; continue; }
        if (b.oy >= h.y && b.y < h.y) b.blocked = hi;
        if (b.oy < h.y && b.y >= h.y) {
          if (b.blocked === hi) { b.blocked = -1; continue; }
          this.scores[h.player]++;
          h.swish = 1;
          this.onEvent('score', { player: h.player, scores: this.scores });
          if (this.scores[h.player] >= this.target) {
            this.over = true;
            this.onEvent('win', { player: h.player });
          }
        }
      }
    });
  }

  stepRings(dt) {
    const { fluid, rings, pegs } = this;
    const w = TUNE.ringWeight;
    const g = { x: this.g.x * w, y: this.g.y * w };
    const gAir = { x: this.g.x * 2.2, y: this.g.y * 2.2 };

    for (const r of rings) {
      if (r.peg) {
        const peg = r.peg;
        fluid.sample(peg.x, r.cy, tmp);
        r.vy += g.y * dt;
        // The peg's base plate and the rings below shield a stack from water pushing up.
        const flow = tmp.y < 0 ? tmp.y * TUNE.pegShield : tmp.y;
        r.vy += (flow - r.vy) * (1 - Math.pow(1 - 0.08, dt * 60));
        r.cy += r.vy * dt;
        r.vis *= Math.exp(-dt * 10);
        r.psi *= Math.exp(-dt * 10);
        continue;
      }
      const { a, b } = r;
      const pmx = (a.x + b.x) / 2, pmy = (a.y + b.y) / 2;
      const ga = this.inAir(pmx, pmy) ? gAir : g;
      fluid.sample(a.x, a.y, tmp);
      fluid.sample(b.x, b.y, tmp2);
      const rvx = (a.x - a.px + b.x - b.px) / (2 * dt), rvy = (a.y - a.py + b.y - b.py) / (2 * dt);
      const rel = Math.hypot((tmp.x + tmp2.x) / 2 - rvx, (tmp.y + tmp2.y) / 2 - rvy);
      integrate(a, tmp, ga, 0.08, dt);
      integrate(b, tmp2, ga, 0.08, dt);
      // Tumble around the in-plane axis: driven by swirl, with turbulence when the water is moving.
      // Like a coin dropped in water, a sinking ring flutters but tends to settle flat.
      r.psiV += (fluid.vorticity(pmx, pmy) * 0.7 - r.psiV) * dt * 2 + (Math.random() - 0.5) * rel * 0.003;
      r.psiV -= Math.sin(2 * r.psi) * TUNE.flatten * 2 * dt;
      r.psiV *= 0.985;
      r.psi += r.psiV * dt;
      const tilt = ((a.x - b.x) * this.gn.x + (a.y - b.y) * this.gn.y) * TUNE.flatten * 0.5 * dt;
      a.x -= this.gn.x * tilt; a.y -= this.gn.y * tilt;
      b.x += this.gn.x * tilt; b.y += this.gn.y * tilt;

      // Catch: sinking, hole facing the peg tip, roughly level.
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const level = Math.abs(Math.sin(ang)) < 0.6 && Math.abs(Math.sin(r.psi)) < 0.6;
      if (level && my > pmy) {
        for (const peg of pegs) {
          if (Math.abs(mx - peg.x) < r.R - r.t - peg.r + 1 && my > peg.tip - (r.t + peg.r + 3) && pmy < peg.tip + 4) {
            r.peg = peg;
            r.cy = Math.max(my, peg.tip + 1);
            r.vy = (my - pmy) / dt;
            r.vis = Math.atan2(Math.sin(ang), Math.cos(ang));
            if (Math.abs(r.vis) > Math.PI / 2) r.vis -= Math.sign(r.vis) * Math.PI;
            this.onEvent('catch', {});
            break;
          }
        }
      }
    }

    // Rings on a peg slide along it and stack; ones lifted past the tip float free again.
    for (const peg of pegs) {
      const on = rings.filter((r) => r.peg === peg).sort((p, q) => q.cy - p.cy);
      let floor = peg.base - 3.5;
      for (const r of on) {
        if (r.cy > floor) { r.cy = floor; if (r.vy > 0) r.vy = 0; }
        floor = r.cy - r.t * 1.6;
        if (r.cy < peg.tip - 3) {
          r.peg = null;
          const vy = r.vy * dt;
          r.a.x = peg.x - r.R; r.a.y = r.cy; r.a.px = r.a.x; r.a.py = r.cy - vy;
          r.b.x = peg.x + r.R; r.b.y = r.cy; r.b.px = r.b.x; r.b.py = r.cy - vy;
        }
      }
    }

    const free = rings.filter((r) => !r.peg);
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < free.length; i++) {
        const r = free[i];
        // keep the rim length fixed
        const dx = r.b.x - r.a.x, dy = r.b.y - r.a.y;
        const d = Math.hypot(dx, dy) || 1e-6, diff = (d - 2 * r.R) / d / 2;
        r.a.x += dx * diff; r.a.y += dy * diff;
        r.b.x -= dx * diff; r.b.y -= dy * diff;

        for (const s of this.segs) ringVsSeg(r, s.ax, s.ay, s.bx, s.by, s.r);
        for (const peg of pegs) ringVsSeg(r, peg.x, peg.tip, peg.x, peg.base, peg.r);
        for (const o of rings) {
          if (o.peg) ringVsStacked(r, o);
        }
        for (let j = i + 1; j < free.length; j++) {
          const o = free[j];
          closestSegSeg(r.a.x, r.a.y, r.b.x, r.b.y, o.a.x, o.a.y, o.b.x, o.b.y);
          let nx = cs.x1 - cs.x2, ny = cs.y1 - cs.y2;
          const min = r.t + o.t, d2 = nx * nx + ny * ny;
          if (d2 < min * min) {
            const dd = Math.sqrt(d2);
            if (dd < 1e-6) { nx = 0; ny = -1; } else { nx /= dd; ny /= dd; }
            const pen = (min - dd) / 2;
            pushRing(r, cs.s, nx, ny, pen);
            pushRing(o, cs.t, -nx, -ny, pen);
          }
        }
      }
    }
  }

  // ---------- rendering (world coordinates) ----------

  draw(ctx) {
    const { gn } = this;
    const t = this.time;

    // water body and air pocket
    const water = this.clipPoly(this.surfC, true);
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(140,205,255,0.10)');
    grad.addColorStop(1, 'rgba(40,120,230,0.30)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    water.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fill();

    this.drawSpecks(ctx);

    // back of hoops: board, back half of the rim
    for (const h of this.hoops) {
      // backboard sits on the rear wall, so pieces pass in front of it
      const cx = (h.l + h.r) / 2, bw = (h.r - h.l) + 16;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 2;
      ctx.fillRect(cx - bw / 2, h.board.top, bw, h.board.bot - h.board.top);
      ctx.strokeRect(cx - bw / 2, h.board.top, bw, h.board.bot - h.board.top);
      ctx.strokeRect(cx - 15, h.y - 28, 30, 22);
      ctx.beginPath();
      ctx.ellipse((h.l + h.r) / 2, h.y, (h.r - h.l) / 2, 5, 0, Math.PI, Math.PI * 2);
      ctx.strokeStyle = '#c4481b';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // pegs with the back halves of their rings
    for (const r of this.rings) if (r.peg) this.drawRing(ctx, r, true);
    for (const p of this.pegs) {
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.base + 3, 7, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      const pg = ctx.createLinearGradient(p.x - 3, 0, p.x + 3, 0);
      pg.addColorStop(0, '#dfe8f5');
      pg.addColorStop(0.5, '#ffffff');
      pg.addColorStop(1, '#8fa3bf');
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.moveTo(p.x, p.tip - 6);
      ctx.lineTo(p.x + p.r, p.tip + 4);
      ctx.lineTo(p.x + p.r, p.base);
      ctx.lineTo(p.x - p.r, p.base);
      ctx.lineTo(p.x - p.r, p.tip + 4);
      ctx.closePath();
      ctx.fill();
    }
    for (const r of this.rings) if (r.peg) this.drawRing(ctx, r, false);

    this.drawFloor(ctx);

    for (const r of this.rings) if (!r.peg) this.drawRing(ctx, r, null);
    for (const b of this.balls) this.drawBall(ctx, b);

    // front of hoops: rim and net
    for (const h of this.hoops) this.drawNet(ctx, h);

    // bubbles
    ctx.lineWidth = 1;
    for (const b of this.bubbles) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.stroke();
      if (b.r > 2) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillRect(b.x - b.r * 0.45, b.y - b.r * 0.55, 1.2, 1.2);
      }
    }

    // wavy water line
    const ends = water.filter((p) => p[2]);
    if (ends.length === 2) {
      const [p, q] = ends;
      const n = 28;
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const s = i / n;
        const x = p[0] + (q[0] - p[0]) * s, y = p[1] + (q[1] - p[1]) * s;
        const off = Math.sin(s * 18 + t * 5) * (0.6 + this.waveAmp) + Math.sin(s * 7 - t * 3) * this.waveAmp * 0.8;
        const px = x - gn.x * off, py = y - gn.y * off;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }

  drawSpecks(ctx) {
    ctx.lineCap = 'round';
    for (const s of this.specks) {
      const sp = Math.hypot(s.vx, s.vy);
      const alpha = Math.min(0.55, 0.12 + sp / 500) * (0.5 + s.z * 0.5);
      const len = Math.min(0.06, 6 / (sp + 1)) ;
      ctx.strokeStyle = `rgba(225,245,255,${alpha.toFixed(3)})`;
      ctx.lineWidth = 0.8 + s.z;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * len - 0.3, s.y - s.vy * len);
      ctx.stroke();
    }
  }

  drawFloor(ctx) {
    const f = this.layout.floor;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (const [x, y] of f) ctx.lineTo(x, y);
    ctx.lineTo(W, H);
    ctx.closePath();
    const fg = ctx.createLinearGradient(0, 480, 0, H);
    fg.addColorStop(0, 'rgba(235,245,255,0.75)');
    fg.addColorStop(1, 'rgba(160,190,230,0.85)');
    // Rails are thin clear bars with water visible behind them; only the peak is solid.
    ctx.fillStyle = this.layout.rails ? 'rgba(200,225,255,0.08)' : fg;
    ctx.fill();
    if (this.layout.peak) {
      ctx.beginPath();
      this.layout.peak.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.lineTo(W / 2 + 60, H);
      ctx.lineTo(W / 2 - 60, H);
      ctx.closePath();
      ctx.fillStyle = fg;
      ctx.fill();
      ctx.fillRect(0, 566, W, H - 566);
    }
    ctx.beginPath();
    for (let i = 0; i < f.length; i++) i ? ctx.lineTo(f[i][0], f[i][1]) : ctx.moveTo(f[i][0], f[i][1]);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = this.layout.rails ? 5 : 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    for (const p of this.pumps) {
      const glow = p.t < PULSE ? Math.sin(Math.PI * p.t / PULSE) : 0;
      ctx.fillStyle = '#20324d';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 3, 9, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(160,220,255,${0.4 + glow * 0.6})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // half: true = back half only, false = front half only, null = whole ring
  drawRing(ctx, r, half) {
    let x, y, ang, ry;
    if (r.peg) {
      x = r.peg.x; y = r.cy; ang = r.vis;
      ry = r.R * 0.28;
    } else {
      x = (r.a.x + r.b.x) / 2; y = (r.a.y + r.b.y) / 2;
      ang = Math.atan2(r.b.y - r.a.y, r.b.x - r.a.x);
      ry = r.R * (0.24 + 0.76 * Math.abs(Math.sin(r.psi)));
    }
    const R = r.R, t = r.t;
    const a0 = half === true ? Math.PI : 0;
    const a1 = half === false ? Math.PI : Math.PI * 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.ellipse(0, 0, R, ry, 0, a0, a1);
    ctx.strokeStyle = r.dark;
    ctx.lineWidth = t * 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, -t * 0.3, R, ry, 0, a0, a1);
    ctx.strokeStyle = r.color;
    ctx.lineWidth = t * 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, -t * 0.55, R - 1, Math.max(0.5, ry - 0.5), 0, a0, a1);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.restore();
  }

  // The ball's skin (pebbled orange, black seams) rotates with spin; lighting stays fixed on top.
  drawBall(ctx, b) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.save();
    ctx.rotate(b.spin);
    ctx.drawImage(ballSkin(), -b.r, -b.r, b.r * 2, b.r * 2);
    ctx.restore();
    const g = ctx.createRadialGradient(-b.r * 0.35, -b.r * 0.4, b.r * 0.05, 0, 0, b.r);
    g.addColorStop(0, 'rgba(255,255,255,0.45)');
    g.addColorStop(0.35, 'rgba(255,255,255,0)');
    g.addColorStop(0.8, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(60,20,0,0.45)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawNet(ctx, h) {
    const cx = (h.l + h.r) / 2, hw = (h.r - h.l) / 2;
    h.swish = (h.swish || 0) * 0.94;
    this.fluid.sample(cx, h.y + 14, tmp);
    const sway = Math.max(-6, Math.min(6, tmp.x * 0.03)) + Math.sin(this.time * 30) * h.swish * 3;
    const depth = 26, bw = hw * 0.72;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = 6;
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const tx = h.l + (h.r - h.l) * s;
      const bx = cx - bw + bw * 2 * s + sway;
      ctx.moveTo(tx, h.y + 2);
      ctx.lineTo(bx, h.y + depth);
    }
    for (let k = 1; k <= 3; k++) {
      const f = k / 3, y = h.y + 2 + (depth - 2) * f;
      const w = hw + (bw - hw) * f;
      ctx.moveTo(cx - w + sway * f, y);
      ctx.lineTo(cx + w + sway * f, y);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, h.y, hw, 5, 0, 0, Math.PI);
    ctx.strokeStyle = '#ff6a2a';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

let skin = null;
function ballSkin() {
  if (skin) return skin;
  const S = 128, r = S / 2 - 1;
  skin = document.createElement('canvas');
  skin.width = skin.height = S;
  const c = skin.getContext('2d');
  c.translate(S / 2, S / 2);
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.fillStyle = '#e2661f';
  c.fill();
  c.save();
  c.clip();
  // pebble grain
  for (let i = 0; i < 900; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
    c.fillStyle = Math.random() < 0.5 ? 'rgba(120,40,0,0.18)' : 'rgba(255,170,110,0.18)';
    c.fillRect(Math.cos(a) * d, Math.sin(a) * d, 1.6, 1.6);
  }
  // seams: one around the middle, one through the poles, and the two curved side seams
  c.strokeStyle = '#1b0f08';
  c.lineWidth = S * 0.035;
  c.beginPath();
  c.moveTo(-r, 0);
  c.lineTo(r, 0);
  c.moveTo(0, -r);
  c.lineTo(0, r);
  c.stroke();
  c.beginPath();
  c.arc(-r * 1.32, 0, r * 0.95, -Math.PI / 2, Math.PI / 2);
  c.stroke();
  c.beginPath();
  c.arc(r * 1.32, 0, r * 0.95, Math.PI / 2, Math.PI * 1.5);
  c.stroke();
  c.restore();
  c.beginPath();
  c.arc(0, 0, r - 0.5, 0, Math.PI * 2);
  c.strokeStyle = 'rgba(70,25,5,0.6)';
  c.lineWidth = 1.5;
  c.stroke();
  return skin;
}

// The clear plastic case around the water, drawn on top of the game.
export function drawCase(ctx) {
  const F = FRAME, r = 26;
  const rr = (x, y, w, h, rad) => {
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  };
  ctx.save();
  ctx.beginPath();
  rr(-F, -F, W + F * 2, H + F, r + F * 0.6);
  rr(0, 0, W, H, r * 0.6);
  const g = ctx.createLinearGradient(-F, 0, W + F, 0);
  g.addColorStop(0, 'rgba(210,235,255,0.55)');
  g.addColorStop(0.08, 'rgba(160,205,255,0.28)');
  g.addColorStop(0.92, 'rgba(160,205,255,0.28)');
  g.addColorStop(1, 'rgba(120,170,230,0.55)');
  ctx.fillStyle = g;
  ctx.fill('evenodd');

  ctx.beginPath();
  rr(-F + 1, -F + 1, W + F * 2 - 2, H + F - 2, r + F * 0.6);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  rr(0, 0, W, H, r * 0.6);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // fill plug on top
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  rr(W / 2 - 16, -F - 3, 32, 8, 3);
  ctx.fill();

  // glare streaks across the front face
  ctx.beginPath();
  rr(0, 0, W, H, r * 0.6);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  const gl = ctx.createLinearGradient(0, 0, W, H * 0.6);
  gl.addColorStop(0.0, 'rgba(255,255,255,0)');
  gl.addColorStop(0.18, 'rgba(255,255,255,0.10)');
  gl.addColorStop(0.24, 'rgba(255,255,255,0)');
  gl.addColorStop(0.30, 'rgba(255,255,255,0.05)');
  gl.addColorStop(0.34, 'rgba(255,255,255,0)');
  ctx.fillStyle = gl;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}
