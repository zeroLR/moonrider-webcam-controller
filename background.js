// background.js — service worker (MV3)
// Toggle a single VISIBLE preview window (which also drives the game) and relay
// its POSE messages to the moonrider content script in the designated game tab.

let targetTabId = null;
let previewWindowId = null;

chrome.action.onClicked.addListener(async (gameTab) => {
  // Toggle off if already running.
  if (previewWindowId != null) {
    try { await chrome.windows.remove(previewWindowId); } catch {}
    previewWindowId = null;
    targetTabId = null;
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  // The tab you click on is the game tab we relay POSE to.
  targetTabId = gameTab.id;
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('offscreen.html'),
    type: 'popup',
    width: 680,
    height: 640,
  });
  previewWindowId = win.id;
  chrome.action.setBadgeText({ text: 'ON' });
  chrome.action.setBadgeBackgroundColor?.({ color: '#2e7d32' });
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === previewWindowId) {
    previewWindowId = null;
    targetTabId = null;
    chrome.action.setBadgeText({ text: '' });
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  // Camera pose and Joy-Con input both flow popup -> here -> game tab. (RUMBLE
  // goes the other way and is handled directly by the popup, not relayed here.)
  if ((msg?.type === 'POSE' || msg?.type === 'JOYCON') && targetTabId != null) {
    chrome.tabs.sendMessage(targetTabId, msg).catch(() => {});
  }
});
