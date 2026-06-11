// content-bridge.js — ISOLATED world.
// It can talk to chrome.runtime but CANNOT see page globals (window.AFRAME/THREE).
// It re-broadcasts POSE as a DOM CustomEvent, which the MAIN-world script hears
// (both worlds share the same window/DOM).

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'POSE') {
    window.dispatchEvent(new CustomEvent('moonrider:pose', { detail: msg.hands }));
  } else if (msg?.type === 'JOYCON') {
    window.dispatchEvent(new CustomEvent('moonrider:joycon', { detail: msg.controller }));
  }
});

// Reverse path: MAIN world can't touch chrome.runtime, so it asks for rumble via
// a DOM event; we forward it as a runtime message the popup (joy-con owner) hears.
window.addEventListener('moonrider:rumble', (e) => {
  chrome.runtime.sendMessage({ type: 'RUMBLE', side: e.detail?.side || null });
});
