// joycon.js — WebHID Joy-Con reader, runs INSIDE the popup window (offscreen.html).
// Joy-Con is a Bluetooth *Classic* HID device: navigator.bluetooth (GATT) can't
// see its input — navigator.hid can. We pair (OS-level), open the device under a
// user gesture, switch it to the standard full report (0x30) with IMU on, then
// fuse accel+gyro into an orientation quaternion. Each Joy-Con is its own HID
// device, so Left/Right are physically separate — none of the camera's L/R-swap
// problem. We emit one {type:'JOYCON', controller} per report on the SAME relay
// the camera uses (chrome.runtime.sendMessage -> background -> tab). Position is
// still the camera's job; the Joy-Con owns orientation + hit timing.
//
// IMU axis frame: we keep the sensor's own raw-scaled axes (gyro deg/s, accel g)
// and let the Madgwick filter define a self-consistent frame per controller
// (gravity from accel fixes pitch/roll; yaw has no magnetometer so it drifts —
// that's why content-main has a Re-center). Aligning that frame to the game's
// axes is done downstream by re-center, not here.

(() => {
  const VENDOR_NINTENDO = 0x057e;
  const PRODUCT = { 0x2006: 'Left', 0x2007: 'Right' }; // Joy-Con (L) / (R)

  // ---- IMU scaling (per Joy-Con reverse-engineering notes) ----
  const ACC_G = 0.000244;        // g per LSB
  const GYRO_DPS = 0.06103;      // deg/s per LSB
  const DEG2RAD = Math.PI / 180;
  const DT = 0.005;              // each report carries 3 IMU subframes @ 5 ms
  const BETA = 0.08;             // Madgwick gain (accel pull vs gyro trust)

  // Neutral rumble payload — must prefix every subcommand output report.
  const NEUTRAL_RUMBLE = [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40];

  const controllers = new Map(); // device -> state

  // ---------- small UI in the popup ----------
  let ui = null;
  function ensureUi() {
    if (ui) return ui;
    const box = document.createElement('div');
    box.id = 'jc';
    box.style.cssText =
      'padding:8px 12px;border-top:1px solid #23262e;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#cdd6e0;';
    box.innerHTML =
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<button id="jc-connect" style="background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit">Connect Joy-Con</button>' +
      '<span id="jc-status" style="color:#6b7480">no Joy-Con — 先按側邊 sync 鈕配對,再點此</span>' +
      '</div>' +
      '<div id="jc-lines" style="margin-top:6px;white-space:pre"></div>';
    document.body.appendChild(box);
    ui = {
      box,
      btn: box.querySelector('#jc-connect'),
      status: box.querySelector('#jc-status'),
      lines: box.querySelector('#jc-lines'),
    };
    ui.btn.addEventListener('click', requestDevices);
    return ui;
  }
  function paintUi() {
    const u = ensureUi();
    const n = controllers.size;
    u.status.textContent = n
      ? `${n} connected`
      : 'no Joy-Con — 先按側邊 sync 鈕配對,再點此';
    u.status.style.color = n ? '#5fdb7a' : '#6b7480';
    const rows = [];
    for (const st of controllers.values()) {
      rows.push(
        `${st.side.padEnd(5)} gyro ${Math.round(st.gyroMag)
          .toString()
          .padStart(4)}°/s  acc ${st.accelMag.toFixed(2)}g  rep ${st.reports}`
      );
    }
    u.lines.textContent = rows.join('\n');
  }

  // ---------- connect / init ----------
  async function requestDevices() {
    try {
      const devices = await navigator.hid.requestDevice({
        filters: [{ vendorId: VENDOR_NINTENDO }],
      });
      for (const d of devices) await openDevice(d);
    } catch (e) {
      console.error('[joycon] requestDevice failed:', e);
    }
  }

  async function openDevice(device) {
    if (controllers.has(device)) return;
    const side = PRODUCT[device.productId] || (/(L)/.test(device.productName) ? 'Left' : 'Right');
    try {
      if (!device.opened) await device.open();
    } catch (e) {
      console.error('[joycon] open failed:', e);
      return;
    }
    const st = {
      device,
      side,
      packet: 0,
      q: [1, 0, 0, 0], // [w,x,y,z]
      gyroMag: 0,
      accelMag: 1,
      reports: 0,
    };
    controllers.set(device, st);
    device.addEventListener('inputreport', (ev) => onReport(st, ev));

    // Bring the controller up: enable vibration, enable IMU, then switch to the
    // standard full report (0x30). Small gaps let the firmware keep up.
    await subcommand(st, 0x48, [0x01]); // enable vibration
    await subcommand(st, 0x40, [0x01]); // enable IMU (6-axis)
    await subcommand(st, 0x03, [0x30]); // input report mode = standard full
    await subcommand(st, 0x30, [side === 'Left' ? 0x01 : 0x02]); // player LED
    paintUi();
    console.log('[joycon]', side, 'connected:', device.productName);
  }

  // Subcommand output report (id 0x01): [GP, ...rumble(8), subId, ...args].
  async function subcommand(st, subId, args = []) {
    const body = new Uint8Array([
      st.packet & 0x0f,
      ...NEUTRAL_RUMBLE,
      subId,
      ...args,
    ]);
    st.packet = (st.packet + 1) & 0x0f;
    try {
      await st.device.sendReport(0x01, body);
    } catch (e) {
      console.warn('[joycon] subcommand', subId.toString(16), 'failed:', e);
    }
    await new Promise((r) => setTimeout(r, 60));
  }

  // ---------- report parsing (report id 0x30 = standard full) ----------
  function onReport(st, ev) {
    if (ev.reportId !== 0x30) return; // 0x21 = subcommand reply (no IMU stream)
    const d = ev.data; // DataView, report id already stripped
    if (d.byteLength < 48) return;

    const buttons = parseButtons(st.side, d);
    const stick = parseStick(st.side, d);

    // 3 IMU subframes, 12 bytes each, starting at offset 12.
    let gx = 0, gy = 0, gz = 0, ax = 0, ay = 0, az = 0;
    for (let f = 0; f < 3; f++) {
      const o = 12 + f * 12;
      ax = d.getInt16(o + 0, true) * ACC_G;
      ay = d.getInt16(o + 2, true) * ACC_G;
      az = d.getInt16(o + 4, true) * ACC_G;
      gx = d.getInt16(o + 6, true) * GYRO_DPS;
      gy = d.getInt16(o + 8, true) * GYRO_DPS;
      gz = d.getInt16(o + 10, true) * GYRO_DPS;
      madgwick(st.q, gx * DEG2RAD, gy * DEG2RAD, gz * DEG2RAD, ax, ay, az);
    }
    // Report the most recent subframe's instantaneous magnitudes.
    st.gyroMag = Math.hypot(gx, gy, gz);
    st.accelMag = Math.hypot(ax, ay, az);
    st.reports++;

    const [w, x, y, z] = st.q;
    chrome.runtime.sendMessage({
      type: 'JOYCON',
      controller: {
        side: st.side,
        q: { x, y, z, w },               // THREE order
        gyro: { x: gx, y: gy, z: gz },   // deg/s
        accel: { x: ax, y: ay, z: az },  // g
        gyroMag: st.gyroMag,
        accelMag: st.accelMag,
        buttons,
        stick,
        t: performance.now(),
      },
    });
  }

  function parseButtons(side, d) {
    const r = d.getUint8(2), s = d.getUint8(3), l = d.getUint8(4);
    return {
      // right cluster
      y: !!(r & 0x01), x: !!(r & 0x02), b: !!(r & 0x04), a: !!(r & 0x08),
      r: !!(r & 0x40), zr: !!(r & 0x80),
      // shared
      minus: !!(s & 0x01), plus: !!(s & 0x02),
      rStick: !!(s & 0x04), lStick: !!(s & 0x08),
      home: !!(s & 0x10), capture: !!(s & 0x20),
      // left cluster
      down: !!(l & 0x01), up: !!(l & 0x02), right: !!(l & 0x04), left: !!(l & 0x08),
      l: !!(l & 0x40), zl: !!(l & 0x80),
      // SL/SR live in the side-specific byte
      sl: !!((side === 'Left' ? l : r) & 0x20),
      sr: !!((side === 'Left' ? l : r) & 0x10),
    };
  }

  function parseStick(side, d) {
    const o = side === 'Left' ? 5 : 8;
    const b0 = d.getUint8(o), b1 = d.getUint8(o + 1), b2 = d.getUint8(o + 2);
    const rx = b0 | ((b1 & 0x0f) << 8);
    const ry = (b1 >> 4) | (b2 << 4);
    // Uncalibrated normalize around the 12-bit midpoint — good enough as a skeleton.
    return { x: (rx - 2048) / 2048, y: (ry - 2048) / 2048 };
  }

  // ---------- Madgwick IMU (gyro+accel, no magnetometer) ----------
  // Mutates q = [w,x,y,z] in place. Yaw is unobservable -> will slowly drift.
  function madgwick(q, gx, gy, gz, ax, ay, az) {
    let [q0, q1, q2, q3] = q;
    let qd0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
    let qd1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
    let qd2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
    let qd3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);

    const an = Math.hypot(ax, ay, az);
    if (an > 0) {
      ax /= an; ay /= an; az /= an;
      const _2q0 = 2 * q0, _2q1 = 2 * q1, _2q2 = 2 * q2, _2q3 = 2 * q3;
      const _4q0 = 4 * q0, _4q1 = 4 * q1, _4q2 = 4 * q2;
      const _8q1 = 8 * q1, _8q2 = 8 * q2;
      const q0q0 = q0 * q0, q1q1 = q1 * q1, q2q2 = q2 * q2, q3q3 = q3 * q3;
      let s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay;
      let s1 = _4q1 * q3q3 - _2q3 * ax + 4 * q0q0 * q1 - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az;
      let s2 = 4 * q0q0 * q2 + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az;
      let s3 = 4 * q1q1 * q3 - _2q1 * ax + 4 * q2q2 * q3 - _2q2 * ay;
      const sn = Math.hypot(s0, s1, s2, s3);
      if (sn > 0) {
        s0 /= sn; s1 /= sn; s2 /= sn; s3 /= sn;
        qd0 -= BETA * s0; qd1 -= BETA * s1; qd2 -= BETA * s2; qd3 -= BETA * s3;
      }
    }
    q0 += qd0 * DT; q1 += qd1 * DT; q2 += qd2 * DT; q3 += qd3 * DT;
    const n = Math.hypot(q0, q1, q2, q3) || 1;
    q[0] = q0 / n; q[1] = q1 / n; q[2] = q2 / n; q[3] = q3 / n;
  }

  // ---------- rumble (best-effort buzz on hit) ----------
  // HD-rumble amplitude/frequency encoding from the reverse-engineering notes.
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function rumbleBytes(lowHz, highHz, amp) {
    lowHz = clamp(lowHz, 40.875885, 626.286133);
    highHz = clamp(highHz, 81.75177, 1252.572266);
    amp = clamp(amp, 0, 1);
    let hf = (Math.round(32 * Math.log2(highHz * 0.1)) - 0x60) * 4;
    const lf = Math.round(32 * Math.log2(lowHz * 0.1)) - 0x40;
    let hfAmp;
    if (amp === 0) hfAmp = 0;
    else if (amp < 0.117) hfAmp = Math.round((Math.log2(amp * 1000) * 32 - 0x60) / (5 - amp * amp) - 1);
    else if (amp < 0.23) hfAmp = Math.round(Math.log2(amp * 1000) * 32 - 0x60 - 5);
    else hfAmp = Math.round((Math.log2(amp * 1000) * 32 - 0x60) * 2 - 0xc0);
    let lfAmp = Math.round(hfAmp) * 0.5;
    const parity = lfAmp % 2;
    if (parity > 0) lfAmp -= 1;
    lfAmp = (lfAmp >> 1) + 0x40;
    if (parity > 0) lfAmp |= 0x8000;
    hf &= 0xffff;
    const b = new Uint8Array(8);
    b[0] = hf & 0xff;
    b[1] = (hfAmp + ((hf >> 8) & 0xff)) & 0xff;
    b[2] = (lf + ((lfAmp >> 8) & 0xff)) & 0xff;
    b[3] = lfAmp & 0xff;
    b[4] = b[0]; b[5] = b[1]; b[6] = b[2]; b[7] = b[3];
    return b;
  }
  async function buzz(st, ms = 120) {
    try {
      const on = new Uint8Array([st.packet & 0x0f, ...rumbleBytes(160, 320, 0.8)]);
      st.packet = (st.packet + 1) & 0x0f;
      await st.device.sendReport(0x10, on);
      setTimeout(async () => {
        try {
          const off = new Uint8Array([st.packet & 0x0f, ...NEUTRAL_RUMBLE]);
          st.packet = (st.packet + 1) & 0x0f;
          await st.device.sendReport(0x10, off);
        } catch {}
      }, ms);
    } catch (e) {
      // rumble is a nice-to-have; never let it break the input path
    }
  }

  // Hit signal travels content-main -> bridge -> here as a runtime broadcast.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'RUMBLE') return;
    for (const st of controllers.values()) {
      if (!msg.side || st.side === msg.side) buzz(st);
    }
  });

  // ---------- lifecycle ----------
  navigator.hid?.addEventListener('disconnect', (e) => {
    if (controllers.delete(e.device)) {
      console.log('[joycon] disconnected:', e.device.productName);
      paintUi();
    }
  });

  // Re-open Joy-Cons already granted in a previous session (no gesture needed).
  async function reconnectGranted() {
    if (!navigator.hid) return;
    try {
      const known = await navigator.hid.getDevices();
      for (const d of known) {
        if (d.vendorId === VENDOR_NINTENDO) await openDevice(d);
      }
    } catch {}
  }

  function start() {
    if (!navigator.hid) {
      ensureUi().status.textContent = 'WebHID 不支援 — 需 Chrome/Edge';
      return;
    }
    ensureUi();
    reconnectGranted().then(paintUi);
    setInterval(paintUi, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
