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
