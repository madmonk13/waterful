import { Game, W, H, FRAME, TUNE, drawCase } from './game.js';
import { Sfx } from './audio.js';

const $ = (s) => document.querySelector(s);
const body = document.body;
const cv = $('#cv');
const ctx = cv.getContext('2d');
const cam = $('#cam');
const sfx = new Sfx();

const DEFAULTS = { camera: false, tilt: true, sound: true, camZoom: 1 };
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('bubble-pump') || '{}')); } catch {}
const save = () => { try { localStorage.setItem('bubble-pump', JSON.stringify(settings)); } catch {} };

let game = null;
let view = { k: 1, ox: 0, oy: 0 };

// ---------- menu ----------

for (const key of ['camera', 'tilt', 'sound']) {
  const el = $(`#opt-${key}`);
  el.checked = settings[key];
  el.addEventListener('change', () => { settings[key] = el.checked; save(); });
}
document.querySelectorAll('.game').forEach((b) => b.addEventListener('click', () => start(b.dataset.mode)));

function start(mode) {
  sfx.unlock();
  sfx.muted = !settings.sound;
  if (settings.tilt) enableTilt();
  if (settings.camera && !stream) setCamera(true);
  game = new Game(mode, onEvent);
  window.__game = game; // handy for poking at the sim from devtools
  window.__tune = TUNE;
  body.classList.remove('mode-rings', 'mode-hoops');
  body.classList.add(`mode-${mode}`);
  $('#title').textContent = mode === 'rings' ? 'Ring Toss' : 'Hoops';
  $('#win').hidden = true;
  $('#menu').hidden = true;
  $('#play').hidden = false;
  updateHud();
  syncPills();
  resize();
  wakeLock();
}

$('#btn-home').addEventListener('click', () => {
  game = null;
  $('#play').hidden = true;
  $('#win').hidden = true;
  camPanel.hidden = true;
  $('#menu').hidden = false;
  $('#opt-camera').checked = settings.camera;
  $('#opt-sound').checked = settings.sound;
});
$('#btn-reset').addEventListener('click', () => { game?.reset(); $('#win').hidden = true; updateHud(); });
$('#btn-again').addEventListener('click', () => { game?.reset(); $('#win').hidden = true; updateHud(); });
// Camera pill: turns the see-through case on, then opens/closes its zoom panel.
const camPanel = $('#campanel');
$('#btn-camera').addEventListener('click', () => {
  if (!settings.camera) {
    settings.camera = true;
    save();
    setCamera(true);
    camPanel.hidden = false;
  } else {
    camPanel.hidden = !camPanel.hidden;
  }
  syncPills();
});
$('#cam-off').addEventListener('click', () => {
  settings.camera = false;
  save();
  setCamera(false);
  camPanel.hidden = true;
  syncPills();
});
const zoomInput = $('#cam-zoom');
zoomInput.value = settings.camZoom;
zoomInput.addEventListener('input', () => {
  settings.camZoom = Number(zoomInput.value);
  applyZoom();
});
zoomInput.addEventListener('change', save);
$('#btn-sound').addEventListener('click', () => {
  settings.sound = !settings.sound;
  sfx.unlock();
  sfx.muted = !settings.sound;
  save();
  syncPills();
});

function syncPills() {
  $('#btn-camera').classList.toggle('off', !settings.camera);
  $('#btn-sound').classList.toggle('off', !settings.sound);
}

let lastRingCount = -1;
function updateHud() {
  if (!game) return;
  if (game.mode === 'hoops') {
    $('#score-l').textContent = game.scores[0];
    $('#score-r').textContent = game.scores[1];
    $('#base-label').textContent = `First to ${game.target}`;
  } else {
    $('#score-l').textContent = '';
    $('#score-r').textContent = '';
    const on = game.rings.filter((r) => r.peg).length;
    if (on !== lastRingCount) {
      lastRingCount = on;
      $('#base-label').textContent = on === game.rings.length ? 'All on!' : `${on} / ${game.rings.length} on`;
    }
  }
}

let lastClink = 0;
function onEvent(type, data) {
  if (type === 'catch') {
    const now = performance.now();
    if (now - lastClink > 90) { sfx.clink(); lastClink = now; }
    navigator.vibrate?.(8);
  } else if (type === 'score') {
    sfx.score(data.player);
    navigator.vibrate?.([20, 40, 20]);
    updateHud();
  } else if (type === 'win') {
    setTimeout(() => {
      sfx.win();
      $('#win-msg').textContent = data.player === 0 ? 'Red wins!' : 'Blue wins!';
      $('#win').hidden = false;
    }, 600);
  }
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------- pumps ----------

// Ring Toss has a single pump on the right-hand button; any pump key works it.
const single = () => game && game.pumps.length === 1;
const pumpFor = (side) => (single() ? 0 : side);

function bindPump(el, i) {
  const down = (e) => {
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    if (el.classList.contains('down') || !game) return;
    el.classList.add('down');
    game.press(pumpFor(i));
    sfx.pump(i ? 1 : -1);
    navigator.vibrate?.(12);
  };
  const up = () => {
    if (!el.classList.contains('down')) return;
    el.classList.remove('down');
    game?.release(pumpFor(i));
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
const pumpEls = [$('#pump-l'), $('#pump-r')];
pumpEls.forEach(bindPump);

const KEYS = { KeyA: 0, KeyZ: 0, ArrowLeft: 0, KeyL: 1, Slash: 1, ArrowRight: 1 };
addEventListener('keydown', (e) => {
  const i = KEYS[e.code];
  if (i === undefined || e.repeat || !game) return;
  pumpEls[single() ? 1 : i].classList.add('down');
  game.press(pumpFor(i));
  sfx.unlock();
  sfx.pump(i ? 1 : -1);
});
addEventListener('keyup', (e) => {
  const i = KEYS[e.code];
  if (i === undefined) return;
  pumpEls[single() ? 1 : i].classList.remove('down');
  game?.release(pumpFor(i));
});

// ---------- tilt ----------

const gTarget = { x: 0, y: 1 };
const gCur = { x: 0, y: 1 };
let tiltSign = 0;
let tiltOn = false;

async function enableTilt() {
  if (tiltOn || typeof DeviceMotionEvent === 'undefined') return;
  try {
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') { toast('Tilt is off: motion permission not granted.'); return; }
    }
    addEventListener('devicemotion', onMotion);
    tiltOn = true;
  } catch {
    toast('Tilt is not available here.');
  }
}

function onMotion(e) {
  if (!settings.tilt) return;
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  // Gravity in screen coordinates (x right, y down). Browsers disagree on the sign,
  // so calibrate from the first reading where the phone is clearly upright.
  let gx = -a.x, gy = a.y;
  if (!tiltSign) {
    if (Math.abs(gy) < 4) return;
    tiltSign = gy > 0 ? 1 : -1;
  }
  gx *= tiltSign / 9.81;
  gy *= tiltSign / 9.81;
  // Lying flat there is little in-plane gravity; ease toward straight down so pieces still sink.
  const m = Math.hypot(gx, gy);
  const w = Math.min(1, m / 0.35);
  let dx = m > 1e-3 ? (gx / m) * w : 0, dy = m > 1e-3 ? (gy / m) * w + (1 - w) : 1;
  const l = Math.hypot(dx, dy) || 1;
  const mag = Math.min(1.2, Math.max(0.35, m));
  gTarget.x = (dx / l) * mag;
  gTarget.y = (dy / l) * mag;
}

// ---------- camera ----------

let stream = null;

// Use the camera's own zoom where the browser exposes it (sharper, and some phones can go
// below 1x); make up any remainder by scaling the video element.
let zoomTimer = 0;
function applyZoom() {
  const z = settings.camZoom;
  $('#cam-zoom-val').textContent = `${z.toFixed(1)}×`;
  const track = stream?.getVideoTracks()[0];
  const caps = track?.getCapabilities?.().zoom;
  if (!caps) {
    body.style.setProperty('--cam-zoom', Math.max(1, z));
    return;
  }
  const native = Math.min(caps.max, Math.max(caps.min, z));
  body.style.setProperty('--cam-zoom', Math.max(1, z / native));
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => track.applyConstraints({ advanced: [{ zoom: native }] }).catch(() => {}), 60);
}

async function setCamera(on) {
  if (!on) {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    cam.srcObject = null;
    body.classList.remove('cam-on');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('The camera needs HTTPS (or localhost).');
    settings.camera = false;
    syncPills();
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    cam.srcObject = stream;
    await cam.play().catch(() => {});
    applyZoom();
    body.classList.add('cam-on');
  } catch (err) {
    toast('Camera unavailable — showing the plain case.');
    settings.camera = false;
    save();
    syncPills();
  }
}

// ---------- wake lock ----------

let lock = null;
async function wakeLock() {
  try { lock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && game) wakeLock();
});

// ---------- render loop ----------

const MIN_BASE = 130; // px kept for the button panel on phones

// Phones: no case border, the water runs edge to edge from the top of the screen and the
// button panel takes whatever height is left. Wider screens: framed case on the base.
function resize() {
  const play = $('#play'), stage = $('#stage');
  const bleed = play.clientWidth < 600;
  body.classList.toggle('bleed', bleed);
  let s;
  if (bleed) {
    s = Math.min(play.clientWidth / W, (play.clientHeight - MIN_BASE) / H);
    stage.style.height = `${Math.floor(H * s)}px`;
  } else {
    stage.style.height = '';
  }
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  if (!bleed) s = Math.min((r.width - 16) / (W + FRAME * 2), (r.height - 8) / (H + FRAME));
  view = {
    bleed,
    k: s * dpr,
    ox: (r.width - W * s) / 2 * dpr,
    oy: bleed ? 0 : (r.height - H * s) * dpr,
  };
}
new ResizeObserver(resize).observe($('#play'));

const DT = 1 / 60;
let last = performance.now(), acc = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const el = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!game) return;

  gCur.x += (gTarget.x - gCur.x) * 0.15;
  gCur.y += (gTarget.y - gCur.y) * 0.15;
  game.setGravity(settings.tilt ? gCur.x : 0, settings.tilt ? gCur.y : 1);

  acc += el;
  let n = 0;
  while (acc >= DT && n < 4) { game.step(DT); acc -= DT; n++; }
  if (n === 4) acc = 0;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(view.k, 0, 0, view.k, view.ox, view.oy);
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect && !view.bleed) ctx.roundRect(0, 0, W, H, 16); else ctx.rect(0, 0, W, H);
  ctx.clip();
  game.draw(ctx);
  ctx.restore();
  if (!view.bleed) drawCase(ctx);
  if (game.mode === 'rings') updateHud();
}
requestAnimationFrame(frame);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
