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
  title: 'Signal guide',
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

async function loadAll() {
  const d = await chrome.storage.local.get(['settings', 'scripts', 'status']);
  let scripts = d.scripts;
  if (!Array.isArray(scripts)) {
    scripts = [{ id: crypto.randomUUID(), name: 'EMA Cross Strategy (example)', code: TEMPLATES.strategy, enabled: false }];
    await chrome.storage.local.set({ scripts });
  }
  return { settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) }, scripts, status: d.status || {} };
}

async function saveScripts(scripts) { await chrome.storage.local.set({ scripts }); }
async function saveSettings(settings) { await chrome.storage.local.set({ settings }); }

function nameFromCode(code, fallback) {
  const m = code.match(/^\s*(?:indicator|strategy|study)\s*\(\s*(?:title\s*=\s*)?["']([^"']+)["']/m);
  return (m && m[1]) || fallback;
}
