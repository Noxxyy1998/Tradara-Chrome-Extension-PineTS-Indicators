// Shared storage helpers for popup.html and manager.html
'use strict';

const DEFAULT_SETTINGS = {
  enabled: true,
  maxBars: 5000,
  strategyClosedBarsOnly: true,
  showTrades: true,
  showHud: true,
  pointValue: 0,
};

const TEMPLATES = {
  strategy: `//@version=6
strategy("EMA Cross Strategy", overlay=true, default_qty_type=strategy.fixed, default_qty_value=1)

fastLen = input.int(9, "Fast EMA")
slowLen = input.int(21, "Slow EMA")

fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)

if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.entry("Short", strategy.short)

plot(fast, "Fast", color=color.new(color.aqua, 0), linewidth=2)
plot(slow, "Slow", color=color.new(color.orange, 0), linewidth=2)
`,
  indicator: `//@version=6
indicator("My Indicator", overlay=true)

len = input.int(20, "Length")
basis = ta.sma(close, len)
dev = 2.0 * ta.stdev(close, len)

u = plot(basis + dev, "Upper", color=color.teal)
plot(basis, "Basis", color=color.orange)
l = plot(basis - dev, "Lower", color=color.teal)
fill(u, l, color=color.new(color.teal, 90))
`,
  pane: `//@version=6
indicator("RSI (pane)", overlay=false)

r = ta.rsi(close, 14)
plot(r, "RSI", color=color.purple, linewidth=2)
hline(70, "Overbought", color=color.red)
hline(30, "Oversold", color=color.green)
`,
};

const EXAMPLE_NOTE = {
  title: 'EMA Rejections: signal guide',
  text: `There are 4 different signals this indicator can print:

1. A **green arrow** indicates a move of strength to the upside has begun. Could be a bull trap or the start of a long lasting bullish move.
2. An **orange arrow** indicates a move of strength to the downside has begun. Could be a bear trap or the start of a long lasting bearish move.
3. A **blue cross** is printed above if the break was to the upside, or below if it was to the downside. Indicates a failed attempt to change the trend and bullish price action is more likely in the next few candles.
4. A **red cross** is printed above if the break was to the upside, or below if it was to the downside. Indicates a failed attempt to change the trend and bearish price action is more likely in the next few candles.

The location of the cross is more important than the colour. **Above** means pressure downwards, and **below** means pressure upwards.`,
};

function newNote(fields) {
  return { id: crypto.randomUUID(), title: 'New note', text: '', enabled: true, x: 0.02, y: 0.1, w: 380, fontSize: 13, opacity: 0.88, accent: '#00e5ff', collapsed: false, ...fields };
}

async function loadNotes() {
  const d = await chrome.storage.local.get('notes');
  let notes = d.notes;
  if (!Array.isArray(notes)) {
    notes = [newNote(EXAMPLE_NOTE)];
    await chrome.storage.local.set({ notes });
  }
  return notes;
}
async function saveNotes(notes) { await chrome.storage.local.set({ notes }); }

// Built-in default indicator (MPL-2.0, © Zuage337)
const DEFAULT_INDICATOR = {
  name: 'EMA Rejections / Good for Scalpers',
  code: "// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/\n// \u00a9 Zuage337\n\n//@version=5\n\nint val = na\nbool holdingAbove = na\nbool holdingBelow = na\nbool holdingAboveEMA = na\nbool holdingBelowEMA = na\n\nindicator(\"EMA Confirmation Break\", timeframe=\"\", overlay = true)\n\nx = input.int(5, minval = 1, title=\"EMA\")\nxEMA = ta.ema(close, x)\n\nbuy = ta.crossunder(xEMA[1], close[1])\nsell = ta.crossover(xEMA[1], close[1])\n\nif (buy)\n    if ((close > close[1]) and (high > high[1]))\n        val := 1\n    else if (high <= high[1] or (close < xEMA))\n        holdingAbove := true\n        if (close >= xEMA)\n            holdingAboveEMA := true\n        \nelse if (sell)\n    if ((close < close[1]) and (low < low[1]))\n        val := -1\n    else if (low >= low[1] or (close > xEMA))\n        holdingBelow := true\n        if (close <= xEMA)\n            holdingBelowEMA := true\n\n\n//crosses to indicate failed break. Blue = more bullish, Red = more bearish.\nplotshape(holdingAbove, style=shape.xcross, color=holdingAboveEMA ? color.blue : color.red , location=location.abovebar)\nplotshape(holdingBelow, style=shape.xcross, color=holdingBelowEMA ? color.red : color.blue, location=location.belowbar)\n//plots arrows to indicate buy/sell.\nplotarrow(val, title = \"ARROW\", colorup = color.green, colordown = color.orange, minheight = 35, maxheight = 35)\n",
};

// One-time additions for existing installs. Bump DEFAULTS_VERSION to ship a new default.
const DEFAULTS_VERSION = 2;
async function ensureDefaults() {
  const d = await chrome.storage.local.get(['scripts', 'defaultsVersion']);
  if ((d.defaultsVersion || 0) >= DEFAULTS_VERSION) return;
  let scripts = Array.isArray(d.scripts) ? d.scripts : null;
  if (!scripts) {
    scripts = [
      { id: crypto.randomUUID(), name: DEFAULT_INDICATOR.name, code: DEFAULT_INDICATOR.code, enabled: true },
      { id: crypto.randomUUID(), name: 'EMA Cross Strategy (example)', code: TEMPLATES.strategy, enabled: false },
    ];
  } else if (!scripts.some((s) => s.name === DEFAULT_INDICATOR.name || /EMA Confirmation Break/.test(s.code || ''))) {
    scripts.unshift({ id: crypto.randomUUID(), name: DEFAULT_INDICATOR.name, code: DEFAULT_INDICATOR.code, enabled: true });
  }
  await chrome.storage.local.set({ scripts, defaultsVersion: DEFAULTS_VERSION });
}

async function loadAll() {
  await ensureDefaults();
  const d = await chrome.storage.local.get(['settings', 'scripts', 'status']);
  const scripts = Array.isArray(d.scripts) ? d.scripts : [];
  return { settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) }, scripts, status: d.status || {} };
}

async function saveScripts(scripts) { await chrome.storage.local.set({ scripts }); }
async function saveSettings(settings) { await chrome.storage.local.set({ settings }); }

function nameFromCode(code, fallback) {
  const m = code.match(/^\s*(?:indicator|strategy|study)\s*\(\s*(?:title\s*=\s*)?["']([^"']+)["']/m);
  return (m && m[1]) || fallback;
}


// ---------- natural-sounding voice ----------
// Chrome's built-in extension voice can sound robotic. Web voices like "Google US English" or Windows
// "Natural" voices sound much closer to Siri, so prefer those and pick the most natural one automatically.
const PTOVoice = (() => {
  const RANK = [/natural|neural/i, /siri/i, /premium|enhanced/i, /^google us english/i, /^google uk english female/i,
    /online/i, /samantha|ava|allison|aria|jenny|zira|susan/i, /^google/i];
  let cache = [];
  const load = () => { try { cache = window.speechSynthesis ? window.speechSynthesis.getVoices() : []; } catch (_) { cache = []; } return cache; };
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    load();
    try { window.speechSynthesis.addEventListener('voiceschanged', load); } catch (_) {}
  }
  function list() { return cache.length ? cache : load(); }
  function best() {
    const v = list();
    const en = v.filter((x) => /^en[-_]/i.test(x.lang || ''));
    const pool = en.length ? en : v;
    for (const re of RANK) {
      const hit = pool.find((x) => re.test(x.name) && /en[-_]US/i.test(x.lang || '')) || pool.find((x) => re.test(x.name));
      if (hit) return hit;
    }
    return pool[0] || null;
  }
  function find(name) { return !name || name === 'auto' ? best() : (list().find((x) => x.name === name) || best()); }
  // Chrome only lets a page speak after the user has clicked or typed on it once
  function canSpeakHere() {
    try { return !!window.speechSynthesis && (!navigator.userActivation || navigator.userActivation.hasBeenActive) && list().length > 0; }
    catch (_) { return false; }
  }
  function speak(text, a = {}) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = find(a.voiceName);
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = Math.max(0.5, Math.min(2, Number(a.rate) || 1));
      u.pitch = 1;
      u.volume = Math.max(0, Math.min(1, a.volume === undefined ? 1 : Number(a.volume)));
      window.speechSynthesis.speak(u);
      return true;
    } catch (_) { return false; }
  }
  return { list, best, find, speak, canSpeakHere };
})();
