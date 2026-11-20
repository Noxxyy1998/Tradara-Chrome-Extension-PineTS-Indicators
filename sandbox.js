// Runs inside a sandboxed extension page (allowed to eval), embedded as a hidden
// iframe on the Tradara page. Receives bars + Pine source, runs PineTS, and posts back
// a compact, structured-clone-friendly result for the overlay renderer.
'use strict';

const queue = new Map(); // key -> latest job (older jobs for the same key are dropped)
let busy = false;

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || m.__pinetsOverlay !== true || m.type !== 'run') return;
  queue.set(m.key, { msg: m, reply: ev.source });
  pump();
});

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.size) {
      const [key, job] = queue.entries().next().value;
      queue.delete(key);
      const out = await runJob(job.msg);
      job.reply.postMessage(out, '*');
    }
  } finally {
    busy = false;
  }
}

// ---------- symbol info + data provider ----------
// [mintick, pointvalue] for common CME/CBOT/NYMEX/COMEX futures roots
const FUTURES = {
  NQ: [0.25, 20], MNQ: [0.25, 2], ES: [0.25, 50], MES: [0.25, 5], YM: [1, 5], MYM: [1, 0.5],
  RTY: [0.1, 50], M2K: [0.1, 5], EMD: [0.1, 100],
  GC: [0.1, 100], MGC: [0.1, 10], SI: [0.005, 5000], SIL: [0.005, 1000], HG: [0.0005, 25000], MHG: [0.0005, 2500],
  PL: [0.1, 50], PA: [0.5, 100],
  CL: [0.01, 1000], MCL: [0.01, 100], QM: [0.025, 500], NG: [0.001, 10000], QG: [0.005, 2500], RB: [0.0001, 42000], HO: [0.0001, 42000],
  ZB: [1 / 32, 1000], UB: [1 / 32, 1000], ZN: [1 / 64, 1000], TN: [1 / 64, 1000], ZF: [1 / 128, 1000], ZT: [1 / 256, 2000],
  '6E': [0.00005, 125000], M6E: [0.0001, 12500], '6J': [0.0000005, 12500000], '6B': [0.0001, 62500], '6A': [0.00005, 100000],
  '6C': [0.00005, 100000], '6S': [0.00005, 125000], '6N': [0.00005, 100000], '6M': [0.00001, 500000],
  ZC: [0.25, 50], ZS: [0.25, 50], ZW: [0.25, 50], ZM: [0.1, 100], ZL: [0.01, 600], HE: [0.025, 400], LE: [0.025, 400], GF: [0.025, 500],
  BTC: [5, 5], MBT: [5, 0.1], ETH: [0.5, 50], MET: [0.05, 0.1],
};

function rootOf(symbol) {
  let s = String(symbol || '').toUpperCase().replace(/^\//, '');
  s = s.replace(/^[A-Z_]+:/, '').replace(/1!$|2!$/, '');
  const m = s.match(/^([A-Z0-9]+?)[FGHJKMNQUVXZ]\d{1,2}$/);
  return m ? m[1] : s;
}

function deriveTick(bars) {
  let best = Infinity;
  const from = Math.max(1, bars.length - 600);
  for (let i = from; i < bars.length; i++) {
    for (const d of [bars[i].close - bars[i - 1].close, bars[i].high - bars[i].low, bars[i].close - bars[i].open]) {
      const a = Math.abs(Math.round(d * 1e8) / 1e8);
      if (a > 0 && a < best) best = a;
    }
  }
  return Number.isFinite(best) ? best : 0.01;
}

function symbolInfo(symbol, bars, pvOverride) {
  const root = rootOf(symbol);
  const known = FUTURES[root];
  const mintick = known ? known[0] : deriveTick(bars);
  const pointvalue = pvOverride > 0 ? pvOverride : known ? known[1] : 1;
  const dec = Math.max(0, Math.min(8, Math.ceil(-Math.log10(mintick) - 1e-9)));
  return {
    ticker: root, tickerid: root, main_tickerid: root, root, prefix: '', current_contract: String(symbol || root),
    description: String(symbol || root), type: known ? 'futures' : 'unknown', currency: 'USD', basecurrency: '',
    timezone: 'America/New_York', session: '24x7', volumetype: 'base', country: 'US',
    mintick, pointvalue, minmove: Math.round(mintick * Math.pow(10, dec)) || 1, pricescale: Math.pow(10, dec), mincontract: 1,
  };
}

function tfToMs(tf) {
  const m = String(tf || '').trim().toUpperCase().match(/^(\d*)([SDWMH]?)$/);
  if (!m) return null;
  const n = m[1] ? parseInt(m[1], 10) : 1;
  switch (m[2]) {
    case 'S': return n * 1000;
    case 'H': return n * 3600000;
    case 'D': return n * 86400000;
    case 'W': return n * 7 * 86400000;
    case 'M': return n * 30 * 86400000;
    default: return n * 60000;
  }
}

// CME trading "session date" in New York time: a session starts 18:00 ET and belongs to the next day
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function sessionDate(t) {
  const parts = Object.fromEntries(etFmt.formatToParts(new Date(t + 6 * 3600000)).map((p) => [p.type, p.value]));
  return { y: +parts.year, mo: +parts.month, d: +parts.day };
}

function resample(bars, tf, chartMs) {
  const target = tfToMs(tf);
  if (!target || target < chartMs) return []; // lower timeframes can't be built from chart bars
  if (target === chartMs) return bars;
  const kind = String(tf).toUpperCase().replace(/^\d*/, '');
  const keyOf = (t) => {
    if (kind === 'D') { const s = sessionDate(t); return `${s.y}-${s.mo}-${s.d}`; }
    if (kind === 'W') {
      const s = sessionDate(t); const day = new Date(Date.UTC(s.y, s.mo - 1, s.d));
      const dow = (day.getUTCDay() + 6) % 7; return String(day.getTime() - dow * 86400000);
    }
    if (kind === 'M') { const s = sessionDate(t); return `${s.y}-${s.mo}`; }
    return String(Math.floor(t / target) * target);
  };
  const out = [];
  let cur = null, curKey = null;
  for (const b of bars) {
    const k = keyOf(b.openTime);
    if (k !== curKey) {
      if (cur) out.push(cur);
      curKey = k;
      const open = /^[DWM]$/.test(kind) ? b.openTime : Number(k);
      cur = { openTime: open, closeTime: /^[DWM]$/.test(kind) ? b.closeTime : open + target - 1, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume;
      if (/^[DWM]$/.test(kind)) cur.closeTime = b.closeTime;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function makeProvider(bars, chartTf, chartMs, info) {
  const cache = new Map();
  return {
    configure() {},
    async getSymbolInfo() { return info; },
    async getMarketData(tickerId, tf, limit, sDate, eDate) {
      if (rootOf(tickerId) !== info.root) return []; // other symbols aren't available from the chart
      const key = String(tf);
      let data = String(tf) === String(chartTf) ? bars : cache.get(key);
      if (!data) { data = resample(bars, tf, chartMs); cache.set(key, data); }
      if (sDate) data = data.filter((b) => b.openTime >= sDate);
      if (eDate) data = data.filter((b) => b.openTime <= eDate);
      if (limit && data.length > limit) data = data.slice(data.length - limit);
      return data;
    },
  };
}

// Clean up common copy/paste problems and catch non-Pine code with a readable message
function prepareSource(src) {
  let s = String(src || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/[​-‍⁠]/g, '')
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'");
  const fence = s.match(/```[\w-]*\n([\s\S]*?)```/);
  if (fence) s = fence[1];
  s = s.replace(/^[ \t]*\/?[ \t]*@version/m, '//@version'); // repair "/@version" or "@version"
  if (/\/\/\s*@version\s*=\s*tradarascript/i.test(s)) {
    throw new Error("This is TradaraScript (Tradara's own script language), not Pine Script. Paste the original Pine Script (//@version=5 or 6) instead.");
  }
  const v = s.match(/\/\/\s*@version\s*=\s*(\d+)/);
  if (!v) {
    if (/^\s*(indicator|strategy|study)\s*\(/m.test(s)) s = '//@version=6\n' + s;
    else throw new Error('No indicator(...) or strategy(...) declaration and no //@version line found. Is this Pine Script?');
  } else if (+v[1] < 5) {
    throw new Error(`Pine Script v${v[1]} isn't supported. PineTS needs v5 or v6 (in TradingView's Pine Editor use "Convert code to v5").`);
  }
  return s;
}

function cleanMeta(x) {
  try { return JSON.parse(JSON.stringify(x)); } catch (_) { return { name: String(x && x.name) }; }
}

// Max-trades-per-day guard: routes strategy.entry() through a wrapper that refuses new entries once
// `max` trades have been opened in the current day. Exits/closes are never blocked.
function injectDailyLimit(code, max, dayReset) {
  const m = /^[ \t]*strategy\s*\(/m.exec(code);
  if (!m) return { src: code, afterLine: 0, count: 0 };
  let i = code.indexOf('(', m.index), depth = 0, quote = null;
  for (; i < code.length; i++) {
    const ch = code[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) break; }
  }
  let eol = code.indexOf('\n', i);
  if (eol < 0) { code += '\n'; eol = code.length - 1; }
  const head = code.slice(0, eol + 1), body = code.slice(eol + 1);
  const dayExpr = dayReset === 'midnight' ? 'dayofmonth(time, "America/New_York")' : 'dayofmonth(time + 6 * 3600000, "America/New_York")';
  const guard = [
    `__ptoDay = ${dayExpr}`,
    '__ptoTotal = strategy.closedtrades + strategy.opentrades',
    'var int __ptoBase = 0',
    'if __ptoDay != nz(__ptoDay[1], __ptoDay)',
    '    __ptoBase := nz(__ptoTotal[1])',
    `__ptoAllow = __ptoTotal - __ptoBase < ${max}`,
    '__pto_entry(id, direction, qty = na, limit = na, stop = na, oca_name = "", oca_type = strategy.oca.none, comment = "", alert_message = "", disable_alert = false) =>',
    '    if __ptoAllow',
    '        strategy.entry(id, direction, qty = qty, limit = limit, stop = stop, oca_name = oca_name, oca_type = oca_type, comment = comment, alert_message = alert_message, disable_alert = disable_alert)',
    '',
  ].join('\n');
  return {
    src: head + guard + body.replace(/\bstrategy\.entry\s*\(/g, '__pto_entry('),
    afterLine: head.split('\n').length - 1,
    count: guard.split('\n').length - 1,
  };
}

function col(c) {
  if (typeof c !== 'string') return null;
  const t = c.trim();
  if (!t || t === 'NaN' || t === 'na' || t === 'null' || t === 'undefined') return null;
  return t;
}

function toNum(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

async function runJob(m) {
  const base = { __pinetsOverlay: true, type: 'result', key: m.key, reqId: m.reqId, scriptId: m.script.id, chartKey: m.chartKey };
  const t0 = performance.now();
  const meta = {};
  const warnings = [];
  let lineShift = null;
  try {
    const bars = m.bars.map((b) => ({
      openTime: b.t, closeTime: b.t + m.tfMs - 1,
      open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0,
    }));
    if (!bars.length) throw new Error('No bars yet');
    const info = symbolInfo(m.symbol, bars, m.pointValueOverride);
    const provider = makeProvider(bars, m.tf || '1', m.tfMs, info);
    const cfg = m.settings || {};
    let src = prepareSource(m.script.code);
    const declIsStrategy = /^\s*strategy\s*\(/m.test(src);
    if (declIsStrategy && Number(cfg.maxTradesPerDay) > 0) {
      const inj = injectDailyLimit(src, Math.floor(Number(cfg.maxTradesPerDay)), cfg.dayReset);
      src = inj.src; lineShift = inj;
    }
    const ind = new PineTSLib.Indicator(src, { ...(cfg.inputs || {}) });
    try { meta.inputs = ind.getInputsMeta().map(cleanMeta); } catch (_) {}
    try { meta.props = ind.getPropsMeta().filter((x) => x.mutable).map(cleanMeta); } catch (_) {}
    meta.declType = declIsStrategy ? 'strategy' : 'indicator';
    for (const [k, v] of Object.entries(cfg.props || {})) {
      if (v === undefined || v === null || v === '') continue;
      try { ind.prop[k] = v; } catch (e) { warnings.push(`Property ${k}: ${e.message}`); }
    }
    const pine = new PineTS(provider, info.ticker, m.tf || '1', bars.length);
    try { pine.setTimezone && pine.setTimezone(m.timezone || 'America/New_York'); } catch (_) {}
    const ctx = await pine.run(ind);

    const isStrategy = /^\s*strategy\s*\(/m.test(m.script.code);
    const decl = isStrategy ? (ctx.strategy && ctx.strategy.config) : ctx.indicator;
    if (decl) { try { meta.effective = JSON.parse(JSON.stringify(decl)); } catch (_) {} }
    const overlay = decl ? !!decl.overlay : false;
    const title = (decl && (decl.shorttitle || decl.title)) || m.script.name;

    // map bar open time -> index in the bars we sent
    const idxOf = new Map();
    for (let i = 0; i < bars.length; i++) idxOf.set(bars[i].openTime, i);
    const n = bars.length;

    const plots = [];
    const drawings = { labels: [], lines: [], boxes: [], linefills: [], polylines: [], tables: [] };

    for (const [key, p] of Object.entries(ctx.plots || {})) {
      const opts = p.options || {};
      if (key.startsWith('__')) {
        const last = p.data && p.data[p.data.length - 1];
        const items = (last && Array.isArray(last.value) ? last.value : []).filter((d) => d && !d._deleted);
        const bucket = key.replace(/__/g, '');
        if (drawings[bucket]) drawings[bucket] = items.map(cleanDrawing).map((o) => normDrawing(bucket, o));
        continue;
      }
      const style = opts.style || 'line';
      if (style === 'fill') {
        const colors = new Array(n).fill(null);
        for (const d of p.data || []) {
          const i = idxOf.get(d.time);
          if (i !== undefined) colors[i] = (d.options && d.options.color) !== undefined ? d.options.color : opts.color;
        }
        plots.push({ title: key, style: 'fill', plot1: opts.plot1, plot2: opts.plot2, color: col(opts.color), colors: colors.map(col) });
        continue;
      }
      const values = new Array(n).fill(null);
      const colors = new Array(n).fill(undefined);
      let anyColor = false;
      for (const d of p.data || []) {
        const i = idxOf.get(d.time);
        if (i === undefined) continue;
        values[i] = toNum(d.value);
        if (d.options && 'color' in d.options) { colors[i] = col(d.options.color); anyColor = true; }
      }
      plots.push({
        title: p.title || key,
        style,
        color: col(opts.color),
        linewidth: opts.linewidth || 1,
        shape: opts.shape, location: opts.location, size: opts.size, char: opts.char, text: opts.text,
        textcolor: col(opts.textcolor),
        values,
        colors: anyColor ? colors : null,
      });
    }

    let strategy = null;
    if (isStrategy && ctx.strategy) {
      const s = ctx.strategy;
      const tr = (t) => ({
        entryId: t.entry_id, entryPrice: t.entry_price, entryBar: t.entry_bar_index, entryTime: t.entry_time,
        exitId: t.exit_id, exitPrice: t.exit_price, exitBar: t.exit_bar_index, exitTime: t.exit_time,
        size: t.size, profit: t.profit, status: t.status, entryComment: t.entry_comment, exitComment: t.exit_comment,
      });
      const closed = (s.closedtrades || []).map(tr);
      const open = (s.opentrades || []).map(tr);
      const wins = closed.filter((t) => (t.profit || 0) > 0);
      const losses = closed.filter((t) => (t.profit || 0) < 0);
      const gp = wins.reduce((a, t) => a + t.profit, 0);
      const gl = -losses.reduce((a, t) => a + t.profit, 0);
      // max drawdown on closed-trade equity curve (points * qty)
      let eq = 0, peak = 0, mdd = 0;
      for (const t of closed) { eq += t.profit || 0; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); }
      strategy = {
        closed, open,
        stats: {
          netProfit: closed.reduce((a, t) => a + (t.profit || 0), 0),
          openProfit: num(s.openprofit),
          trades: closed.length, wins: wins.length, losses: losses.length,
          grossProfit: gp, grossLoss: gl,
          profitFactor: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0),
          maxDrawdown: mdd,
          positionSize: num(s.position_size),
          positionAvgPrice: num(s.position_avg_price),
        },
      };
    }

    return {
      ...base, ok: true, ms: Math.round(performance.now() - t0),
      payload: { title, overlay, isStrategy, n, firstTime: bars[0].openTime, plots, drawings, strategy, pointValue: info.pointvalue, mintick: info.mintick },
      meta: { ...meta, plots: plots.map((x) => ({ title: x.title, style: x.style, color: x.color, linewidth: x.linewidth })) },
      warnings: warnings.concat((ctx.warnings || []).slice(0, 5).map(String)),
    };
  } catch (err) {
    let msg = (err && (err.message || String(err))) || 'Unknown error';
    if (lineShift) msg = msg.replace(/(at |\()(\d+):(\d+)/g, (all, pre, r, c) => (+r > lineShift.afterLine ? `${pre}${+r - lineShift.count}:${c}` : all));
    return { ...base, ok: false, error: msg, meta };
  }
}

function num(v) {
  if (v && typeof v === 'object' && 'value' in v) v = v.value;
  if (Array.isArray(v)) v = v[v.length - 1];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// Pine defaults when PineTS leaves a color as "" (default) — na colors become null (invisible).
function normDrawing(kind, o) {
  const dflt = (v, d) => (v === '' || v === undefined ? d : col(v));
  if (kind === 'labels') { o.color = dflt(o.color, '#2962FF'); o.textcolor = dflt(o.textcolor, '#FFFFFF'); }
  else if (kind === 'lines') o.color = dflt(o.color, '#2962FF');
  else if (kind === 'boxes') { o.border_color = dflt(o.border_color, '#2962FF'); o.bgcolor = dflt(o.bgcolor, '#2962FF33'); o.text_color = dflt(o.text_color, '#000000'); }
  else if (kind === 'linefills') o.color = col(o.color);
  else if (kind === 'polylines') { o.line_color = dflt(o.line_color, '#2962FF'); o.fill_color = col(o.fill_color); }
  return o;
}

function cleanDrawing(d) {
  const o = {};
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'function') continue;
    if (v && typeof v === 'object') {
      try { o[k] = JSON.parse(JSON.stringify(v)); } catch (_) {}
    } else o[k] = v;
  }
  return o;
}

window.parent.postMessage({ __pinetsOverlay: true, type: 'ready' }, '*');
