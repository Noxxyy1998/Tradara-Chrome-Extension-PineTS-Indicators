// Isolated-world bridge: owns chrome.storage, hosts the sandbox iframe that runs PineTS,
// and relays messages between the page script (MAIN world) and the sandbox.
'use strict';

(() => {
  const TAG = '__pinetsOverlay';
  const DEFAULT_SETTINGS = {
    enabled: true,
    maxBars: 5000,
    strategyClosedBarsOnly: true,
    showTrades: true,
    showHud: true,
    pointValue: 0, // 0 = auto-detect from symbol
  };

  let settings = { ...DEFAULT_SETTINGS };
  let scripts = [];
  let notes = [];
  let frame = null;
  let frameReady = false;
  let frameBornAt = 0;
  let reqSeq = 0;
  let cfgVersion = 0;
  const inflight = new Map(); // key -> { reqId, at } run currently in the sandbox
  const pending = new Map(); // key -> newest run message waiting for the in-flight one (or for the sandbox)
  const sentSig = new Map(); // key -> signature of the inputs last sent (skip identical re-runs)
  const applied = new Map(); // key -> newest reqId already shown on the chart
  const lastBars = new Map(); // chartKey -> last bars message (for re-runs after edits)
  const statusBuf = {};
  let statusTimer = null;

  function toPage(msg) { window.postMessage({ [TAG]: true, dir: 'toPage', ...msg }, location.origin); }

  const mergeSettings = (s) => (window.PTOSettings ? window.PTOSettings.merge(s) : (s || {}));

  function sendConfig() {
    toPage({
      type: 'config',
      settings,
      notes,
      scripts: scripts.map(({ id, name, enabled, settings: ss }) => {
        const m = mergeSettings(ss);
        return { id, name, enabled, settings: { hidden: m.hidden, style: m.style, visibility: m.visibility, maxTradesPerDay: m.maxTradesPerDay,
          alerts: { enabled: m.alerts.enabled, voice: m.alerts.voice, notify: m.alerts.notify, showTags: m.alerts.showTags, rsiLevel: m.alerts.rsiLevel } } };
      }),
    });
  }

  // Is a script visible on a chart whose bars are tfMs apart? (TradingView "Visibility" tab)
  function visibleOn(vis, tfMs) {
    if (!vis || !tfMs) return true;
    const s = tfMs / 1000;
    let k, n;
    if (s < 60) { k = 'seconds'; n = s; }
    else if (s < 3600) { k = 'minutes'; n = s / 60; }
    else if (s < 86400) { k = 'hours'; n = s / 3600; }
    else if (s < 7 * 86400) { k = 'days'; n = s / 86400; }
    else if (s < 28 * 86400) { k = 'weeks'; n = s / (7 * 86400); }
    else { k = 'months'; n = Math.max(1, Math.round(s / (30 * 86400))); }
    const r = vis[k];
    if (!r) return true;
    n = Math.round(n);
    return !!r.on && n >= (r.min || 1) && n <= (r.max || 9999);
  }

  // Remember each script's inputs/properties/plots so the settings dialog can build its tabs
  const metaSig = {};
  let metaBuf = {}, metaTimer = null;
  function storeMeta(id, meta) {
    if (!meta) return;
    const sig = JSON.stringify(meta);
    if (metaSig[id] === sig) return;
    metaSig[id] = sig;
    metaBuf[id] = meta;
    if (metaTimer) return;
    metaTimer = setTimeout(async () => {
      metaTimer = null;
      try {
        const { meta: all = {} } = await chrome.storage.local.get('meta');
        Object.assign(all, metaBuf); metaBuf = {};
        await chrome.storage.local.set({ meta: all });
      } catch (_) { /* extension reloaded */ }
    }, 500);
  }

  // ---------- voice alerts ----------
  const alertSeen = new Map(); // script|chart|symbol|tf -> time of the newest closed signal already handled

  function tfWords(ms) {
    const m = Math.round(ms / 60000);
    if (ms < 60000) return `${Math.round(ms / 1000)} second`;
    if (m < 60) return `${m} minute`;
    if (m < 1440) return `${m / 60} hour`;
    if (m < 10080) return 'daily';
    return 'weekly';
  }

  // whole number unless rounding would land on the level (49.7 must not be read out as "50")
  function rsiText(r, lvl) { return Math.round(r) === Number(lvl) ? r.toFixed(1) : String(Math.round(r)); }

  function fill(tpl, x, b, lvl) {
    return String(tpl || '')
      .replace(/\{symbol\}/gi, String(b.symbol || '').replace(/^\//, ''))
      .replace(/\{tf\}/gi, tfWords(b.tfMs))
      .replace(/\{rsi\}/gi, rsiText(x.rsi, lvl))
      .replace(/\{price\}/gi, String(x.price));
  }

  function handleAlerts(scriptId, chartKey, payload) {
    const s = scripts.find((x) => x.id === scriptId);
    const b = lastBars.get(chartKey);
    if (!s || !b) return;
    const a = mergeSettings(s.settings).alerts;
    const key = `${scriptId}|${chartKey}|${b.symbol}|${b.tfMs}|${a.rsiLength}|${a.rsiLevel}`;
    const closed = payload.alertSignals.filter((x) => !x.forming);
    const newest = closed.length ? closed[closed.length - 1].t : 0;
    if (!alertSeen.has(key)) { alertSeen.set(key, newest); return; } // first look: signals already on the chart are history
    const seen = alertSeen.get(key);
    const fresh = closed.filter((x) => x.t > seen && x.i >= payload.n - 3); // only signals on the last couple of closed bars
    alertSeen.set(key, Math.max(seen, newest));
    if (!fresh.length || !a.enabled || (!a.voice && !a.notify)) return;
    const x = fresh[fresh.length - 1];
    const text = fill(x.dir > 0 ? a.bullText : a.bearText, x, b, a.rsiLevel);
    try {
      chrome.runtime.sendMessage({
        type: 'pto-alert', text, speak: !!a.voice, notify: !!a.notify,
        title: `${x.dir > 0 ? '▲ Green arrow' : '▼ Orange arrow'}: ${String(b.symbol).replace(/^\//, '')} ${tfWords(b.tfMs)}`,
        voiceName: a.voiceName, rate: a.rate, volume: a.volume,
      }, () => void chrome.runtime.lastError);
    } catch (_) { /* extension reloaded */ }
  }

  async function patchAlerts(id, patch) {
    const d = await chrome.storage.local.get('scripts');
    const list = Array.isArray(d.scripts) ? d.scripts : [];
    const s = list.find((x) => x.id === id);
    if (!s) return;
    const cur = (s.settings && s.settings.alerts) || {};
    s.settings = { ...(s.settings || {}), alerts: { ...cur, ...patch } };
    await chrome.storage.local.set({ scripts: list });
  }

  async function setHidden(id, hidden) {
    const d = await chrome.storage.local.get('scripts');
    const list = Array.isArray(d.scripts) ? d.scripts : [];
    const s = list.find((x) => x.id === id);
    if (!s) return;
    s.settings = { ...(s.settings || {}), hidden };
    await chrome.storage.local.set({ scripts: list });
  }

  const frameAlive = () => !!(frame && frame.isConnected && frame.contentWindow);

  // (Re)create the hidden sandbox iframe that runs PineTS. Tradara can remove foreign elements from the
  // page, so this is called whenever the frame is missing, broken, or stuck.
  function ensureFrame(force) {
    if (!force && frameAlive()) return;
    if (frame) { try { frame.remove(); } catch (_) {} }
    frameReady = false;
    frameBornAt = Date.now();
    // anything that was running in the old frame will never answer: re-queue the newest request per key
    inflight.clear();
    sentSig.clear();
    frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('sandbox.html');
    frame.setAttribute('aria-hidden', 'true');
    frame.dataset.pinetsOverlay = 'engine';
    frame.tabIndex = -1;
    Object.assign(frame.style, { position: 'fixed', width: '0', height: '0', border: '0', left: '-10px', top: '-10px', visibility: 'hidden', pointerEvents: 'none' });
    document.documentElement.appendChild(frame);
  }

  function post(key, msg) {
    if (!frameAlive() || !frameReady) { pending.set(key, msg); ensureFrame(); return; }
    if (inflight.has(key)) { pending.set(key, msg); return; } // coalesce: only the newest waits
    inflight.set(key, { reqId: msg.reqId, at: Date.now() });
    try { frame.contentWindow.postMessage(msg, '*'); }
    catch (_) { inflight.delete(key); pending.set(key, msg); ensureFrame(true); }
  }

  function flushPending() {
    for (const [key, msg] of [...pending]) {
      if (inflight.has(key)) continue;
      pending.delete(key);
      post(key, msg);
    }
  }

  // watchdog: frame removed, never became ready, or a run hung -> rebuild
  setInterval(() => {
    try {
      if (!frameAlive()) { ensureFrame(); return; }
      if (!frameReady && Date.now() - frameBornAt > 15000) { ensureFrame(true); return; }
      for (const [key, inf] of inflight) {
        if (Date.now() - inf.at > 45000) { ensureFrame(true); return; }
      }
    } catch (_) { /* extension reloaded */ }
  }, 1000);

  function runAll(chartKey) {
    const b = lastBars.get(chartKey);
    if (!b || !settings.enabled) return;
    for (const s of scripts) {
      if (!s.enabled || !s.code || !s.code.trim()) continue;
      const ss = mergeSettings(s.settings);
      if (ss.hidden || !visibleOn(ss.visibility, b.tfMs)) continue;
      const isStrategy = /^\s*strategy\s*\(/m.test(s.code);
      let bars = b.bars;
      if (isStrategy && settings.strategyClosedBarsOnly && b.lastBarForming && bars.length > 1) bars = bars.slice(0, -1);
      const key = chartKey + '|' + s.id;
      const last = bars[bars.length - 1];
      const sig = `${cfgVersion}|${bars.length}|${last && last.t}|${last && last.c}|${last && last.h}|${last && last.l}`;
      if (sentSig.get(key) === sig) continue; // nothing changed for this script (e.g. strategy on closed bars only)
      sentSig.set(key, sig);
      const reqId = ++reqSeq;
      post(key, {
        [TAG]: true, type: 'run', key, reqId, chartKey,
        script: { id: s.id, name: s.name, code: s.code },
        bars, symbol: b.symbol, tf: b.tf, tfMs: b.tfMs,
        pointValueOverride: Number(settings.pointValue) || 0,
        settings: { inputs: ss.inputs, props: ss.props, maxTradesPerDay: ss.maxTradesPerDay, dayReset: ss.dayReset },
        alerts: { rsiLength: ss.alerts.rsiLength, rsiLevel: ss.alerts.rsiLevel },
        lastBarForming: !!b.lastBarForming,
      });
    }
  }

  const lastStatus = {};
  function setStatus(id, st) {
    const prev = lastStatus[id];
    if (prev && prev.ok === st.ok && prev.error === st.error && Date.now() - prev.at < 10000) return;
    lastStatus[id] = st;
    statusBuf[id] = st;
    if (statusTimer) return;
    statusTimer = setTimeout(async () => {
      statusTimer = null;
      try {
        const { status = {} } = await chrome.storage.local.get('status');
        Object.assign(status, statusBuf);
        for (const k of Object.keys(statusBuf)) delete statusBuf[k];
        await chrome.storage.local.set({ status });
      } catch (_) { /* extension reloaded */ }
    }, 1000);
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m[TAG] !== true) return;

    // from sandbox
    if (frame && ev.source === frame.contentWindow) {
      if (m.type === 'ready') {
        frameReady = true;
        flushPending();
        for (const k of lastBars.keys()) runAll(k);
        return;
      }
      if (m.type === 'result') {
        const inf = inflight.get(m.key);
        if (inf && inf.reqId === m.reqId) inflight.delete(m.key);
        storeMeta(m.scriptId, m.meta);
        // show any result newer than what's on the chart, even if a fresher run is already queued
        if ((applied.get(m.key) || 0) < m.reqId) {
          applied.set(m.key, m.reqId);
          setStatus(m.scriptId, { ok: m.ok, error: m.error || null, ms: m.ms || null, warnings: m.warnings || [], at: Date.now() });
          toPage({ type: 'result', chartKey: m.chartKey, scriptId: m.scriptId, ok: m.ok, error: m.error, payload: m.payload });
          if (m.ok && m.payload && Array.isArray(m.payload.alertSignals)) handleAlerts(m.scriptId, m.chartKey, m.payload);
        }
        flushPending();
      }
      return;
    }

    // from page script
    if (ev.source !== window || m.dir !== 'toContent') return;
    if (m.type === 'hello') { sendConfig(); return; }
    if (m.type === 'openSettings' && window.PTOSettings) { window.PTOSettings.open(m.scriptId, { tab: m.tab }); return; }
    if (m.type === 'toggleHidden') { setHidden(m.scriptId, !!m.hidden); return; }
    if (m.type === 'noteUpdate') { updateNote(m.id, m.patch); return; }
    if (m.type === 'toggleAlertVoice') { patchAlerts(m.scriptId, { voice: !!m.on, notify: !!m.on }); return; }
    if (m.type === 'bars') {
      lastBars.set(m.chartKey, m);
      runAll(m.chartKey);
    }
    if (m.type === 'chartGone') {
      lastBars.delete(m.chartKey);
      for (const k of [...pending.keys()]) if (k.startsWith(m.chartKey + '|')) pending.delete(k);
    }
  });

  async function updateNote(id, patch) {
    const allowed = ['x', 'y', 'w', 'collapsed', 'enabled'];
    const d = await chrome.storage.local.get('notes');
    const list = Array.isArray(d.notes) ? d.notes : [];
    const n = list.find((x) => x.id === id);
    if (!n || !patch) return;
    for (const k of allowed) if (k in patch) n[k] = patch[k];
    await chrome.storage.local.set({ notes: list });
  }

  async function load() {
    if (typeof ensureDefaults === 'function') { try { await ensureDefaults(); } catch (_) {} }
    const data = await chrome.storage.local.get(['settings', 'scripts', 'notes']);
    notes = Array.isArray(data.notes) ? data.notes : (typeof loadNotes === 'function' ? await loadNotes() : []);
    settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    cfgVersion++;
    scripts = Array.isArray(data.scripts) ? data.scripts : [];
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || (!changes.settings && !changes.scripts && !changes.notes)) return;
    await load();
    sendConfig();
    if (!changes.settings && !changes.scripts) return; // notes only: no need to re-run scripts
    for (const k of lastBars.keys()) runAll(k);
  });

  load().then(() => {
    ensureFrame();
    sendConfig();
  });
})();
