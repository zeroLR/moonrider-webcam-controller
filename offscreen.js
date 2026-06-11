// offscreen.js — PoseLandmarker version.
// Why pose instead of hand: the wrist sides are anatomically anchored
// (15 = left wrist, 16 = right wrist) by the body skeleton, so they DON'T
// swap the way HandLandmarker's per-hand left/right classifier does.
// We still emit the same POSE payload shape (handedness Left/Right) so
// content-main.js is unchanged.

import {
  FilesetResolver,
  PoseLandmarker,
} from './vendor/tasks-vision/vision_bundle.mjs';

const WASM_ROOT = chrome.runtime.getURL('vendor/tasks-vision/wasm');
const MODEL_URL = chrome.runtime.getURL('vendor/models/pose_landmarker_lite.task');

const VIS_MIN = 0.5; // ignore a wrist below this visibility (out of frame / occluded)

// Upper-body + arm + hand-stub connections (we skip legs/face for a clean view).
const CONNECTIONS = [
  [11, 12],                          // shoulders
  [11, 13], [13, 15],                // left arm
  [12, 14], [14, 16],                // right arm
  [15, 17], [15, 19], [15, 21],      // left hand stubs
  [16, 18], [16, 20], [16, 22],      // right hand stubs
];
const SIDE = { Left: '#33e0ff', Right: '#ff9a3c' };

let pl = null, video, canvas, ctx, stream, rafId, lastVideoTime = -1;

// diagnostics
let frameTimes = [];
let lastWrist = {};      // 'Left'/'Right' -> {x,y}
let dropFrames = 0, jumpFrames = 0, lastHudPaint = 0;

const $hud = () => document.getElementById('hud');

async function init() {
  $hud().textContent = 'loading pose model…';
  const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
  pl = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  video = document.getElementById('cam');
  canvas = document.getElementById('overlay');
  ctx = canvas.getContext('2d');
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, frameRate: 30 },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  loop();
}

function loop() {
  rafId = requestAnimationFrame(loop);
  if (!pl || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const now = performance.now();
  const res = pl.detectForVideo(video, now);
  const pose = res.landmarks?.[0] || null;        // 33 normalized image points, or null
  const world = res.worldLandmarks?.[0] || null;  // same 33 points, metric, hip-origin

  frameTimes.push(now);
  while (frameTimes.length && now - frameTimes[0] > 1000) frameTimes.shift();
  const fps = frameTimes.length;

  draw(pose);
  const stats = analyze(pose, world);
  if (now - lastHudPaint > 100) { paintHud(fps, pose, stats); lastHudPaint = now; }

  // Build the POSE payload. Side is fixed by landmark index — never reclassified.
  const hands = [];
  if (pose) {
    const add = (wi, ii, side) => {
      const w = pose[wi];
      if (!w || (w.visibility ?? 1) < VIS_MIN) return; // drop unreliable wrist
      // worldLandmarks z = metric depth (hip-origin); the real depth source, so
      // content-main no longer has to fake it from apparent hand size.
      const ww = world ? world[wi] : null;
      hands.push({
        handedness: side, wrist: w, indexMcp: pose[ii] || w, middleMcp: w,
        wz: ww && Number.isFinite(ww.z) ? ww.z : undefined, t: now,
      });
    };
    add(15, 19, 'Left');   // person's left wrist  -> left controller
    add(16, 20, 'Right');  // person's right wrist -> right controller
  }
  if (hands.length) chrome.runtime.sendMessage({ type: 'POSE', hands });
}

function draw(pose) {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!pose) return;
  const colorOf = (a, b) =>
    [13, 15, 17, 19, 21].includes(a) || [13, 15, 17, 19, 21].includes(b)
      ? SIDE.Left
      : [14, 16, 18, 20, 22].includes(a) || [14, 16, 18, 20, 22].includes(b)
        ? SIDE.Right
        : '#8893a0';
  ctx.lineWidth = 3;
  for (const [a, b] of CONNECTIONS) {
    const pa = pose[a], pb = pose[b];
    if (!pa || !pb) continue;
    ctx.strokeStyle = colorOf(a, b);
    ctx.beginPath();
    ctx.moveTo(pa.x * W, pa.y * H);
    ctx.lineTo(pb.x * W, pb.y * H);
    ctx.stroke();
  }
  // Highlight the two wrists — these are the points that drive the controllers.
  for (const [i, side] of [[15, 'Left'], [16, 'Right']]) {
    const p = pose[i];
    if (!p) continue;
    const dim = (p.visibility ?? 1) < VIS_MIN;
    ctx.fillStyle = dim ? '#555' : SIDE[side];
    ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 9, 0, 7); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }
}

function analyze(pose, world) {
  if (!pose) { dropFrames++; return {}; }
  const out = {};
  for (const [i, side] of [[15, 'Left'], [16, 'Right']]) {
    const p = pose[i];
    if (!p) continue;
    const vis = p.visibility ?? 1;
    const prev = lastWrist[side];
    const d = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) : 0;
    if (d > 0.08) jumpFrames++;
    const wz = world && world[i] ? world[i].z : undefined;
    out[side] = { x: p.x, y: p.y, vis, d, active: vis >= VIS_MIN, wz };
    lastWrist[side] = { x: p.x, y: p.y };
  }
  return out;
}

function paintHud(fps, pose, stats) {
  const fpsCls = fps >= 24 ? 'ok' : fps >= 15 ? 'warn' : 'bad';
  const L = [];
  L.push(`<span class="${fpsCls}">FPS ${fps}</span>   pose ${pose ? 1 : 0}   `
       + `drops ${dropFrames}   jumps ${jumpFrames}`);
  if (!pose) L.push('<span class="bad">NO BODY DETECTED — 確認上半身(含肩膀)有入鏡</span>');
  for (const side of ['Left', 'Right']) {
    const j = stats[side];
    if (!j) { L.push(`${side.padEnd(5)} <span class="dim">—</span>`); continue; }
    const vCls = j.vis >= 0.7 ? 'ok' : j.vis >= VIS_MIN ? 'warn' : 'bad';
    const dCls = j.d > 0.08 ? 'bad' : j.d > 0.03 ? 'warn' : 'ok';
    const tag = j.active ? '' : ' <span class="bad">(dropped)</span>';
    const zStr = Number.isFinite(j.wz) ? `  z ${j.wz.toFixed(2)}m` : '';
    L.push(`${side.padEnd(5)} vis <span class="${vCls}">${j.vis.toFixed(2)}</span>  `
         + `norm(${j.x.toFixed(3)}, ${j.y.toFixed(3)})${zStr}  `
         + `Δ <span class="${dCls}">${(j.d * 640) | 0}px</span>${tag}`);
  }
  L.push('<span class="dim">─────────────────────────────</span>');
  L.push('<span class="dim">用 pose:左右由骨架錨定,不會再互換。判讀:</span>');
  L.push('<span class="dim"> vis 掉到紅 / Δ 跳紅 → 手腕出框或被遮 → 拉遠鏡頭、讓上半身完整入鏡</span>');
  L.push('<span class="dim"> vis 綠且 Δ 綠 但控制器仍飛 → 問題在 content-main 映射/smoothing/depth</span>');
  $hud().innerHTML = L.join('\n');
}

function teardown() {
  if (rafId) cancelAnimationFrame(rafId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  pl?.close?.();
}
window.addEventListener('pagehide', teardown);

init().catch((e) => {
  $hud().innerHTML = '<span class="bad">init failed: ' + e + '</span>';
  console.error('[offscreen] init failed:', e);
});
