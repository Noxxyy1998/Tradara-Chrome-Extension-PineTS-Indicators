// Background service worker: speaks alerts (chrome.tts) and shows desktop notifications.
// Using the extension's own TTS means alerts work even when the Tradara tab is in the background.
'use strict';

// let the Tradara page's content script read the bot's unlocked flag (session storage is in memory only)
try { chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }); } catch (_) {}

const notifTabs = new Map(); // notification id -> tab id (click to jump back to the chart)

// Prefer the most natural-sounding installed voice when none is chosen
const RANK = [/natural|neural/i, /siri/i, /premium|enhanced/i, /^google us english/i, /^google uk english female/i,
  /online/i, /samantha|ava|allison|aria|jenny|zira|susan/i, /^google/i];
let bestVoice;
function pickBest(cb) {
  if (bestVoice !== undefined) return cb(bestVoice);
  chrome.tts.getVoices((voices) => {
    const en = (voices || []).filter((v) => /^en/i.test(v.lang || ''));
    bestVoice = null;
    for (const re of RANK) { const hit = en.find((v) => re.test(v.voiceName || '')); if (hit) { bestVoice = hit.voiceName; break; } }
    cb(bestVoice);
  });
}

function speak(text, opts = {}) {
  if (!text) return;
  const go = (voiceName) => chrome.tts.speak(text, {
    enqueue: true,
    voiceName: voiceName || undefined,
    rate: Math.max(0.5, Math.min(2, Number(opts.rate) || 1)),
    volume: Math.max(0, Math.min(1, opts.volume === undefined ? 1 : Number(opts.volume))),
  });
  if (opts.voiceName) go(opts.voiceName); else pickBest(go);
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
