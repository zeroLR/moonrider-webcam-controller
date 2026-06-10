// content-bridge.js — ISOLATED world.
// It can talk to chrome.runtime but CANNOT see page globals (window.AFRAME/THREE).
// It re-broadcasts POSE as a DOM CustomEvent, which the MAIN-world script hears
// (both worlds share the same window/DOM).

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'POSE') {
    window.dispatchEvent(new CustomEvent('moonrider:pose', { detail: msg.hands }));
  }
});
