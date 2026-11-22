// MAIN-world script for terminal.tradara.com.
// Finds Tradara's chart controller (via React internals), reads its bars, sends them to the
// extension (content.js -> sandboxed PineTS), and draws the results on a transparent canvas
// layered over the chart using Tradara's own price/time -> pixel conversions.
(() => {
  'use strict';
  if (window.__pinetsOverlayLoaded) return;
  window.__pinetsOverlayLoaded = true;

  const TAG = '__pinetsOverlay';
  const LOG = (...a) => console.debug('[PineTS Overlay]', ...a);

  let config = { settings: { enabled: true, maxBars: 5000, strategyClosedBarsOnly: true, showTrades: true, showHud: true, pointValue: 0 }, scripts: [] };
  let configVersion = 0;
  let notes = []; // chart notes (text boxes) from the manager
  let chartSeq = 0;
  const charts = new Map(); // chartKey -> state
  const keyByCanvas = new WeakMap();

  // ---------- messaging ----------
  function toContent(msg) { window.postMessage({ [TAG]: true, dir: 'toContent', ...msg }, location.origin); }

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

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m[TAG] !== true || m.dir !== 'toPage') return;
    if (m.type === 'config') {
      config = { settings: m.settings, scripts: m.scripts };
      notes = Array.isArray(m.notes) ? m.notes : [];
      configVersion++;
      // drop results for scripts that were removed/disabled
      const live = new Set(config.scripts.filter((s) => s.enabled && !(s.settings && s.settings.hidden)).map((s) => s.id));
      for (const st of charts.values()) {
        for (const id of [...st.results.keys()]) if (!live.has(id)) st.results.delete(id);
        st.forceSend = true;
        st.dirty = true;
      }
    } else if (m.type === 'result') {
      const st = charts.get(m.chartKey);
      if (!st) return;
      st.results.set(m.scriptId, { ok: m.ok, error: m.error, payload: m.payload, offsetCache: null });
      st.dirty = true;
    }
  });
  toContent({ type: 'hello' });

  // ---------- chart discovery ----------
  function findController(canvas) {
    const host = canvas.parentElement;
    if (!host) return null;
    const fk = Object.keys(host).find((k) => k.startsWith('__reactFiber'));
    let f = fk && host[fk];
    for (let depth = 0; f && depth < 30; depth++, f = f.return) {
      let h = f.memoizedState;
      for (let i = 0; h && i < 150; i++, h = h.next) {
        const v = h.memoizedState;
        const c = v && typeof v === 'object' && 'current' in v ? v.current : null;
        if (c && typeof c === 'object' && typeof c.priceToPixel === 'function' &&
            typeof c.barIndexToPixel === 'function' && c.engine && typeof c.engine.getDisplayBars === 'function') {
          return c;
        }
      }
    }
    return null;
  }

  let warnedNoCtl = false;
  function discover() {
    const seen = new Set();
    for (const canvas of document.querySelectorAll('canvas')) {
      if (canvas.dataset.pinetsOverlay) continue;
      const host = canvas.parentElement;
      const label = host && host.getAttribute('aria-label');
      if (!label || !/price chart$/i.test(label)) continue;
      let key = keyByCanvas.get(canvas);
      let st = key && charts.get(key);
      if (!st) {
        const ctl = findController(canvas);
        if (!ctl) {
          if (!warnedNoCtl) { warnedNoCtl = true; LOG('Chart found but controller not located (Tradara may have changed internals).'); }
          continue;
        }
        key = 'c' + (++chartSeq);
        keyByCanvas.set(canvas, key);
        st = makeState(key, canvas, ctl);
        charts.set(key, st);
        hookUpdates(st);
        LOG('Attached to chart', key, label);
      } else if (!st.ctl || st.ctl.engine?.destroyed) {
        const ctl = findController(canvas);
        if (ctl) { st.ctl = ctl; st.forceSend = true; }
      }
      const sym = symbolFromLabel(label);
      if (sym !== st.symbol) { st.symbol = sym; st.results.clear(); st.forceSend = true; st.dirty = true; }
      seen.add(key);
    }
    for (const [key, st] of charts) {
      if (!seen.has(key) && !st.canvas.isConnected) {
        st.overlay.remove();
        if (st.legendHost) st.legendHost.remove();
        if (st.notesHost) st.notesHost.remove();
        charts.delete(key);
        toContent({ type: 'chartGone', chartKey: key });
      }
    }
  }

  // When Tradara pushes new data into the chart, check bars right away. Browsers pause animation frames and
  // throttle timers in background tabs, so this keeps alerts on time while you're on another tab.
  function hookUpdates(st) {
    const targets = [[st.ctl, 'updateLastBar'], [st.ctl, 'setData'], [st.ctl.engine, 'updateLastBar'], [st.ctl.engine, 'setData']];
    for (const [obj, name] of targets) {
      const orig = obj && obj[name];
      if (typeof orig !== 'function' || orig.__ptoHooked) continue;
      const wrapped = function (...args) {
        const r = orig.apply(this, args);
        if (document.hidden) { try { st.nextBarsPoll = 0; queueMicrotask(() => { try { pollBars(st, performance.now()); } catch (_) {} }); } catch (_) {} }
        return r;
      };
      wrapped.__ptoHooked = true;
      try { obj[name] = wrapped; } catch (_) {}
    }
  }

  function symbolFromLabel(label) {
    return label.replace(/\s*price chart$/i, '').replace(/^\//, '').trim() || 'SYMBOL';
  }

  function makeState(key, canvas, ctl) {
    const overlay = document.createElement('canvas');
    overlay.dataset.pinetsOverlay = '1';
    Object.assign(overlay.style, { position: 'absolute', pointerEvents: 'none', zIndex: '2', left: '0px', top: '0px' });
    canvas.parentElement.appendChild(overlay);
    return {
      key, canvas, ctl, overlay, g: overlay.getContext('2d'),
      symbol: symbolFromLabel(canvas.parentElement.getAttribute('aria-label') || ''),
      results: new Map(), lastBarsSig: '', lastSendAt: 0, lastBarCount: 0, lastLastTime: 0,
      forceSend: true, dirty: true, viewSig: '', bars: null, nextBarsPoll: 0,
    };
  }

  // ---------- bars ----------
  function tfInfo(bars) {
    const diffs = [];
    for (let i = Math.max(1, bars.length - 60); i < bars.length; i++) {
      const d = bars[i].time - bars[i - 1].time;
      if (d > 0) diffs.push(d);
    }
    diffs.sort((a, b) => a - b);
    const ms = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 60000;
    let tf;
    if (ms < 60000) tf = Math.max(1, Math.round(ms / 1000)) + 'S';
    else if (ms < 86400000) tf = String(Math.round(ms / 60000));
    else if (ms < 7 * 86400000) tf = 'D';
    else if (ms < 28 * 86400000) tf = 'W';
    else tf = 'M';
    return { ms, tf };
  }

  function pollBars(st, now) {
    if (now < st.nextBarsPoll) return;
    st.nextBarsPoll = now + 250;
    let bars;
    try { bars = st.ctl.engine.getDisplayBars(); } catch (_) { return; }
    if (!Array.isArray(bars) || !bars.length) return;
    st.bars = bars;
    if (!st.tfMs || bars.length !== st.lastBarCount) st.tfMs = tfInfo(bars).ms;
    const last = bars[bars.length - 1];
    const sig = bars.length + '|' + bars[0].time + '|' + last.time + '|' + last.close + '|' + last.high + '|' + last.low;
    if (sig === st.lastBarsSig && !st.forceSend) return;
    st.dirty = true; // last bar moved (open trade P&L, etc.)
    const newBar = last.time !== st.lastLastTime || bars.length !== st.lastBarCount;
    // new bar or history change -> run now; ticks on the forming bar -> at most once per second
    if (!newBar && !st.forceSend && now - st.lastSendAt < 1000) return;
    st.lastBarsSig = sig;
    st.lastBarCount = bars.length;
    st.lastLastTime = last.time;
    st.lastSendAt = now;
    st.forceSend = false;
    if (!config.settings.enabled || !config.scripts.some((s) => s.enabled)) return;
    const maxBars = Math.max(100, Number(config.settings.maxBars) || 5000);
    const slice = bars.length > maxBars ? bars.slice(bars.length - maxBars) : bars;
    const { ms, tf } = tfInfo(bars);
    toContent({
      type: 'bars', chartKey: st.key, symbol: st.symbol, tf, tfMs: ms,
      lastBarForming: last.time + ms > Date.now(),
      bars: slice.map((b) => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume || 0 })),
    });
  }

  function findIndexByTime(bars, t) {
    let lo = 0, hi = bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = bars[mid].time;
      if (v === t) return mid;
      if (v < t) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  // ---------- rendering helpers ----------
  const SIZE_PX = { tiny: 6, small: 9, normal: 12, auto: 10, large: 18, huge: 26 };
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  function fmtMoney(v) {
    const sign = v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function drawShape(g, shape, x, y, size, color, pointsUp) {
    const s = size;
    g.fillStyle = color; g.strokeStyle = color; g.lineWidth = Math.max(1, s / 6);
    g.beginPath();
    switch (shape) {
      case 'shape_triangle_up': case 'triangleup':
        g.moveTo(x, y - s / 2); g.lineTo(x + s / 2, y + s / 2); g.lineTo(x - s / 2, y + s / 2); g.closePath(); g.fill(); break;
      case 'shape_triangle_down': case 'triangledown':
        g.moveTo(x, y + s / 2); g.lineTo(x + s / 2, y - s / 2); g.lineTo(x - s / 2, y - s / 2); g.closePath(); g.fill(); break;
      case 'shape_arrow_up': case 'arrowup':
        g.moveTo(x, y - s / 2); g.lineTo(x + s / 2, y); g.lineTo(x + s / 5, y); g.lineTo(x + s / 5, y + s / 2);
        g.lineTo(x - s / 5, y + s / 2); g.lineTo(x - s / 5, y); g.lineTo(x - s / 2, y); g.closePath(); g.fill(); break;
      case 'shape_arrow_down': case 'arrowdown':
        g.moveTo(x, y + s / 2); g.lineTo(x + s / 2, y); g.lineTo(x + s / 5, y); g.lineTo(x + s / 5, y - s / 2);
        g.lineTo(x - s / 5, y - s / 2); g.lineTo(x - s / 5, y); g.lineTo(x - s / 2, y); g.closePath(); g.fill(); break;
      case 'shape_circle': case 'circle':
        g.arc(x, y, s / 2, 0, Math.PI * 2); g.fill(); break;
      case 'shape_square': case 'square':
        g.rect(x - s / 2, y - s / 2, s, s); g.fill(); break;
      case 'shape_diamond': case 'diamond':
        g.moveTo(x, y - s / 2); g.lineTo(x + s / 2, y); g.lineTo(x, y + s / 2); g.lineTo(x - s / 2, y); g.closePath(); g.fill(); break;
      case 'shape_cross': case 'cross':
        g.moveTo(x - s / 2, y); g.lineTo(x + s / 2, y); g.moveTo(x, y - s / 2); g.lineTo(x, y + s / 2); g.stroke(); break;
      case 'shape_flag': case 'flag':
        g.moveTo(x - s / 3, y + s / 2); g.lineTo(x - s / 3, y - s / 2); g.lineTo(x + s / 2, y - s / 4); g.lineTo(x - s / 3, y); g.stroke(); g.fill(); break;
      case 'shape_label_up': case 'labelup':
        g.moveTo(x, y - s / 2); g.lineTo(x + s / 3, y - s / 5); g.lineTo(x + s / 2, y - s / 5); g.lineTo(x + s / 2, y + s / 2);
        g.lineTo(x - s / 2, y + s / 2); g.lineTo(x - s / 2, y - s / 5); g.lineTo(x - s / 3, y - s / 5); g.closePath(); g.fill(); break;
      case 'shape_label_down': case 'labeldown':
        g.moveTo(x, y + s / 2); g.lineTo(x + s / 3, y + s / 5); g.lineTo(x + s / 2, y + s / 5); g.lineTo(x + s / 2, y - s / 2);
        g.lineTo(x - s / 2, y - s / 2); g.lineTo(x - s / 2, y + s / 5); g.lineTo(x - s / 3, y + s / 5); g.closePath(); g.fill(); break;
      case 'shape_xcross': case 'xcross': default:
        g.moveTo(x - s / 2, y - s / 2); g.lineTo(x + s / 2, y + s / 2); g.moveTo(x + s / 2, y - s / 2); g.lineTo(x - s / 2, y + s / 2); g.stroke(); break;
    }
  }

  function setDash(g, style, width) {
    if (style === 'style_dashed' || style === 'dashed') g.setLineDash([6, 4]);
    else if (style === 'style_dotted' || style === 'dotted') g.setLineDash([Math.max(1, width), 3]);
    else g.setLineDash([]);
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  }

  function drawLabel(g, x, y, text, style, bg, fg, sizeName, align) {
    const fs = { tiny: 9, small: 10, normal: 11, auto: 11, large: 14, huge: 18 }[sizeName] || 11;
    g.font = `${fs}px -apple-system, Segoe UI, Roboto, sans-serif`;
    const lines = String(text ?? '').split('\n');
    const tw = Math.max(0, ...lines.map((l) => g.measureText(l).width));
    const pad = 4, lh = fs + 2;
    const w = tw + pad * 2, h = lines.length * lh + pad * 2 - 2;
    const st = style || 'style_label_down';
    const textOnly = st === 'style_none' || !bg;
    if (!text && !textOnly && !st.startsWith('style_label')) {
      drawShape(g, st.replace('style_', 'shape_'), x, y, SIZE_PX[sizeName] || 10, bg || '#2962FF');
      return;
    }
    let bx = x - w / 2, by;
    const tip = 5;
    if (st === 'style_label_up') by = y + tip;
    else if (st === 'style_label_left') { bx = x + tip; by = y - h / 2; }
    else if (st === 'style_label_right') { bx = x - w - tip; by = y - h / 2; }
    else if (st === 'style_label_center' || textOnly) by = y - h / 2;
    else by = y - h - tip; // label_down (default)
    if (!textOnly) {
      g.fillStyle = bg;
      roundRect(g, bx, by, w, h, 3); g.fill();
      g.beginPath();
      if (st === 'style_label_up') { g.moveTo(x, y); g.lineTo(x - tip, y + tip); g.lineTo(x + tip, y + tip); }
      else if (st === 'style_label_left') { g.moveTo(x, y); g.lineTo(x + tip, y - tip); g.lineTo(x + tip, y + tip); }
      else if (st === 'style_label_right') { g.moveTo(x, y); g.lineTo(x - tip, y - tip); g.lineTo(x - tip, y + tip); }
      else if (st !== 'style_label_center') { g.moveTo(x, y); g.lineTo(x - tip, y - tip); g.lineTo(x + tip, y - tip); }
      g.closePath(); g.fill();
    }
    g.fillStyle = fg || (textOnly ? (bg || '#d1d4dc') : '#ffffff');
    g.textBaseline = 'top';
    g.textAlign = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
    const tx = g.textAlign === 'left' ? bx + pad : g.textAlign === 'right' ? bx + w - pad : bx + w / 2;
    lines.forEach((l, i) => g.fillText(l, tx, by + pad + i * lh));
  }

  // ---------- main draw ----------
  function draw(st) {
    const { ctl, canvas, overlay, g } = st;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (overlay.width !== Math.round(cssW * dpr) || overlay.height !== Math.round(cssH * dpr)) {
      overlay.width = Math.round(cssW * dpr); overlay.height = Math.round(cssH * dpr);
    }
    overlay.style.width = cssW + 'px'; overlay.style.height = cssH + 'px';
    overlay.style.left = canvas.offsetLeft + 'px'; overlay.style.top = canvas.offsetTop + 'px';
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    renderNotes(st);
    if (!config.settings.enabled || !st.bars) { if (st.legendHost) st.legendHost.style.display = 'none'; return; }

    const pane = (ctl.mainPaneFrame && ctl.mainPaneFrame()) || { top: 0, bottom: cssH, width: cssW };
    const PX0 = 0, PX1 = pane.width, PY0 = pane.top, PY1 = pane.bottom;
    const bars = st.bars;
    const X = (i) => ctl.barIndexToPixel(i);
    const Y = (p) => ctl.priceToPixel(p);
    let L = Math.floor(ctl.pixelToBarIndex(PX0) ?? 0) - 2;
    let R = Math.ceil(ctl.pixelToBarIndex(PX1) ?? bars.length) + 2;
    L = Math.max(0, L);
    const x0 = X(Math.max(0, bars.length - 2)), x1 = X(Math.max(1, bars.length - 1));
    const bs = Math.max(1, isNum(x0) && isNum(x1) ? Math.abs(x1 - x0) : 6);

    // collect enabled, successful results in script order
    const ordered = config.scripts
      .filter((s) => s.enabled && !(s.settings && s.settings.hidden) && visibleOn(s.settings && s.settings.visibility, st.tfMs))
      .map((s) => ({ s, r: st.results.get(s.id) })).filter((o) => o.r);
    for (const o of ordered) {
      if (!o.r.ok || !o.r.payload) continue;
      const p = o.r.payload;
      const cacheKey = bars.length + ':' + bars[0].time;
      if (!o.r.offsetCache || o.r.offsetCache.k !== cacheKey) {
        o.r.offsetCache = { k: cacheKey, off: findIndexByTime(bars, p.firstTime) };
      }
      o.off = o.r.offsetCache.off;
    }

    // panes for non-overlay scripts, stacked at the bottom of the main pane
    const lower = ordered.filter((o) => o.r.ok && o.r.payload && !o.r.payload.overlay && o.off >= 0);
    const paneH = PY1 - PY0;
    const bandH = lower.length ? Math.min(110, (paneH * 0.3) / lower.length) : 0;
    lower.forEach((o, k) => { o.band = { top: PY1 - bandH * (lower.length - k), bottom: PY1 - bandH * (lower.length - k - 1) }; });

    g.save();
    g.beginPath(); g.rect(PX0, PY0, PX1 - PX0, PY1 - PY0); g.clip();

    for (const o of ordered) {
      if (!o.r.ok || !o.r.payload || o.off < 0) continue;
      const p = o.r.payload;
      const off = o.off;
      const iFrom = Math.max(0, L - off), iTo = Math.min(p.n - 1, R - off);
      let yOf = Y, top = PY0, bottom = PY1;
      if (o.band) {
        top = o.band.top; bottom = o.band.bottom;
        // autoscale over visible values
        let mn = Infinity, mx = -Infinity;
        for (const pl of p.plots) {
          if (pl.style === 'fill' || pl.style === 'background' || pl.style === 'shape' || pl.style === 'char' || pl.style === 'barcolor' || pl.style === 'arrow') continue;
          if (pl.style === 'hline') { const v = lastVal(pl.values); if (isNum(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); } continue; }
          for (let i = iFrom; i <= iTo; i++) { const v = pl.values[i]; if (isNum(v)) { if (v < mn) mn = v; if (v > mx) mx = v; } }
          if (/histogram|columns/.test(pl.style)) { mn = Math.min(mn, 0); mx = Math.max(mx, 0); }
        }
        if (!isFinite(mn)) { mn = 0; mx = 1; }
        if (mx === mn) { mx += 1; mn -= 1; }
        const pad = 6, h = bottom - top - pad * 2;
        yOf = (v) => bottom - pad - ((v - mn) / (mx - mn)) * h;
        g.fillStyle = 'rgba(12,14,22,0.6)';
        g.fillRect(PX0, top, PX1 - PX0, bottom - top);
        g.strokeStyle = 'rgba(255,255,255,0.15)'; g.lineWidth = 1; g.setLineDash([]);
        g.beginPath(); g.moveTo(PX0, top + 0.5); g.lineTo(PX1, top + 0.5); g.stroke();
        g.fillStyle = 'rgba(209,212,220,0.9)'; g.font = '11px -apple-system, Segoe UI, Roboto, sans-serif';
        g.textAlign = 'left'; g.textBaseline = 'top';
        g.fillText(p.title, PX0 + 6, top + 4);
        g.textAlign = 'right';
        g.fillText(fmtNum(mx), PX1 - 4, top + 4);
        g.textBaseline = 'bottom';
        g.fillText(fmtNum(mn), PX1 - 4, bottom - 2);
      }
      const style = (o.s.settings && o.s.settings.style) || {};
      const ctx = { g, ctl, X, yOf, off, iFrom, iTo, bs, top, bottom, PX0, PX1, bars, overlay: !o.band, style, alerts: o.s.settings && o.s.settings.alerts };
      renderPlots(ctx, p);
      renderDrawings(ctx, p);
      if (p.strategy && config.settings.showTrades !== false) renderTrades(ctx, p, Y);
      const al = o.s.settings && o.s.settings.alerts;
      if (Array.isArray(p.alertSignals) && (!al || al.showTags !== false)) renderAlertTags(ctx, p);
    }
    g.restore();

    updateLegend(st, PX1, PY0);
  }

  function fmtNum(v) {
    const a = Math.abs(v);
    return a >= 1000 ? v.toFixed(0) : a >= 10 ? v.toFixed(2) : v.toFixed(4);
  }
  function lastVal(arr) { for (let i = arr.length - 1; i >= 0; i--) if (isNum(arr[i])) return arr[i]; return null; }

  function renderPlots(c, p) {
    const { g, X, yOf, off, iFrom, iTo, bs, top, bottom, PX0, PX1, bars } = c;
    const byTitle = new Map(p.plots.map((pl) => [pl.title, pl]));
    const ps = (pl) => (c.style && c.style.plots && c.style.plots[pl.title]) || {};
    const colorAt = (pl, i) => {
      const base = pl.colors && pl.colors[i] !== undefined ? pl.colors[i] : pl.color;
      const o = ps(pl).color;
      return base && o ? o : base; // keep na (hidden) bars hidden
    };
    const shown = (pl) => ps(pl).visible !== false;
    const l0 = yOf;

    // backgrounds first
    for (const pl of p.plots) {
      if (pl.style !== 'background' || !shown(pl)) continue;
      for (let i = iFrom; i <= iTo; i++) {
        if (!pl.values[i]) continue;
        const col = colorAt(pl, i); if (!col) continue;
        const x = X(off + i); if (!isNum(x)) continue;
        g.fillStyle = col; g.fillRect(x - bs / 2, top, bs, bottom - top);
      }
    }
    // barcolor(): repaint the candle on top of Tradara's own (only meaningful on the price pane)
    if (c.overlay) {
      for (const pl of p.plots) {
        if (pl.style !== 'barcolor' || !shown(pl)) continue;
        const bw = Math.max(1, Math.round(bs * 0.7));
        for (let i = iFrom; i <= iTo; i++) {
          if (pl.values[i] === null) continue;
          const colr = colorAt(pl, i); if (!colr) continue;
          const bar = bars[off + i]; const x = X(off + i); if (!bar || !isNum(x)) continue;
          const yo = l0(bar.open), yc = l0(bar.close), yh = l0(bar.high), yl = l0(bar.low);
          g.fillStyle = colr; g.strokeStyle = colr; g.lineWidth = 1;
          g.beginPath(); g.moveTo(Math.round(x) + 0.5, yh); g.lineTo(Math.round(x) + 0.5, yl); g.stroke();
          g.fillRect(Math.round(x - bw / 2), Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
        }
      }
    }
    // fills
    for (const pl of p.plots) {
      if (pl.style !== 'fill' || !shown(pl)) continue;
      const a = byTitle.get(pl.plot1), b = byTitle.get(pl.plot2);
      if (!a || !b) continue;
      const va = (i) => (a.style === 'hline' ? lastVal(a.values) : a.values[i]);
      const vb = (i) => (b.style === 'hline' ? lastVal(b.values) : b.values[i]);
      for (let i = Math.max(0, iFrom - 1); i < iTo; i++) {
        const col = colorAt(pl, i); if (!col) continue;
        const a0 = va(i), a1 = va(i + 1), b0 = vb(i), b1 = vb(i + 1);
        if (![a0, a1, b0, b1].every(isNum)) continue;
        const xa = X(off + i), xb = X(off + i + 1);
        g.fillStyle = col; g.beginPath();
        g.moveTo(xa, yOf(a0)); g.lineTo(xb, yOf(a1)); g.lineTo(xb, yOf(b1)); g.lineTo(xa, yOf(b0)); g.closePath(); g.fill();
      }
    }
    for (const pl of p.plots) {
      const st = pl.style;
      if (st === 'background' || st === 'fill' || st === 'barcolor' || !shown(pl)) continue;
      const lw = ps(pl).linewidth || pl.linewidth || 1;
      if (st === 'hline') {
        const v = lastVal(pl.values); const hc = colorAt(pl, pl.values.length - 1); if (!isNum(v) || !hc) continue;
        g.strokeStyle = hc; g.lineWidth = lw; g.setLineDash([4, 4]);
        const y = Math.round(yOf(v)) + 0.5; g.beginPath(); g.moveTo(PX0, y); g.lineTo(PX1, y); g.stroke(); g.setLineDash([]);
        continue;
      }
      if (st === 'arrow') {
        // plotarrow(): up arrows below the bar for positive values, down arrows above for negative
        let maxAbs = 0;
        for (let i = iFrom; i <= iTo; i++) { const v = pl.values[i]; if (isNum(v)) maxAbs = Math.max(maxAbs, Math.abs(v)); }
        const hMin = pl.minheight || 5, hMax = pl.maxheight || 100;
        for (let i = iFrom; i <= iTo; i++) {
          const v = pl.values[i];
          if (!isNum(v) || v === 0) continue;
          const colr = colorAt(pl, i); if (!colr) continue;
          const bar = bars[off + i]; const x = X(off + i); if (!bar || !isNum(x)) continue;
          const up = v > 0;
          const h = Math.min(hMax, Math.max(hMin, maxAbs ? hMin + (hMax - hMin) * Math.abs(v) / maxAbs : hMax)) * 0.8;
          const anchor = up ? (c.overlay ? c.yOf(bar.low) + 4 : bottom - 2) : (c.overlay ? c.yOf(bar.high) - 4 : top + 2);
          const headW = Math.max(5, Math.min(12, bs * 0.9)), headH = Math.min(h * 0.45, headW * 1.1);
          const shaftW = Math.max(1.5, headW * 0.32);
          const dir = up ? 1 : -1; // 1: tip at anchor, body extends downward
          g.fillStyle = colr; g.beginPath();
          g.moveTo(x, anchor);
          g.lineTo(x + headW / 2, anchor + dir * headH);
          g.lineTo(x + shaftW / 2, anchor + dir * headH);
          g.lineTo(x + shaftW / 2, anchor + dir * h);
          g.lineTo(x - shaftW / 2, anchor + dir * h);
          g.lineTo(x - shaftW / 2, anchor + dir * headH);
          g.lineTo(x - headW / 2, anchor + dir * headH);
          g.closePath(); g.fill();
        }
        continue;
      }
      if (st === 'shape' || st === 'char') {
        const size = SIZE_PX[pl.size] || (st === 'char' ? 12 : 10);
        for (let i = iFrom; i <= iTo; i++) {
          const v = pl.values[i];
          if (v === null || v === 0) continue;
          const col = colorAt(pl, i) || '#2962FF';
          const bar = bars[off + i]; const x = X(off + i); if (!bar || !isNum(x)) continue;
          const loc = ((pl.locs && pl.locs[i]) || pl.location || 'AboveBar').toLowerCase();
          let y; let below = false;
          if (loc === 'abovebar') y = (c.overlay ? c.yOf(bar.high) : top + 14) - size / 2 - 4;
          else if (loc === 'belowbar') { y = (c.overlay ? c.yOf(bar.low) : bottom - 14) + size / 2 + 4; below = true; }
          else if (loc === 'top') y = top + size / 2 + 2;
          else if (loc === 'bottom') { y = bottom - size / 2 - 2; below = true; }
          else if (loc === 'absolute') y = yOf(v);
          else y = yOf(v);
          if (!isNum(y)) continue;
          if (st === 'char') {
            g.fillStyle = col; g.font = `${size}px -apple-system, Segoe UI, Roboto, sans-serif`;
            g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(pl.char || '★', x, y);
          } else drawShape(g, (pl.shapes && pl.shapes[i]) || pl.shape || 'shape_xcross', x, y, size, col);
          if (pl.text) {
            g.fillStyle = pl.textcolor || col; g.font = '10px -apple-system, Segoe UI, Roboto, sans-serif'; g.textAlign = 'center';
            g.textBaseline = below ? 'top' : 'bottom';
            String(pl.text).split('\n').forEach((t, k, arr) => {
              const dy = below ? size / 2 + 2 + k * 11 : -size / 2 - 2 - (arr.length - 1 - k) * 11;
              g.fillText(t, x, y + dy);
            });
          }
        }
        continue;
      }
      if (/histogram|columns/.test(st)) {
        const base = c.overlay ? null : yOf(0);
        for (let i = iFrom; i <= iTo; i++) {
          const v = pl.values[i]; if (!isNum(v)) continue;
          const col = colorAt(pl, i); if (!col) continue;
          const x = X(off + i), y = yOf(v), y0 = base ?? bottom;
          g.fillStyle = col;
          const w = st.includes('columns') ? Math.max(1, bs * 0.7) : Math.max(1, lw);
          g.fillRect(x - w / 2, Math.min(y, y0), w, Math.abs(y0 - y) || 1);
        }
        continue;
      }
      if (/circles|cross/.test(st)) {
        for (let i = iFrom; i <= iTo; i++) {
          const v = pl.values[i]; if (!isNum(v)) continue;
          const col = colorAt(pl, i); if (!col) continue;
          const x = X(off + i), y = yOf(v);
          if (st.includes('circles')) { g.fillStyle = col; g.beginPath(); g.arc(x, y, lw + 1, 0, Math.PI * 2); g.fill(); }
          else drawShape(g, 'shape_cross', x, y, 4 + lw * 2, col);
        }
        continue;
      }
      // line-family: line, linebr, stepline, area, areabr
      const step = st.includes('step');
      const area = st.includes('area');
      g.lineWidth = lw; g.setLineDash([]); g.lineJoin = 'round';
      for (let i = Math.max(0, iFrom - 1); i < iTo; i++) {
        const v0 = pl.values[i], v1 = pl.values[i + 1];
        if (!isNum(v0) || !isNum(v1)) continue;
        const col = colorAt(pl, i + 1); if (!col) continue;
        const xa = X(off + i), xb = X(off + i + 1), ya = yOf(v0), yb = yOf(v1);
        if (area) {
          g.fillStyle = col; g.globalAlpha = 0.2;
          g.beginPath(); g.moveTo(xa, ya); g.lineTo(xb, yb); g.lineTo(xb, bottom); g.lineTo(xa, bottom); g.closePath(); g.fill();
          g.globalAlpha = 1;
        }
        g.strokeStyle = col; g.beginPath(); g.moveTo(xa, ya);
        if (step) { g.lineTo(xb, ya); g.lineTo(xb, yb); } else g.lineTo(xb, yb);
        g.stroke();
      }
    }
  }

  function renderDrawings(c, p) {
    const { g, X, yOf, off, bars, PX0, PX1 } = c;
    const d0 = p.drawings || {};
    const dt = (c.style && c.style.drawings) || {};
    const d = {
      boxes: dt.boxes === false ? [] : d0.boxes, labels: dt.labels === false ? [] : d0.labels,
      lines: dt.lines === false ? [] : d0.lines, linefills: dt.lines === false ? [] : d0.linefills, polylines: dt.lines === false ? [] : d0.polylines,
    };
    const xOf = (x, xloc) => {
      if (xloc === 'bt' || xloc === 'bar_time') {
        const i = findIndexByTime(bars, x);
        if (i >= 0) return X(i);
        try { return c.ctl.timeToPixel(x); } catch (_) { return null; }
      }
      return X(off + x);
    };
    const yLoc = (x, y, yloc, xloc) => {
      if (yloc === 'ab' || yloc === 'abovebar') { const b = bars[off + x]; return b ? yOf(b.high) - 2 : null; }
      if (yloc === 'bl' || yloc === 'belowbar') { const b = bars[off + x]; return b ? yOf(b.low) + 2 : null; }
      return yOf(y);
    };

    for (const b of d.boxes || []) {
      let xa = xOf(b.left, b.xloc), xb = xOf(b.right, b.xloc);
      if (!isNum(xa) || !isNum(xb)) continue;
      if (b.extend === 'right' || b.extend === 'both') xb = PX1;
      if (b.extend === 'left' || b.extend === 'both') xa = PX0;
      const ya = yOf(b.top), yb = yOf(b.bottom);
      if (b.bgcolor) { g.fillStyle = b.bgcolor; g.fillRect(Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya)); }
      if (b.border_color && b.border_width !== 0) {
        g.strokeStyle = b.border_color; g.lineWidth = b.border_width || 1; setDash(g, b.border_style, b.border_width || 1);
        g.strokeRect(Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya)); g.setLineDash([]);
      }
      if (b.text) {
        g.fillStyle = b.text_color || '#d1d4dc'; g.font = '11px -apple-system, Segoe UI, Roboto, sans-serif';
        g.textAlign = b.text_halign === 'left' ? 'left' : b.text_halign === 'right' ? 'right' : 'center';
        g.textBaseline = b.text_valign === 'top' ? 'top' : b.text_valign === 'bottom' ? 'bottom' : 'middle';
        const tx = g.textAlign === 'left' ? Math.min(xa, xb) + 4 : g.textAlign === 'right' ? Math.max(xa, xb) - 4 : (xa + xb) / 2;
        const ty = g.textBaseline === 'top' ? Math.min(ya, yb) + 3 : g.textBaseline === 'bottom' ? Math.max(ya, yb) - 3 : (ya + yb) / 2;
        g.fillText(b.text, tx, ty);
      }
    }

    for (const lf of d.linefills || []) {
      const l1 = lf.line1, l2 = lf.line2;
      if (!l1 || !l2 || !lf.color) continue;
      const pts = [[l1.x1, l1.y1], [l1.x2, l1.y2], [l2.x2, l2.y2], [l2.x1, l2.y1]];
      g.fillStyle = lf.color; g.beginPath();
      pts.forEach(([x, y], k) => { const px = xOf(x, l1.xloc), py = yOf(y); k ? g.lineTo(px, py) : g.moveTo(px, py); });
      g.closePath(); g.fill();
    }

    for (const ln of d.lines || []) {
      let xa = xOf(ln.x1, ln.xloc), xb = xOf(ln.x2, ln.xloc);
      let ya = yOf(ln.y1), yb = yOf(ln.y2);
      if (![xa, xb, ya, yb].every(isNum)) continue;
      const ext = ln.extend || 'none';
      if (ext !== 'none' && xb !== xa) {
        const slope = (yb - ya) / (xb - xa);
        if (ext === 'right' || ext === 'both') { const nx = xb >= xa ? PX1 : PX0; yb = yb + slope * (nx - xb); xb = nx; }
        if (ext === 'left' || ext === 'both') { const nx = xb >= xa ? PX0 : PX1; ya = ya + slope * (nx - xa); xa = nx; }
      } else if (ext !== 'none' && xb === xa) { ya = c.top; yb = c.bottom; }
      g.strokeStyle = ln.color || '#2962FF'; g.lineWidth = ln.width || 1; setDash(g, ln.style, ln.width || 1);
      g.beginPath(); g.moveTo(xa, ya); g.lineTo(xb, yb); g.stroke(); g.setLineDash([]);
      if (ln.style && ln.style.includes('arrow')) {
        const head = (fx, fy, tx, ty) => {
          const ang = Math.atan2(ty - fy, tx - fx), s = 6 + (ln.width || 1) * 2;
          g.fillStyle = ln.color || '#2962FF'; g.beginPath(); g.moveTo(tx, ty);
          g.lineTo(tx - s * Math.cos(ang - 0.45), ty - s * Math.sin(ang - 0.45));
          g.lineTo(tx - s * Math.cos(ang + 0.45), ty - s * Math.sin(ang + 0.45)); g.closePath(); g.fill();
        };
        if (ln.style.includes('right') || ln.style.includes('both')) head(xa, ya, xb, yb);
        if (ln.style.includes('left') || ln.style.includes('both')) head(xb, yb, xa, ya);
      }
    }

    for (const pl of d.polylines || []) {
      const pts = (pl.points || []).map((pt) => [pt.index !== undefined ? X(off + pt.index) : null, yOf(pt.price)]).filter(([x, y]) => isNum(x) && isNum(y));
      if (pts.length < 2) continue;
      g.beginPath(); pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      if (pl.closed) g.closePath();
      if (pl.fill_color) { g.fillStyle = pl.fill_color; g.fill(); }
      if (pl.line_color) { g.strokeStyle = pl.line_color; g.lineWidth = pl.line_width || 1; setDash(g, pl.line_style, pl.line_width || 1); g.stroke(); g.setLineDash([]); }
    }

    for (const lb of d.labels || []) {
      const x = xOf(lb.x, lb.xloc), y = yLoc(lb.x, lb.y, lb.yloc, lb.xloc);
      if (!isNum(x) || !isNum(y)) continue;
      let style = lb.style;
      if (lb.yloc === 'ab' && !style) style = 'style_label_down';
      drawLabel(g, x, y, lb.text, style, lb.color, lb.textcolor, lb.size, lb.textalign);
    }
  }

  function renderTrades(c, p, Y) {
    const { g, X, off, bars, iFrom, iTo } = c;
    if (!c.overlay) return; // trade markers only make sense on the price pane
    const o = Object.assign({ show: true, entries: true, exits: true, lines: true, labels: 'id_qty',
      longColor: '#2962FF', shortColor: '#F23645', exitColor: '#B388FF', size: 'normal' }, (c.style && c.style.trades) || {});
    if (!o.show) return;
    const size = { small: 8, normal: 11, large: 15 }[o.size] || 11;
    const font = { small: 9, normal: 10, large: 12 }[o.size] || 10;
    const marker = (barIdx, isUp, color, text) => {
      const b = bars[off + barIdx]; const x = X(off + barIdx); if (!b || !isNum(x)) return;
      const y = isUp ? Y(b.low) + size + 1 : Y(b.high) - size - 1;
      drawShape(g, isUp ? 'shape_arrow_up' : 'shape_arrow_down', x, y, size, color);
      if (text) {
        g.font = `${font}px -apple-system, Segoe UI, Roboto, sans-serif`; g.fillStyle = color; g.textAlign = 'center';
        g.textBaseline = isUp ? 'top' : 'bottom'; g.fillText(text, x, isUp ? y + size * 0.7 : y - size * 0.7);
      }
    };
    const qtyTxt = (n) => `${n > 0 ? '+' : ''}${n}`;
    const entryLabel = (t) => {
      const long = t.size > 0;
      switch (o.labels) {
        case 'none': return '';
        case 'id': return t.entryId || '';
        case 'qty': return qtyTxt(t.size);
        case 'side': return long ? 'Buy' : 'Sell';
        default: return `${t.entryId || ''} ${qtyTxt(t.size)}`.trim();
      }
    };
    const exitLabel = (t) => {
      const long = t.size > 0;
      const id = !t.exitId || /^close/i.test(t.exitId) ? 'Close' : String(t.exitId).slice(0, 14);
      switch (o.labels) {
        case 'none': return '';
        case 'id': return id;
        case 'qty': return qtyTxt(-t.size);
        case 'side': return long ? 'Sell' : 'Buy';
        default: return `${id} ${qtyTxt(-t.size)}`;
      }
    };
    const tradeLine = (xa, ya, xb, yb, good, dash) => {
      g.strokeStyle = good ? 'rgba(38,166,154,0.9)' : 'rgba(239,83,80,0.9)';
      g.lineWidth = 1.5; g.setLineDash(dash); g.beginPath(); g.moveTo(xa, ya); g.lineTo(xb, yb); g.stroke(); g.setLineDash([]);
    };
    const s = p.strategy;
    const inView = (a, b) => !(Math.max(a, b) < iFrom || Math.min(a, b) > iTo);
    for (const t of s.closed) {
      if (!isNum(t.entryBar) || !isNum(t.exitBar) || !inView(t.entryBar, t.exitBar)) continue;
      const long = t.size > 0;
      if (o.lines) {
        const xa = X(off + t.entryBar), xb = X(off + t.exitBar);
        if (isNum(xa) && isNum(xb) && isNum(t.entryPrice) && isNum(t.exitPrice)) tradeLine(xa, Y(t.entryPrice), xb, Y(t.exitPrice), (t.profit || 0) >= 0, [4, 3]);
      }
      if (o.entries) marker(t.entryBar, long, long ? o.longColor : o.shortColor, entryLabel(t));
      if (o.exits) marker(t.exitBar, !long, o.exitColor, exitLabel(t));
    }
    const lastIdx = p.n - 1;
    for (const t of s.open) {
      if (!isNum(t.entryBar) || !inView(t.entryBar, lastIdx)) continue;
      const long = t.size > 0;
      if (o.lines) {
        const xa = X(off + t.entryBar), xb = X(bars.length - 1), lastClose = bars[bars.length - 1].close;
        if (isNum(xa) && isNum(xb) && isNum(t.entryPrice)) tradeLine(xa, Y(t.entryPrice), xb, Y(lastClose), (lastClose - t.entryPrice) * t.size >= 0, [2, 3]);
      }
      if (o.entries) marker(t.entryBar, long, long ? o.longColor : o.shortColor, entryLabel(t));
    }
  }

  // small "RSI 42" tag beyond each arrow that meets the alert rule
  function renderAlertTags(c, p) {
    const { g, X, yOf, off, bars, iFrom, iTo } = c;
    if (!c.overlay) return;
    const arrow = p.plots.find((x) => x.style === 'arrow');
    const h = (arrow && (arrow.maxheight || arrow.minheight) || 35) * 0.8;
    g.font = 'bold 10px -apple-system, Segoe UI, Roboto, sans-serif'; g.textAlign = 'center';
    for (const sgl of p.alertSignals) {
      if (sgl.i < iFrom || sgl.i > iTo) continue;
      const bar = bars[off + sgl.i], x = X(off + sgl.i);
      if (!bar || !isNum(x)) continue;
      const up = sgl.dir > 0;
      const y = up ? yOf(bar.low) + 4 + h + 3 : yOf(bar.high) - 4 - h - 3;
      const lvl = (c.alerts && c.alerts.rsiLevel) ?? 50;
      const txt = `RSI ${Math.round(sgl.rsi) === Number(lvl) ? sgl.rsi.toFixed(1) : Math.round(sgl.rsi)}`;
      const w = g.measureText(txt).width + 8;
      g.fillStyle = up ? 'rgba(76,175,80,0.9)' : 'rgba(255,152,0,0.9)';
      roundRect(g, x - w / 2, up ? y : y - 14, w, 14, 3); g.fill();
      g.fillStyle = '#0b0d13'; g.textBaseline = 'middle';
      g.fillText(txt, x, up ? y + 7 : y - 7);
    }
  }

  // ---------- legend (TradingView-style, clickable) ----------
  const LEGEND_CSS = `
    :host { all: initial; }
    .wrap { display: flex; flex-direction: column; gap: 6px; align-items: stretch; font: 11px -apple-system, Segoe UI, Roboto, sans-serif; color: #d1d4dc; max-width: 340px; }
    .item { background: rgba(14,16,24,.86); border: 1px solid rgba(0,229,255,.35); border-radius: 6px; padding: 5px 8px 6px; }
    .item.off { opacity: .55; border-color: rgba(255,255,255,.15); }
    .head { display: flex; align-items: center; gap: 6px; }
    .name { color: #00e5ff; font-weight: 700; cursor: pointer; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item.off .name { color: #9aa0ab; }
    button { all: unset; cursor: pointer; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 4px; color: #b2b5be; }
    button:hover { background: rgba(255,255,255,.12); color: #fff; }
    svg { width: 14px; height: 14px; }
    .ln { margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `;
  const ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 5.2A9.7 9.7 0 0 1 12 5c7 0 11 7 11 7a18.6 18.6 0 0 1-2.2 3.2M1 1l22 22"/></svg>';
  const ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
  const ICON_BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
  const ICON_BELL_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13.7 21a2 2 0 0 1-3.4 0M18.6 13A17.9 17.9 0 0 1 18 8M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.3-5M1 1l22 22"/></svg>';
  const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function ensureLegend(st) {
    if (st.legendHost && st.legendHost.isConnected) return;
    const host = document.createElement('div');
    host.dataset.pinetsOverlay = 'legend';
    Object.assign(host.style, { position: 'absolute', zIndex: '3', transform: 'translateX(-100%)' });
    st.canvas.parentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${LEGEND_CSS}</style><div class="wrap"></div>`;
    st.legendHost = host; st.legendWrap = root.querySelector('.wrap'); st.legendHtml = '';
    for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu', 'touchstart']) host.addEventListener(ev, (e) => e.stopPropagation());
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      e.preventDefault();
      const id = b.dataset.id;
      if (b.dataset.act === 'eye') toContent({ type: 'toggleHidden', scriptId: id, hidden: b.dataset.hidden !== '1' });
      else if (b.dataset.act === 'bell') toContent({ type: 'toggleAlertVoice', scriptId: id, on: b.dataset.on !== '1' });
      else toContent({ type: 'openSettings', scriptId: id });
    });
  }

  function updateLegend(st, right, top) {
    const items = [];
    for (const s of config.scripts) {
      if (!s.enabled) continue;
      const ss = s.settings || {};
      const r = st.results.get(s.id);
      const hidden = !!ss.hidden;
      const tfOff = !hidden && !visibleOn(ss.visibility, st.tfMs);
      const p = r && r.ok ? r.payload : null;
      const title = (p && p.title) || s.name;
      const lines = [];
      if (hidden) lines.push({ t: 'Hidden', c: '#787b86' });
      else if (tfOff) lines.push({ t: 'Hidden on this timeframe', c: '#787b86' });
      else if (r && !r.ok) lines.push({ t: 'Error: ' + String(r.error).slice(0, 140), c: '#ef5350' });
      else if (!r) lines.push({ t: 'Calculating…', c: '#787b86' });
      else if (p && p.strategy && config.settings.showHud && (!ss.style || ss.style.showInPanel !== false)) {
        const k = p.strategy.stats;
        const pv = p.pointValue || 1; // PineTS profits are already in currency (price diff * qty * pointvalue)
        const winPct = k.trades ? (100 * k.wins / k.trades).toFixed(1) + '%' : '–';
        const pf = k.profitFactor === Infinity ? '∞' : k.profitFactor.toFixed(2);
        lines.push({ t: `Net P&L  ${fmtMoney(k.netProfit)}  (${(k.netProfit / pv).toFixed(2)} pts)`, c: k.netProfit >= 0 ? '#26a69a' : '#ef5350' });
        lines.push({ t: `Trades ${k.trades} · Win ${winPct} · PF ${pf}`, c: '#d1d4dc' });
        lines.push({ t: `Max DD  ${fmtMoney(-k.maxDrawdown)}` + (ss.maxTradesPerDay > 0 ? `  ·  max ${ss.maxTradesPerDay}/day` : ''), c: '#d1d4dc' });
        const pos = p.strategy.open.reduce((a, t) => a + (t.size || 0), 0);
        if (pos) {
          const lastClose = st.bars[st.bars.length - 1].close;
          const upl = p.strategy.open.reduce((a, t) => a + (lastClose - t.entryPrice) * t.size, 0);
          const avg = p.strategy.open.reduce((a, t) => a + t.entryPrice * Math.abs(t.size), 0) / Math.abs(pos);
          lines.push({ t: `${pos > 0 ? 'LONG' : 'SHORT'} ${Math.abs(pos)} @ ${avg.toFixed(2)}  ${fmtMoney(upl * pv)}`, c: upl >= 0 ? '#26a69a' : '#ef5350' });
        } else lines.push({ t: 'Flat', c: '#787b86' });
      }
      const al = ss.alerts || {};
      const canAlert = !!(p && Array.isArray(p.alertSignals));
      const bellOn = canAlert && al.enabled !== false && (al.voice || al.notify);
      if (canAlert && !hidden && !tfOff && al.enabled !== false) {
        const lvl = al.rsiLevel ?? 50;
        lines.push({ t: `${bellOn ? '🔔' : '🔕'} Green < RSI ${lvl} · Orange > RSI ${lvl}`, c: bellOn ? '#d1d4dc' : '#787b86' });
      }
      items.push({ id: s.id, title, hidden, off: hidden || tfOff, lines, canAlert, bellOn });
    }
    ensureLegend(st);
    const html = items.map((it) => `
      <div class="item${it.off ? ' off' : ''}">
        <div class="head">
          <span class="name" data-act="gear" data-id="${esc(it.id)}" title="Settings">◆ ${esc(it.title)}</span>
          ${it.canAlert ? `<button data-act="bell" data-id="${esc(it.id)}" data-on="${it.bellOn ? '1' : '0'}" title="${it.bellOn ? 'Mute voice alerts' : 'Turn voice alerts on'}">${it.bellOn ? ICON_BELL : ICON_BELL_OFF}</button>` : ''}
          <button data-act="eye" data-id="${esc(it.id)}" data-hidden="${it.hidden ? '1' : '0'}" title="${it.hidden ? 'Show' : 'Hide'}">${it.hidden ? ICON_EYE_OFF : ICON_EYE}</button>
          <button data-act="gear" data-id="${esc(it.id)}" title="Settings">${ICON_GEAR}</button>
        </div>
        ${it.lines.map((l) => `<div class="ln" style="color:${l.c}" title="${esc(l.t)}">${esc(l.t)}</div>`).join('')}
      </div>`).join('');
    if (html !== st.legendHtml) { st.legendWrap.innerHTML = html; st.legendHtml = html; }
    st.legendHost.style.left = (st.canvas.offsetLeft + right - 8) + 'px';
    st.legendHost.style.top = (st.canvas.offsetTop + top + 8) + 'px';
    st.legendHost.style.display = config.settings.enabled && items.length ? '' : 'none';
  }

  // ---------- chart notes (draggable text boxes) ----------
  const NOTES_CSS = `
    :host { all: initial; }
    .layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
    .note { position: absolute; pointer-events: auto; box-sizing: border-box; min-width: 140px; max-width: 95%;
      background: rgba(14,16,24,var(--bg,0.88)); border: 1px solid rgba(255,255,255,.16); border-radius: 8px;
      box-shadow: 0 6px 20px rgba(0,0,0,.35); color: #e3e6ee; font: var(--fs,13px)/1.45 -apple-system, Segoe UI, Roboto, sans-serif;
      resize: horizontal; overflow: hidden; }
    .hd { display: flex; align-items: center; gap: 6px; padding: 5px 6px 5px 10px; cursor: move; user-select: none;
      border-bottom: 1px solid rgba(255,255,255,.08); }
    .note.collapsed .hd { border-bottom: 0; }
    .ttl { flex: 1; font-weight: 700; color: var(--accent,#00e5ff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button { all: unset; cursor: pointer; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 4px; color: #b2b5be; font: 14px/1 sans-serif; }
    button:hover { background: rgba(255,255,255,.12); color: #fff; }
    .bd { padding: 8px 12px 10px; white-space: pre-wrap; word-wrap: break-word; overflow: auto; }
    .note.collapsed .bd { display: none; }
    b { color: #fff; }
  `;

  function noteHtml(text) {
    // plain text with **bold** support; everything else is escaped
    return esc(text || '').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  }

  function ensureNotesHost(st) {
    if (st.notesHost && st.notesHost.isConnected) return;
    const host = document.createElement('div');
    host.dataset.pinetsOverlay = 'notes';
    Object.assign(host.style, { position: 'absolute', zIndex: '4', pointerEvents: 'none' });
    st.canvas.parentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${NOTES_CSS}</style><div class="layer"></div>`;
    st.notesHost = host; st.notesLayer = root.querySelector('.layer'); st.noteEls = new Map();
  }

  function saveNote(id, patch) { toContent({ type: 'noteUpdate', id, patch }); }

  function makeNoteEl(st, n) {
    const el = document.createElement('div');
    el.className = 'note';
    el.innerHTML = `<div class="hd"><span class="ttl"></span><button class="col" title="Collapse">▾</button><button class="cls" title="Hide (turn back on from the extension popup)">×</button></div><div class="bd"></div>`;
    for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu', 'touchstart', 'keydown']) el.addEventListener(ev, (e) => e.stopPropagation());
    const hd = el.querySelector('.hd');
    hd.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const layer = st.notesLayer.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const dx = e.clientX - box.left, dy = e.clientY - box.top;
      el.dataset.dragging = '1';
      hd.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const x = Math.max(0, Math.min(layer.width - 40, ev.clientX - layer.left - dx));
        const y = Math.max(0, Math.min(layer.height - 24, ev.clientY - layer.top - dy));
        el.style.left = x + 'px'; el.style.top = y + 'px';
      };
      const up = () => {
        hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up); hd.removeEventListener('pointercancel', up);
        delete el.dataset.dragging;
        const L = st.notesLayer.getBoundingClientRect();
        saveNote(n.id, { x: +(el.offsetLeft / Math.max(1, L.width)).toFixed(4), y: +(el.offsetTop / Math.max(1, L.height)).toFixed(4) });
      };
      hd.addEventListener('pointermove', move); hd.addEventListener('pointerup', up); hd.addEventListener('pointercancel', up);
    });
    el.querySelector('.col').addEventListener('click', () => saveNote(el.dataset.id, { collapsed: !el.classList.contains('collapsed') }));
    el.querySelector('.cls').addEventListener('click', () => saveNote(el.dataset.id, { enabled: false }));
    // width changes from the resize handle (bottom-right corner)
    let rt = null;
    new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        const w = Math.round(el.offsetWidth);
        if (!el.isConnected || el.classList.contains('collapsed')) return;
        if (Math.abs(w - Number(el.dataset.w || 0)) > 3) { el.dataset.w = String(w); saveNote(el.dataset.id, { w }); }
      }, 500);
    }).observe(el);
    return el;
  }

  function renderNotes(st) {
    const list = (config.settings.enabled !== false && config.settings.showNotes !== false) ? notes.filter((n) => n && n.enabled) : [];
    if (!list.length && !st.notesHost) return;
    ensureNotesHost(st);
    const c = st.canvas;
    Object.assign(st.notesHost.style, { left: c.offsetLeft + 'px', top: c.offsetTop + 'px', width: c.clientWidth + 'px', height: c.clientHeight + 'px' });
    const W = c.clientWidth, H = c.clientHeight;
    const keep = new Set();
    for (const n of list) {
      keep.add(n.id);
      let el = st.noteEls.get(n.id);
      if (!el) { el = makeNoteEl(st, n); st.noteEls.set(n.id, el); st.notesLayer.appendChild(el); }
      el.dataset.id = n.id;
      const sig = JSON.stringify([n.title, n.text, n.fontSize, n.opacity, n.accent, n.collapsed]);
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.querySelector('.ttl').textContent = n.title || 'Note';
        el.querySelector('.bd').innerHTML = noteHtml(n.text);
        el.style.setProperty('--fs', (n.fontSize || 13) + 'px');
        el.style.setProperty('--bg', String(n.opacity ?? 0.88));
        el.style.setProperty('--accent', n.accent || '#00e5ff');
        el.classList.toggle('collapsed', !!n.collapsed);
        el.querySelector('.col').textContent = n.collapsed ? '▸' : '▾';
      }
      if (!el.dataset.dragging) {
        const x = Math.round((n.x ?? 0.02) * W), y = Math.round((n.y ?? 0.08) * H);
        el.style.left = Math.max(0, Math.min(W - 40, x)) + 'px';
        el.style.top = Math.max(0, Math.min(H - 24, y)) + 'px';
        const w = n.w || 380;
        if (el.dataset.w !== String(w)) { el.dataset.w = String(w); el.style.width = w + 'px'; }
        // keep the whole box inside the chart: long notes scroll instead of running off the bottom
        const topPx = parseFloat(el.style.top) || 0;
        el.querySelector('.bd').style.maxHeight = Math.max(60, H - topPx - 44) + 'px';
      }
    }
    for (const [id, el] of st.noteEls) if (!keep.has(id)) { el.remove(); st.noteEls.delete(id); }
  }

  // ---------- loop ----------
  function viewSignature(st) {
    const c = st.ctl;
    let vr; try { vr = c.getVisibleTimeRange(); } catch (_) { vr = null; }
    const ref = st.bars ? st.bars[st.bars.length - 1].close : 0;
    const pane = c.mainPaneFrame ? c.mainPaneFrame() : {};
    return [vr && vr.from, vr && vr.to, c.barIndexToPixel(0), c.priceToPixel(ref), c.priceToPixel(ref * 1.01),
      st.canvas.clientWidth, st.canvas.clientHeight, pane.top, pane.bottom, pane.width, devicePixelRatio].join('|');
  }

  let lastDiscover = 0;
  function frame(now) {
    try {
      if (now - lastDiscover > 1000) { lastDiscover = now; discover(); }
      for (const st of charts.values()) {
        try {
          pollBars(st, now);
          if (!st.bars) continue;
          if (st.notesCfg !== configVersion) { st.notesCfg = configVersion; renderNotes(st); }
          const sig = viewSignature(st);
          if (sig !== st.viewSig || st.dirty) { st.viewSig = sig; st.dirty = false; draw(st); }
        } catch (e) {
          if (!st.errLogged) { st.errLogged = true; console.warn('[PineTS Overlay] draw error', e); }
        }
      }
    } finally {
      requestAnimationFrame(frame);
    }
  }
  requestAnimationFrame(frame);

  // rAF doesn't run in hidden tabs: keep reading bars (for alerts) with a timer
  setInterval(() => {
    if (!document.hidden) return;
    const now = performance.now();
    try {
      if (now - lastDiscover > 1000) { lastDiscover = now; discover(); }
      for (const st of charts.values()) { try { pollBars(st, now); } catch (_) {} }
    } catch (_) {}
  }, 1000);
})();
