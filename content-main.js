// content-main.js — MAIN world (shares the page's window with A-Frame/THREE).
//  - discover(): dump candidate controller entities
//  - test(): sine "punch" motion, no camera
//  - pose path: map webcam pose -> entity positions
//  - floating in-page panel: bind controllers / toggle pose / tune scale
// Everything is also on window.__mr for console use.

(() => {
  const DEFAULTS = {
    selectorRight: null,
    selectorLeft: null,
    scaleX: 1.2,
    scaleY: 0.8,
    offsetY: 1.1,
    planeZ: -0.6,
    mirror: true,
    smoothing: 0.4,
    log: false,
  };
  const CFG = { ...DEFAULTS };

  const state = {
    poseEnabled: false,
    testRAF: null,
    smoothed: {},
    bound: { Left: null, Right: null }, // direct element refs (take priority)
    lastDiscover: [],
    poseCount: 0,
    calibrating: false,
    calib: null,
  };

  // Desired TOTAL world travel that a full comfortable sweep should map to.
  // (Just a sane starting point — fine-tune with the sliders afterwards.)
  const TARGET_X = 1.6, TARGET_Y = 1.1;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- persistence (page-origin localStorage; fine in a real extension) ----
  const LS_KEY = '__mr_cfg_v1';
  const PERSIST = ['selectorRight','selectorLeft','scaleX','scaleY','offsetY','planeZ','mirror','smoothing'];
  function persist() {
    try {
      const o = {};
      for (const k of PERSIST) o[k] = CFG[k];
      localStorage.setItem(LS_KEY, JSON.stringify(o));
    } catch {}
  }
  function restore() {
    try {
      const o = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (o) Object.assign(CFG, o);
    } catch {}
  }
  restore();

  const sceneEl = () => document.querySelector('a-scene');
  function getEntity(sel) {
    if (!sel) return null;
    try { return document.querySelector(sel); } catch { return null; }
  }
  function getTarget(side) {
    const b = state.bound[side];
    if (b && b.isConnected) return b;
    return getEntity(side === 'Left' ? CFG.selectorLeft : CFG.selectorRight);
  }
  function applyToTarget(side, p) {
    const el = getTarget(side);
    if (!el || !el.object3D) return false;
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return false;
    el.object3D.position.set(p.x, p.y, p.z);
    return true;
  }

  // ---- DISCOVERY ----------------------------------------------------------
  function discover() {
    const scene = sceneEl();
    if (!scene) { console.warn('[__mr] no <a-scene> yet'); return []; }
    const hints = ['controller','hand','punch','tracked-controls','laser-controls','saber','blade','cursor'];
    const rows = [];
    for (const el of scene.querySelectorAll('*')) {
      const comps = el.components ? Object.keys(el.components) : [];
      const hay = ((el.id||'') + ' ' + (el.className||'') + ' ' + comps.join(' ')).toLowerCase();
      if (hints.some((h) => hay.includes(h))) {
        rows.push({
          el,
          id: el.id || '',
          label: (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\s+/)[0] : ''))
                 + (comps.length ? '  [' + comps.slice(0,3).join(',') + ']' : ''),
        });
      }
    }
    state.lastDiscover = rows;
    console.table(rows.map((r) => ({ label: r.label, id: r.id })));
    refreshSelects();
    return rows;
  }

  // ---- SINE SELF-TEST -----------------------------------------------------
  function test(on = true) {
    if (!on) { if (state.testRAF) cancelAnimationFrame(state.testRAF); state.testRAF = null; return; }
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      const punch = (ph) => ({
        x: CFG.scaleX * 0.3 * Math.sin(t * 2 + ph),
        y: CFG.offsetY + 0.2 * Math.sin(t * 3 + ph),
        z: CFG.planeZ + 0.35 * Math.sin(t * 4 + ph),
      });
      applyToTarget('Right', punch(0));
      applyToTarget('Left', punch(Math.PI));
      state.testRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  // ---- POSE PATH ----------------------------------------------------------
  function mapHandToPosition(hand) {
    const c = hand.middleMcp || hand.wrist;
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
    let nx = c.x;
    const ny = c.y;
    if (CFG.mirror) nx = 1 - nx;
    const x = (nx - 0.5) * CFG.scaleX;
    const y = (0.5 - ny) * CFG.scaleY + CFG.offsetY;
    let z = CFG.planeZ;
    if (hand.wrist && hand.indexMcp) {
      const span = Math.hypot(hand.wrist.x - hand.indexMcp.x, hand.wrist.y - hand.indexMcp.y);
      z = CFG.planeZ + (span - 0.12) * 1.5;
    }
    return { x, y, z };
  }
  function lowpass(key, target) {
    const a = CFG.smoothing;
    const prev = state.smoothed[key] || target;
    const next = {
      x: prev.x + (target.x - prev.x) * (1 - a),
      y: prev.y + (target.y - prev.y) * (1 - a),
      z: prev.z + (target.z - prev.z) * (1 - a),
    };
    state.smoothed[key] = next;
    return next;
  }
  function onPose(e) {
    state.poseCount++;
    const hands = e.detail || [];
    if (state.calibrating) sampleCalib(hands);
    if (!state.poseEnabled) return;
    for (const hand of hands) {
      const raw = mapHandToPosition(hand);
      if (!raw) continue;
      const p = lowpass(hand.handedness, raw);
      applyToTarget(hand.handedness, p);
      if (CFG.log) console.log('[__mr]', hand.handedness, p);
    }
  }
  window.addEventListener('moonrider:pose', onPose);

  function poseStart() { state.poseEnabled = true; syncPanel(); }
  function poseStop() { state.poseEnabled = false; syncPanel(); }
  function setSelectors(right, left) {
    CFG.selectorRight = right; CFG.selectorLeft = left;
    state.bound.Right = null; state.bound.Left = null; // strings take over
    persist(); refreshSelects();
  }

  // ---- CALIBRATION --------------------------------------------------------
  function sampleCalib(hands) {
    const c = state.calib;
    for (const h of hands) {
      const pt = h.middleMcp || h.wrist;
      if (!pt || !Number.isFinite(pt.x)) continue;
      const nx = CFG.mirror ? 1 - pt.x : pt.x;
      const ny = pt.y;
      const b = c[h.handedness];
      if (!b) continue;
      b.minX = Math.min(b.minX, nx); b.maxX = Math.max(b.maxX, nx);
      b.minY = Math.min(b.minY, ny); b.maxY = Math.max(b.maxY, ny);
      c.samples++;
    }
  }
  function calibrate(sec = 4) {
    const blank = () => ({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    state.calib = { Left: blank(), Right: blank(), samples: 0 };
    state.calibrating = true;
    let left = sec;
    calibStatus(`揮動雙臂到最大範圍… ${left}s`);
    const iv = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(iv); finishCalib(); }
      else calibStatus(`揮動雙臂到最大範圍… ${left}s`);
    }, 1000);
  }
  function finishCalib() {
    state.calibrating = false;
    const c = state.calib;
    const rng = (b) => ({ x: b.maxX - b.minX, y: b.maxY - b.minY });
    const L = rng(c.Left), R = rng(c.Right);
    const rangeX = Math.max(L.x || 0, R.x || 0);
    const rangeY = Math.max(L.y || 0, R.y || 0);
    if (c.samples < 8 || rangeX < 0.05) {
      calibStatus('沒收到足夠資料 — 先用工具列圖示開相機,再揮大一點', true);
      return;
    }
    CFG.scaleX = clamp(+(TARGET_X / rangeX).toFixed(2), 0.2, 5);
    CFG.scaleY = clamp(+(TARGET_Y / Math.max(rangeY, 0.05)).toFixed(2), 0.2, 4);
    persist();
    syncScaleSliders();
    calibStatus(`完成 ✓  scaleX=${CFG.scaleX}  scaleY=${CFG.scaleY}`);
  }
  function calibStatus(msg) { if (els.calst) els.calst.textContent = msg; }

  // ---- FLOATING PANEL (Shadow DOM) ---------------------------------------
  let root = null, els = {};
  function buildPanel() {
    if (document.getElementById('__mr_panel_host')) return;
    const host = document.createElement('div');
    host.id = '__mr_panel_host';
    host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
<style>
  :host{ all:initial; }
  *{ box-sizing:border-box; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .panel{ width:266px; background:#15171c; color:#cdd6e0; border:1px solid #2a2e37;
          border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.5); font-size:12px; overflow:hidden; }
  .hd{ display:flex; align-items:center; gap:8px; padding:8px 10px; background:#1c1f26; cursor:move; user-select:none; }
  .hd .t{ font-weight:600; flex:1; } .hd .v{ color:#7f8794; font-size:11px; }
  .dot{ width:9px;height:9px;border-radius:50%;background:#555; } .dot.on{ background:#5fdb7a; }
  .bd{ padding:10px; display:flex; flex-direction:column; gap:12px; }
  .sec{ display:flex; flex-direction:column; gap:6px; }
  .sec h4{ margin:0; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:#7f8794; }
  .row{ display:flex; align-items:center; gap:8px; }
  .row label{ width:60px; color:#9aa3b0; } .row input[type=range]{ flex:1; }
  .row .v{ width:40px; text-align:right; color:#e6ebf2; }
  select{ width:100%; background:#0e1014; color:#cdd6e0; border:1px solid #2a2e37; border-radius:6px; padding:4px 6px; font-size:11px; }
  button{ background:#2563eb; color:#fff; border:0; border-radius:6px; padding:6px 8px; cursor:pointer; font-size:12px; }
  button.s2{ background:#333a45; } button.danger{ background:#b4434b; }
  button.toggle.on{ background:#2e9e57; }
  .btns{ display:flex; gap:6px; } .btns button{ flex:1; }
  .mini{ padding:2px 8px; }
  details summary{ color:#6b7480; font-size:10px; cursor:pointer; }
  .hint{ color:#6b7480; font-size:10px; line-height:1.4; }
</style>
<div class="panel">
  <div class="hd" id="hd"><span class="dot" id="dot"></span><span class="t">Moon Rider Ctrl</span><span class="v" id="pfps">0/s</span><button class="s2 mini" id="min">–</button></div>
  <div class="bd" id="bd">
    <div class="sec">
      <h4>Controllers</h4>
      <button class="s2" id="disc">Discover entities</button>
      <div class="row"><label>Right</label><select id="selR"></select></div>
      <div class="row"><label>Left</label><select id="selL"></select></div>
    </div>
    <div class="sec">
      <h4>Pose</h4>
      <button class="toggle" id="pose">Start pose</button>
      <div class="hint">相機由工具列圖示開啟。此處控制是否把手勢套到控制器。</div>
    </div>
    <div class="sec">
      <h4>Scale / feel</h4>
      <div class="row"><label>scaleX</label><input type="range" id="sx" min="0.2" max="5" step="0.1"><span class="v" id="sxv"></span></div>
      <div class="row"><label>scaleY</label><input type="range" id="sy" min="0.2" max="4" step="0.1"><span class="v" id="syv"></span></div>
      <div class="row"><label>smooth</label><input type="range" id="sm" min="0" max="0.9" step="0.05"><span class="v" id="smv"></span></div>
      <div class="row"><label>height</label><input type="range" id="oy" min="0.5" max="2" step="0.05"><span class="v" id="oyv"></span></div>
      <details>
        <summary>advanced</summary>
        <div class="row" style="margin-top:6px"><label>planeZ</label><input type="range" id="pz" min="-1.5" max="0" step="0.05"><span class="v" id="pzv"></span></div>
        <div class="row"><label>mirror</label><input type="checkbox" id="mir" style="margin-right:auto"></div>
      </details>
      <button class="s2" id="calib">Calibrate (4s)</button>
      <div class="hint" id="calst">張臂揮動,自動回推 scaleX / scaleY</div>
    </div>
    <div class="btns"><button class="s2" id="test">Test motion</button><button class="danger" id="reset">Reset</button></div>
  </div>
</div>`;
    (document.body || document.documentElement).appendChild(host);

    const $ = (id) => root.getElementById(id);
    els = {
      host, hd:$('hd'), bd:$('bd'), min:$('min'), dot:$('dot'), pfps:$('pfps'),
      disc:$('disc'), selR:$('selR'), selL:$('selL'), pose:$('pose'),
      sx:$('sx'), sy:$('sy'), sm:$('sm'), oy:$('oy'), pz:$('pz'), mir:$('mir'),
      sxv:$('sxv'), syv:$('syv'), smv:$('smv'), oyv:$('oyv'), pzv:$('pzv'),
      test:$('test'), reset:$('reset'),
      calib:$('calib'), calst:$('calst'),
    };

    // sliders
    const bindSlider = (input, valEl, key) => {
      input.value = CFG[key];
      valEl.textContent = (+CFG[key]).toFixed(2);
      input.oninput = () => { CFG[key] = +input.value; valEl.textContent = (+input.value).toFixed(2); persist(); };
    };
    bindSlider(els.sx, els.sxv, 'scaleX');
    bindSlider(els.sy, els.syv, 'scaleY');
    bindSlider(els.sm, els.smv, 'smoothing');
    bindSlider(els.oy, els.oyv, 'offsetY');
    bindSlider(els.pz, els.pzv, 'planeZ');
    els.mir.checked = !!CFG.mirror;
    els.mir.onchange = () => { CFG.mirror = els.mir.checked; persist(); };

    // discover + selects
    els.disc.onclick = () => discover();
    const onSel = (sel, side) => () => {
      const idx = sel.value;
      if (idx === '') { state.bound[side] = null; if (side==='Left') CFG.selectorLeft=null; else CFG.selectorRight=null; }
      else {
        const row = state.lastDiscover[+idx];
        if (row) { state.bound[side] = row.el; const s = row.id ? '#'+row.id : null; if (side==='Left') CFG.selectorLeft=s; else CFG.selectorRight=s; }
      }
      persist();
    };
    els.selR.onchange = onSel(els.selR, 'Right');
    els.selL.onchange = onSel(els.selL, 'Left');

    // pose toggle
    els.pose.onclick = () => { state.poseEnabled ? poseStop() : poseStart(); };

    // calibrate
    els.calib.onclick = () => calibrate(4);

    // test / reset
    els.test.onclick = () => {
      if (state.testRAF) { test(false); els.test.classList.remove('on'); }
      else { test(true); els.test.classList.add('on'); }
    };
    els.reset.onclick = () => {
      Object.assign(CFG, DEFAULTS);
      state.bound = { Left:null, Right:null };
      bindSlider(els.sx, els.sxv, 'scaleX'); bindSlider(els.sy, els.syv, 'scaleY');
      bindSlider(els.sm, els.smv, 'smoothing'); bindSlider(els.oy, els.oyv, 'offsetY');
      bindSlider(els.pz, els.pzv, 'planeZ'); els.mir.checked = !!CFG.mirror;
      refreshSelects(); persist();
    };

    // collapse
    els.min.onclick = () => {
      const hidden = els.bd.style.display === 'none';
      els.bd.style.display = hidden ? '' : 'none';
      els.min.textContent = hidden ? '–' : '+';
    };

    // drag
    let drag = null;
    els.hd.addEventListener('mousedown', (e) => {
      if (e.target === els.min) return;
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      host.style.left = (e.clientX - drag.dx) + 'px';
      host.style.top = (e.clientY - drag.dy) + 'px';
      host.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { drag = null; });

    // keep keystrokes in inputs from reaching the game's key handlers
    for (const ev of ['keydown','keyup','keypress']) host.addEventListener(ev, (e) => e.stopPropagation());

    // hotkey: Ctrl+Shift+M toggles visibility
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        host.style.display = host.style.display === 'none' ? '' : 'none';
      }
    });

    refreshSelects();
    syncPanel();
    // pose-rate indicator
    setInterval(() => {
      if (!els.pfps) return;
      els.pfps.textContent = state.poseCount + '/s';
      els.dot.classList.toggle('on', state.poseCount > 0);
      state.poseCount = 0;
    }, 1000);
  }

  function refreshSelects() {
    if (!els.selR) return;
    for (const [sel, side] of [[els.selR,'Right'],[els.selL,'Left']]) {
      const cur = state.bound[side];
      const curSel = side==='Left' ? CFG.selectorLeft : CFG.selectorRight;
      sel.innerHTML = '<option value="">— none —</option>' +
        state.lastDiscover.map((r,i)=>`<option value="${i}">${r.label}</option>`).join('');
      let chosen = '';
      state.lastDiscover.forEach((r,i)=>{ if (r.el===cur || (curSel && '#'+r.id===curSel)) chosen=String(i); });
      sel.value = chosen;
    }
  }
  function syncPanel() {
    if (!els.pose) return;
    els.pose.textContent = state.poseEnabled ? 'Stop pose' : 'Start pose';
    els.pose.classList.toggle('on', state.poseEnabled);
  }
  function syncScaleSliders() {
    if (!els.sx) return;
    els.sx.value = CFG.scaleX; els.sxv.textContent = (+CFG.scaleX).toFixed(2);
    els.sy.value = CFG.scaleY; els.syv.textContent = (+CFG.scaleY).toFixed(2);
  }

  window.__mr = {
    cfg: CFG, discover, test, poseStart, poseStop, setSelectors, calibrate,
    panel: buildPanel, _state: state,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel);
  else buildPanel();

  console.log('[__mr] ready — floating panel injected (Ctrl+Shift+M to toggle).');
})();
