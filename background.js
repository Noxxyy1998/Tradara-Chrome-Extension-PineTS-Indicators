// Background service worker: speaks alerts (chrome.tts) and shows desktop notifications.
// Using the extension's own TTS means alerts work even when the Tradara tab is in the background.
'use strict';

const notifTabs = new Map(); // notification id -> tab id (click to jump back to the chart)

function speak(text, opts = {}) {
  if (!text) return;
  chrome.tts.speak(text, {
    enqueue: true,
    voiceName: opts.voiceName || undefined,
    rate: Math.max(0.5, Math.min(2, Number(opts.rate) || 1)),
    volume: Math.max(0, Math.min(1, opts.volume === undefined ? 1 : Number(opts.volume))),
  });
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'pto-alert') {
    if (m.speak) speak(m.text, m);
    if (m.notify) {
      chrome.notifications.create('', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: m.title || 'PineTS Overlay',
        message: m.text || '',
        priority: 2,
      }, (id) => { if (id && sender.tab) notifTabs.set(id, { tabId: sender.tab.id, windowId: sender.tab.windowId }); });
    }
    reply({ ok: true });
    return;
  }
  if (m.type === 'pto-voices') {
    chrome.tts.getVoices((voices) => reply((voices || []).map((v) => ({ name: v.voiceName, lang: v.lang || '' }))));
    return true; // async reply
  }
  if (m.type === 'pto-stop') { chrome.tts.stop(); reply({ ok: true }); }
});

chrome.notifications.onClicked.addListener((id) => {
  const t = notifTabs.get(id);
  if (t) {
    chrome.tabs.update(t.tabId, { active: true }, () => void chrome.runtime.lastError);
    chrome.windows.update(t.windowId, { focused: true }, () => void chrome.runtime.lastError);
  }
  chrome.notifications.clear(id);
  notifTabs.delete(id);
});
chrome.notifications.onClosed.addListener((id) => notifTabs.delete(id));
