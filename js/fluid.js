// Coarse "stable fluids" velocity solver (Stam 1999) with vorticity confinement.
// Velocities are stored in world units per second; cell (i, j) for i in 1..nx has
// its centre at world ((i - 0.5) * cell, (j - 0.5) * cell).

export class Fluid {
  constructor(nx, ny, cell) {
    this.nx = nx;
    this.ny = ny;
    this.cell = cell;
    this.stride = nx + 2;
    const n = (nx + 2) * (ny + 2);
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.u0 = new Float32Array(n);
    this.v0 = new Float32Array(n);
    this.p = new Float32Array(n);
    this.div = new Float32Array(n);
    this.curl = new Float32Array(n);
    this.src = new Float32Array(n);
    this.srcTotal = 0;
    this.confinement = 6;
    this.halfLife = 1.4;
  }

  reset() {
    this.u.fill(0);
    this.v.fill(0);
    this.curl.fill(0);
  }

  // Add a gaussian blob of velocity change centred on a world point.
  splat(x, y, dvx, dvy, radius) {
    const { nx, ny, cell, stride, u, v } = this;
    const gi = x / cell + 0.5, gj = y / cell + 0.5, gr = radius / cell;
    const i0 = Math.max(1, Math.floor(gi - gr * 2)), i1 = Math.min(nx, Math.ceil(gi + gr * 2));
    const j0 = Math.max(1, Math.floor(gj - gr * 2)), j1 = Math.min(ny, Math.ceil(gj + gr * 2));
    const inv = 1 / (gr * gr);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i - gi, dy = j - gj;
        const w = Math.exp(-(dx * dx + dy * dy) * inv);
        const k = i + stride * j;
        u[k] += dvx * w;
        v[k] += dvy * w;
      }
    }
  }

  // Inject volume at a point (a pump pushing water out of its nozzle). The same volume is
  // removed evenly everywhere else so the closed case stays solvable.
  source(x, y, amount, radius) {
    const { nx, ny, cell, stride, src } = this;
    const gi = x / cell + 0.5, gj = y / cell + 0.5, gr = radius / cell;
    const i0 = Math.max(1, Math.floor(gi - gr * 2)), i1 = Math.min(nx, Math.ceil(gi + gr * 2));
    const j0 = Math.max(1, Math.floor(gj - gr * 2)), j1 = Math.min(ny, Math.ceil(gj + gr * 2));
    const inv = 1 / (gr * gr);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i - gi, dy = j - gj;
        const w = amount * Math.exp(-(dx * dx + dy * dy) * inv);
        src[i + stride * j] += w;
        this.srcTotal += w;
      }
    }
  }

  // Bilinear velocity at a world point. Writes into `out` to avoid allocation.
  sample(x, y, out) {
    const { nx, ny, cell, stride, u, v } = this;
    let gx = x / cell + 0.5, gy = y / cell + 0.5;
    gx = gx < 0.5 ? 0.5 : gx > nx + 0.5 ? nx + 0.5 : gx;
    gy = gy < 0.5 ? 0.5 : gy > ny + 0.5 ? ny + 0.5 : gy;
    const i0 = gx | 0, j0 = gy | 0;
    const s = gx - i0, t = gy - j0;
    const k = i0 + stride * j0;
    const a = (1 - s) * (1 - t), b = s * (1 - t), c = (1 - s) * t, d = s * t;
    out.x = a * u[k] + b * u[k + 1] + c * u[k + stride] + d * u[k + stride + 1];
    out.y = a * v[k] + b * v[k + 1] + c * v[k + stride] + d * v[k + stride + 1];
    return out;
  }

  // Vorticity (1/s) at a world point, nearest cell.
  vorticity(x, y) {
    const { nx, ny, cell, stride } = this;
    const i = Math.min(nx, Math.max(1, Math.round(x / cell + 0.5)));
    const j = Math.min(ny, Math.max(1, Math.round(y / cell + 0.5)));
    return this.curl[i + stride * j] / cell;
  }

  step(dt) {
    this.confine(dt);
    this.project(true);
    this.u0.set(this.u);
    this.v0.set(this.v);
    this.advect(1, this.u, this.u0, dt);
    this.advect(2, this.v, this.v0, dt);
    this.project();
    const damp = Math.exp(-dt * Math.LN2 / this.halfLife);
    const { u, v } = this;
    for (let k = 0; k < u.length; k++) {
      u[k] *= damp;
      v[k] *= damp;
    }
  }

  confine(dt) {
    const { nx, ny, stride, u, v, curl } = this;
    for (let j = 1; j <= ny; j++) {
      for (let i = 1; i <= nx; i++) {
        const k = i + stride * j;
        curl[k] = 0.5 * ((v[k + 1] - v[k - 1]) - (u[k + stride] - u[k - stride]));
      }
    }
    const eps = this.confinement * dt;
    for (let j = 2; j < ny; j++) {
      for (let i = 2; i < nx; i++) {
        const k = i + stride * j;
        const dx = 0.5 * (Math.abs(curl[k + 1]) - Math.abs(curl[k - 1]));
        const dy = 0.5 * (Math.abs(curl[k + stride]) - Math.abs(curl[k - stride]));
        const len = Math.hypot(dx, dy) + 1e-5;
        const w = curl[k];
        u[k] += eps * (dy / len) * w;
        v[k] -= eps * (dx / len) * w;
      }
    }
  }

  advect(b, d, d0, dt) {
    const { nx, ny, stride, u0, v0 } = this;
    const dt0 = dt / this.cell;
    for (let j = 1; j <= ny; j++) {
      for (let i = 1; i <= nx; i++) {
        const k = i + stride * j;
        let x = i - dt0 * u0[k], y = j - dt0 * v0[k];
        x = x < 0.5 ? 0.5 : x > nx + 0.5 ? nx + 0.5 : x;
        y = y < 0.5 ? 0.5 : y > ny + 0.5 ? ny + 0.5 : y;
        const i0 = x | 0, j0 = y | 0;
        const s1 = x - i0, s0 = 1 - s1, t1 = y - j0, t0 = 1 - t1;
        const q = i0 + stride * j0;
        d[k] = s0 * (t0 * d0[q] + t1 * d0[q + stride]) + s1 * (t0 * d0[q + 1] + t1 * d0[q + stride + 1]);
      }
    }
    this.bounds(b, d);
  }

  project(withSources = false) {
    const { nx, ny, stride, u, v, p, div, src } = this;
    const sink = withSources ? this.srcTotal / (nx * ny) : 0;
    for (let j = 1; j <= ny; j++) {
      for (let i = 1; i <= nx; i++) {
        const k = i + stride * j;
        div[k] = -0.5 * (u[k + 1] - u[k - 1] + v[k + stride] - v[k - stride]);
        if (withSources) div[k] += src[k] - sink;
        p[k] = 0;
      }
    }
    if (withSources) { src.fill(0); this.srcTotal = 0; }
    this.bounds(0, div);
    this.bounds(0, p);
    for (let it = 0; it < 20; it++) {
      for (let j = 1; j <= ny; j++) {
        for (let i = 1; i <= nx; i++) {
          const k = i + stride * j;
          p[k] = (div[k] + p[k - 1] + p[k + 1] + p[k - stride] + p[k + stride]) * 0.25;
        }
      }
      this.bounds(0, p);
    }
    for (let j = 1; j <= ny; j++) {
      for (let i = 1; i <= nx; i++) {
        const k = i + stride * j;
        u[k] -= 0.5 * (p[k + 1] - p[k - 1]);
        v[k] -= 0.5 * (p[k + stride] - p[k - stride]);
      }
    }
    this.bounds(1, u);
    this.bounds(2, v);
  }

  // b = 1: horizontal component (negated at side walls); b = 2: vertical (negated top/bottom).
  bounds(b, x) {
    const { nx, ny, stride } = this;
    for (let j = 1; j <= ny; j++) {
      const r = stride * j;
      x[r] = b === 1 ? -x[r + 1] : x[r + 1];
      x[r + nx + 1] = b === 1 ? -x[r + nx] : x[r + nx];
    }
    const top = stride * (ny + 1);
    for (let i = 1; i <= nx; i++) {
      x[i] = b === 2 ? -x[i + stride] : x[i + stride];
      x[top + i] = b === 2 ? -x[top - stride + i] : x[top - stride + i];
    }
    x[0] = 0.5 * (x[1] + x[stride]);
    x[nx + 1] = 0.5 * (x[nx] + x[nx + 1 + stride]);
    x[top] = 0.5 * (x[top + 1] + x[top - stride]);
    x[top + nx + 1] = 0.5 * (x[top + nx] + x[top - stride + nx + 1]);
  }
}
