# PineTS Overlay for Tradara

Runs your Pine Script (v5/v6) **indicators and strategies** on top of the Tradara Terminal chart
(terminal.tradara.com), using LuxAlgo's open-source PineTS engine.

## Install (Chrome / Edge / Brave)

1. Unzip this folder somewhere permanent (Chrome loads it from that location).
2. Go to `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and select the `pinets-overlay` folder.
4. Pin the extension (puzzle icon → pin) and open or refresh terminal.tradara.com.

## Use

- Click the extension icon → **Manage scripts & settings**.
- **+ New strategy** loads an example. Or paste your own Pine code / **Import .pine file**.
- Tick **Show on chart** and **Save** (Ctrl/Cmd+S). The chart updates within a second.
- Errors show in the manager's status bar and in red in the on-chart info panel.

What gets drawn:
- `plot()` (line, step, area, histogram, columns, circles, cross), per-bar colors, `hline`, `fill`, `bgcolor`
- `plotshape`, `plotchar` (above/below bar, top/bottom, absolute)
- `label.new`, `line.new` (extend, dashed/dotted/arrows), `box.new`, `linefill`, `polyline`
- Strategies: entry/exit arrows, dashed lines per trade (green win / red loss),
  and an info panel showing net P&L ($ and points), trade count, win %, profit factor, max drawdown and current position
- `overlay=false` scripts (RSI, MACD…) render in a strip at the bottom of the price pane

## Per-script settings (TradingView-style)
Click a script's name or ⚙ in the on-chart legend (top right), or **⚙ Settings** in the manager. Changes apply live. **Cancel** reverts them.
- **Inputs**: built automatically from your `input.*()` calls (numbers, toggles, dropdowns, sources, colors, timeframes…).
- **Properties** (strategies): initial capital, order size (contracts / USD / % equity), pyramiding, commission,
  long/short leverage (Infinity = no margin, the usual setting for futures), slippage, fill options.
  **Max trades per day** caps new entries per trading day (6 PM ET futures session or midnight ET). Exits still work.
- **Style**: show/hide and recolour each plot, line width, labels/lines/boxes, and strategy signals
  (entry/exit arrows, trade lines, label text: name+qty / name / qty / Buy-Sell / none, arrow size, colours).
- **Visibility**: choose which chart timeframes the script appears on.
- 👁 in the legend hides a script without turning it off.

## Global settings
- **Strategies use closed bars only** (on by default): signals don't flicker while a bar is still forming.
- **Max bars** (default 5000): how much chart history PineTS gets. Load more history in Tradara (scroll left) for longer backtests.
- **Point value**: 0 = auto. Built-in table for NQ/MNQ/ES/MES/YM/RTY/GC/CL/… (tick size + $ per point).

## Limitations
- The overlay is **visual only**. It never places orders on Tradara.
- `request.security` works for the **same symbol** at the chart timeframe or **higher** (resampled from chart bars).
  Other symbols and lower timeframes return `na`.
- `table.*` isn't drawn yet. `input.*` values use the defaults in your code (edit them in the code).
- Backtest results come from the bars loaded on the chart and PineTS's fill model, so they won't match TradingView exactly.
- The extension reads Tradara's internal chart object. A Tradara update can break it. If the overlay disappears,
  open DevTools → Console and look for `[PineTS Overlay]` messages.

## How it works
- `page.js` (runs in the page) finds Tradara's chart controller, reads its bars, and draws on a transparent canvas
  using the chart's own `priceToPixel` / `barIndexToPixel`, so it stays aligned while you pan and zoom.
- `content.js` stores scripts (chrome.storage) and relays data to `sandbox.html`.
- `sandbox.html` runs PineTS. It's a sandboxed extension page, because PineTS compiles code at runtime, which
  normal extension pages don't allow.

## Example
`examples/sr_trend_v6.pine`: SR Trend strategy (Pine v6, trailing stop, bar colors).

## License note
PineTS (vendor/pinets.min.browser.js) is © LuxAlgo, dual-licensed AGPL-3.0 / commercial (see vendor/PINETS_LICENSE).
This extension is released under the same AGPL-3.0 license (see LICENSE), and its full source is in this repository.
