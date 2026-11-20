// TradingView-style per-script settings dialog (Inputs / Properties / Style / Visibility).
// Used by content.js (on the Tradara page) and manager.html. Changes apply live; Cancel reverts.
'use strict';

(() => {
  if (window.PTOSettings) return;

  const DEFAULT_SCRIPT_SETTINGS = () => ({
    hidden: false,
    inputs: {},
    props: {},
    maxTradesPerDay: 0,
    dayReset: 'session',
    style: {
      plots: {},
      drawings: { labels: true, lines: true, boxes: true },
      trades: {
        show: true, entries: true, exits: true, lines: true, labels: 'id_qty',
        longColor: '#2962FF', shortColor: '#F23645', exitColor: '#B388FF', size: 'normal',
      },
      showInPanel: true,
    },
    visibility: {
      seconds: { on: true, min: 1, max: 59 }, minutes: { on: true, min: 1, max: 59 }, hours: { on: true, min: 1, max: 24 },
      days: { on: true, min: 1, max: 366 }, weeks: { on: true, min: 1, max: 52 }, months: { on: true, min: 1, max: 12 },
    },
  });

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function deepMerge(base, over) {
    if (!isObj(over)) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
    return out;
  }
  function merge(s) { return deepMerge(DEFAULT_SCRIPT_SETTINGS(), s || {}); }

  const CSS = `
    :host { all: initial; }
    .backdrop { position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,.35); font: 13px -apple-system, Segoe UI, Roboto, sans-serif; color: #d1d4dc; }
    .dlg { position: fixed; width: 460px; max-width: calc(100vw - 24px); height: min(600px, calc(100vh - 40px)); display: flex; flex-direction: column;
      background: #1e1e24; border: 1px solid #2f3240; border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
    .hd { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px 6px; cursor: move; user-select: none; }
    .hd h2 { margin: 0; font-size: 18px; font-weight: 600; color: #f0f3fa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .x { background: none; border: 0; color: #b2b5be; font-size: 22px; cursor: pointer; padding: 0 4px; line-height: 1; }
    .x:hover { color: #fff; }
    .tabs { display: flex; gap: 22px; padding: 6px 20px 0; border-bottom: 1px solid #2f3240; }
    .tab { background: none; border: 0; color: #b2b5be; font: inherit; font-size: 14px; font-weight: 600; padding: 8px 0 10px; cursor: pointer; border-bottom: 3px solid transparent; }
    .tab.on { color: #f0f3fa; border-bottom-color: #f0f3fa; }
    .body { padding: 14px 20px; overflow: auto; flex: 1; min-height: 0; }
    .sec { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #8a8f9c; margin: 14px 0 8px; }
    .sec:first-child { margin-top: 2px; }
    .row { display: grid; grid-template-columns: 1fr 1.2fr; align-items: center; gap: 10px; margin: 8px 0; }
    .row.full { grid-template-columns: 1fr; }
    .row label.lbl { color: #d1d4dc; }
    .ctl { display: flex; gap: 8px; align-items: center; }
    input[type=number], input[type=text], select, textarea, input[type=datetime-local] {
      background: #131318; color: #e6e6e6; border: 1px solid #3a3d4a; border-radius: 6px; padding: 7px 9px; font: inherit; width: 100%; box-sizing: border-box; min-width: 0; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: #2962ff; }
    input[type=color] { width: 34px; height: 30px; padding: 0; border: 1px solid #3a3d4a; border-radius: 6px; background: #131318; cursor: pointer; flex: none; }
    input[type=checkbox] { width: 16px; height: 16px; accent-color: #2962ff; margin: 0; flex: none; cursor: pointer; }
    .chk { display: flex; gap: 10px; align-items: center; margin: 9px 0; cursor: pointer; }
    .plot { display: grid; grid-template-columns: 18px 1fr auto auto; gap: 10px; align-items: center; margin: 8px 0; }
    .plot select { width: 70px; }
    .vis { display: grid; grid-template-columns: 18px 80px 1fr 14px 1fr; gap: 8px; align-items: center; margin: 9px 0; }
    .muted { color: #787b86; font-size: 12px; }
    .hint { color: #787b86; font-size: 12px; margin: 2px 0 8px; }
    .ft { display: flex; gap: 10px; align-items: center; padding: 14px 20px; border-top: 1px solid #2f3240; }
    .ft .sp { flex: 1; }
    .btn { background: #1e1e24; color: #f0f3fa; border: 1px solid #50535e; border-radius: 8px; padding: 8px 16px; font: inherit; font-weight: 600; cursor: pointer; }
    .btn:hover { border-color: #b2b5be; }
    .btn.ok { background: #f0f3fa; color: #131318; border-color: #f0f3fa; }
    .menu { position: relative; }
    .menu .pop { position: absolute; bottom: 42px; left: 0; background: #26262e; border: 1px solid #3a3d4a; border-radius: 8px; padding: 4px; display: none; min-width: 190px; z-index: 2; }
    .menu.open .pop { display: block; }
    .pop button { display: block; width: 100%; text-align: left; background: none; border: 0; color: #d1d4dc; padding: 8px 10px; border-radius: 6px; font: inherit; cursor: pointer; }
    .pop button:hover { background: #33333d; }
    .empty { color: #787b86; padding: 20px 0; text-align: center; }
  `;

  const SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'];
  const TIMEFRAMES = [['', 'Chart'], ['1', '1 minute'], ['3', '3 minutes'], ['5', '5 minutes'], ['15', '15 minutes'], ['30', '30 minutes'],
    ['45', '45 minutes'], ['60', '1 hour'], ['120', '2 hours'], ['180', '3 hours'], ['240', '4 hours'], ['D', '1 day'], ['W', '1 week'], ['M', '1 month']];

  let current = null; // { host, close }

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else if (k === 'checked') e.checked = !!v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }

  function friendlyPlotName(p) {
    if (p.style === 'barcolor') return 'Bar color';
    if (p.style === 'background') return 'Background color';
    if (p.style === 'fill') return 'Fill' + (p.title.match(/#\d+$/) ? ' ' + p.title.match(/#(\d+)$/)[1] : '');
    return p.title;
  }

  function hex6(c) {
    if (typeof c !== 'string') return '#808080';
    const m = c.match(/^#([0-9a-f]{6})/i);
    if (m) return '#' + m[1];
    const s = c.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    if (s) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return '#808080';
  }
  function alphaSuffix(c) { const m = typeof c === 'string' && c.match(/^#[0-9a-f]{6}([0-9a-f]{2})$/i); return m ? m[1] : ''; }

  async function loadScript(id) {
    const d = await chrome.storage.local.get(['scripts', 'meta']);
    const scripts = Array.isArray(d.scripts) ? d.scripts : [];
    return { script: scripts.find((s) => s.id === id), meta: (d.meta || {})[id] || null };
  }

  async function saveSettings(id, settings) {
    const d = await chrome.storage.local.get('scripts');
    const scripts = Array.isArray(d.scripts) ? d.scripts : [];
    const s = scripts.find((x) => x.id === id);
    if (!s) return;
    s.settings = settings;
    await chrome.storage.local.set({ scripts });
  }

  async function open(id, opts = {}) {
    if (current) current.close(false);
    const { script, meta } = await loadScript(id);
    if (!script) return;
    const original = JSON.parse(JSON.stringify(script.settings || {}));
    let st = merge(script.settings);
    let tab = opts.tab || 'inputs';
    const isStrategy = meta ? meta.declType === 'strategy' : /^\s*strategy\s*\(/m.test(script.code || '');

    const host = el('div');
    host.setAttribute('data-pinets-overlay', 'dialog');
    const root = host.attachShadow({ mode: 'open' });
    root.append(el('style', {}, CSS));
    const backdrop = el('div', { class: 'backdrop' });
    const dlg = el('div', { class: 'dlg', role: 'dialog', 'aria-label': `${script.name} settings` });
    backdrop.append(dlg);
    root.append(backdrop);
    document.documentElement.append(host);
    for (const ev of ['keydown', 'keyup', 'keypress', 'wheel', 'pointerdown', 'mousedown']) host.addEventListener(ev, (e) => e.stopPropagation());

    let saveTimer = null;
    const commit = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveSettings(id, JSON.parse(JSON.stringify(st))), 250);
    };

    function close(revert) {
      clearTimeout(saveTimer);
      if (revert) saveSettings(id, original);
      else saveSettings(id, JSON.parse(JSON.stringify(st)));
      host.remove();
      document.removeEventListener('keydown', onKey, true);
      current = null;
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } };
    document.addEventListener('keydown', onKey, true);
    current = { host, close };

    // ---- header + tabs
    const hd = el('div', { class: 'hd' }, el('h2', {}, (meta && meta.effective && (meta.effective.shorttitle || meta.effective.title)) || script.name),
      el('button', { class: 'x', title: 'Close', onclick: () => close(false) }, '×'));
    const tabsEl = el('div', { class: 'tabs' });
    const body = el('div', { class: 'body' });
    const menu = el('div', { class: 'menu' },
      el('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); menu.classList.toggle('open'); } }, 'Defaults ▾'),
      el('div', { class: 'pop' },
        el('button', { onclick: () => { st = merge({ hidden: st.hidden }); commit(); menu.classList.remove('open'); render(); } }, 'Reset all settings'),
        el('button', { onclick: () => { resetTab(); menu.classList.remove('open'); render(); } }, 'Reset this tab')));
    const ft = el('div', { class: 'ft' }, menu, el('span', { class: 'sp' }),
      el('button', { class: 'btn', onclick: () => close(true) }, 'Cancel'),
      el('button', { class: 'btn ok', onclick: () => close(false) }, 'Ok'));
    dlg.append(hd, tabsEl, body, ft);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(false); });
    dlg.addEventListener('click', () => menu.classList.remove('open'));

    // position + drag
    const place = (x, y) => { dlg.style.left = Math.max(8, Math.min(window.innerWidth - 120, x)) + 'px'; dlg.style.top = Math.max(8, Math.min(window.innerHeight - 60, y)) + 'px'; };
    requestAnimationFrame(() => place((window.innerWidth - dlg.offsetWidth) / 2, Math.max(20, (window.innerHeight - dlg.offsetHeight) / 2)));
    hd.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const sx = e.clientX - dlg.offsetLeft, sy = e.clientY - dlg.offsetTop;
      const mv = (ev) => place(ev.clientX - sx, ev.clientY - sy);
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });

    function resetTab() {
      const d = DEFAULT_SCRIPT_SETTINGS();
      if (tab === 'inputs') st.inputs = {};
      if (tab === 'properties') { st.props = {}; st.maxTradesPerDay = 0; st.dayReset = 'session'; }
      if (tab === 'style') st.style = d.style;
      if (tab === 'visibility') st.visibility = d.visibility;
      commit();
    }

    const TABS = [['inputs', 'Inputs'], ['properties', 'Properties'], ['style', 'Style'], ['visibility', 'Visibility']];
    function render() {
      tabsEl.replaceChildren(...TABS.map(([k, label]) => el('button', { class: 'tab' + (tab === k ? ' on' : ''), onclick: () => { tab = k; render(); } }, label)));
      body.replaceChildren(...({ inputs: renderInputs, properties: renderProps, style: renderStyle, visibility: renderVisibility }[tab])());
    }

    // ---- Inputs
    function renderInputs() {
      const list = (meta && meta.inputs) || [];
      if (!list.length) return [el('div', { class: 'empty' }, meta ? 'This script has no inputs.' : 'Run the script on a Tradara chart once to load its inputs.')];
      const out = [];
      let lastGroup = null;
      for (const inp of list) {
        if (inp.display === undefined && inp.active === false) continue;
        if ((inp.group || null) !== lastGroup) { lastGroup = inp.group || null; if (lastGroup) out.push(el('div', { class: 'sec' }, lastGroup)); }
        const val = Object.prototype.hasOwnProperty.call(st.inputs, inp.id) ? st.inputs[inp.id] : inp.defval;
        const set = (v) => { st.inputs[inp.id] = v; commit(); };
        const title = inp.title || inp.name || inp.varId || inp.id;
        const tip = inp.tooltip ? ' ⓘ' : '';
        if (inp.type === 'bool') {
          out.push(el('label', { class: 'chk', title: inp.tooltip || null }, el('input', { type: 'checkbox', checked: !!val, onchange: (e) => set(e.target.checked) }), title + tip));
          continue;
        }
        let ctl;
        if (Array.isArray(inp.options) && inp.options.length) {
          ctl = el('select', { onchange: (e) => { const o = inp.options[e.target.selectedIndex]; set(o); } },
            inp.options.map((o) => el('option', { selected: String(o) === String(val) ? true : null }, String(o))));
        } else if (inp.type === 'int' || inp.type === 'float' || inp.type === 'price') {
          ctl = el('input', { type: 'number', value: val ?? '', min: inp.minval, max: inp.maxval, step: inp.step || (inp.type === 'int' ? 1 : 'any'),
            onchange: (e) => { let v = e.target.value === '' ? inp.defval : Number(e.target.value); if (inp.type === 'int') v = Math.round(v); set(v); } });
        } else if (inp.type === 'source') {
          ctl = el('select', { onchange: (e) => set(e.target.value) }, SOURCES.map((s) => el('option', { value: s, selected: s === String(val) ? true : null }, s)));
        } else if (inp.type === 'timeframe') {
          ctl = el('select', { onchange: (e) => set(e.target.value) }, TIMEFRAMES.map(([v, l]) => el('option', { value: v, selected: v === String(val ?? '') ? true : null }, l)));
        } else if (inp.type === 'color') {
          const a = alphaSuffix(val);
          ctl = el('div', { class: 'ctl' }, el('input', { type: 'color', value: hex6(val), oninput: (e) => set(e.target.value.toUpperCase() + a) }), el('span', { class: 'muted' }, String(val || '')));
        } else if (inp.type === 'time') {
          const toLocal = (ms) => { const d = new Date(Number(ms) || 0); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
          ctl = el('input', { type: 'datetime-local', value: toLocal(val), onchange: (e) => set(new Date(e.target.value).getTime()) });
        } else if (inp.type === 'text_area') {
          ctl = el('textarea', { rows: 3, onchange: (e) => set(e.target.value) }, String(val ?? ''));
        } else {
          ctl = el('input', { type: 'text', value: String(val ?? ''), onchange: (e) => set(e.target.value) });
        }
        out.push(el('div', { class: 'row', title: inp.tooltip || null }, el('label', { class: 'lbl' }, title + tip), ctl));
      }
      return out;
    }

    // ---- Properties
    function propVal(name) {
      if (Object.prototype.hasOwnProperty.call(st.props, name)) return st.props[name];
      const eff = meta && meta.effective;
      if (eff && eff[name] !== undefined) return eff[name];
      const pm = meta && meta.props && meta.props.find((p) => p.name === name);
      return pm ? pm.defval : undefined;
    }
    function setProp(name, v) { st.props[name] = v; commit(); }
    function numRow(label, name, opts = {}) {
      return el('div', { class: 'row' }, el('label', { class: 'lbl' }, label),
        el('div', { class: 'ctl' }, el('input', { type: 'number', value: propVal(name) ?? '', min: opts.min ?? 0, step: opts.step || 'any',
          onchange: (e) => setProp(name, opts.int ? Math.round(Number(e.target.value)) : Number(e.target.value)) }), opts.suffix ? el('span', { class: 'muted' }, opts.suffix) : null));
    }
    function selRow(label, numName, selName, options, opts = {}) {
      return el('div', { class: 'row' }, el('label', { class: 'lbl' }, label),
        el('div', { class: 'ctl' },
          el('input', { type: 'number', value: propVal(numName) ?? '', min: 0, step: 'any', onchange: (e) => setProp(numName, Number(e.target.value)) }),
          el('select', { onchange: (e) => setProp(selName, e.target.value) }, options.map(([v, l]) => el('option', { value: v, selected: String(propVal(selName)) === v ? true : null }, l)))));
    }
    function leverageRow(label, name) {
      const m = Number(propVal(name));
      const shown = !m ? 'Infinity' : String(+(100 / m).toFixed(4));
      return el('div', { class: 'row' }, el('label', { class: 'lbl' }, label),
        el('input', { type: 'text', value: shown, title: 'Leverage = 100 / margin %. Infinity = no margin requirement (TradingView futures default).',
          onchange: (e) => { const t = e.target.value.trim().toLowerCase(); const lev = t === 'infinity' || t === 'inf' || t === '∞' ? Infinity : Number(t);
            setProp(name, !Number.isFinite(lev) || lev <= 0 ? 0 : +(100 / lev).toFixed(6)); } }));
    }
    function chkProp(label, name) {
      return el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: !!propVal(name), onchange: (e) => setProp(name, e.target.checked) }), label);
    }
    function renderProps() {
      if (!isStrategy) return [el('div', { class: 'empty' }, 'Indicators have no strategy properties.')];
      return [
        el('div', { class: 'sec' }, 'General'),
        el('div', { class: 'row' }, el('label', { class: 'lbl' }, 'Initial capital'),
          el('div', { class: 'ctl' }, el('input', { type: 'number', min: 0, step: 'any', value: propVal('initial_capital') ?? '', onchange: (e) => setProp('initial_capital', Number(e.target.value)) }),
            el('span', { class: 'muted' }, String(propVal('currency') || 'USD')))),
        selRow('Default order size', 'default_qty_value', 'default_qty_type', [['fixed', 'Quantity'], ['cash', String(propVal('currency') || 'USD')], ['percent_of_equity', '% of equity']]),
        numRow('Pyramiding', 'pyramiding', { int: true, suffix: 'orders' }),
        el('div', { class: 'sec' }, 'Execution'),
        chkProp('Recalculate after order is filled', 'calc_on_order_fills'),
        chkProp('Fill orders on bar close', 'process_orders_on_close'),
        chkProp('Fill orders using standard OHLC', 'fill_orders_on_standard_ohlc'),
        el('div', { class: 'sec' }, 'Broker emulator'),
        selRow('Commission', 'commission_value', 'commission_type', [['percent', 'Percent'], ['cash_per_contract', 'USD per contract'], ['cash_per_order', 'USD per order']]),
        leverageRow('Long leverage', 'margin_long'),
        leverageRow('Short leverage', 'margin_short'),
        numRow('Slippage', 'slippage', { int: true, suffix: 'ticks' }),
        numRow('Verify price for limit orders', 'backtest_fill_limits_assumption', { int: true, suffix: 'ticks' }),
        el('div', { class: 'row' }, el('label', { class: 'lbl' }, 'Close entries rule'),
          el('select', { onchange: (e) => setProp('close_entries_rule', e.target.value) }, ['FIFO', 'ANY'].map((v) => el('option', { selected: String(propVal('close_entries_rule')) === v ? true : null }, v)))),
        el('div', { class: 'sec' }, 'Signal limits'),
        el('div', { class: 'row' }, el('label', { class: 'lbl' }, 'Max trades per day'),
          el('div', { class: 'ctl' }, el('input', { type: 'number', min: 0, step: 1, value: st.maxTradesPerDay || 0,
            onchange: (e) => { st.maxTradesPerDay = Math.max(0, Math.round(Number(e.target.value) || 0)); commit(); } }), el('span', { class: 'muted' }, '0 = no limit'))),
        el('div', { class: 'row' }, el('label', { class: 'lbl' }, 'Trading day starts'),
          el('select', { onchange: (e) => { st.dayReset = e.target.value; commit(); } },
            el('option', { value: 'session', selected: st.dayReset !== 'midnight' ? true : null }, 'Futures session (6:00 PM ET)'),
            el('option', { value: 'midnight', selected: st.dayReset === 'midnight' ? true : null }, 'Midnight ET'))),
        el('div', { class: 'hint' }, 'Once the limit is reached, new entries are skipped until the next trading day. Exits and stops still work.'),
      ];
    }

    // ---- Style
    function renderStyle() {
      const out = [];
      const plots = (meta && meta.plots) || [];
      out.push(el('div', { class: 'sec' }, 'Plots'));
      if (!plots.length) out.push(el('div', { class: 'muted' }, meta ? 'No plots.' : 'Run the script once to load its plots.'));
      for (const p of plots) {
        const ps = st.style.plots[p.title] || {};
        const upd = (k, v) => { st.style.plots[p.title] = { ...(st.style.plots[p.title] || {}), [k]: v }; commit(); };
        const lineLike = !/shape|char|background|barcolor|fill|histogram|columns/.test(p.style);
        out.push(el('div', { class: 'plot' },
          el('input', { type: 'checkbox', checked: ps.visible !== false, onchange: (e) => upd('visible', e.target.checked) }),
          el('span', {}, friendlyPlotName(p)),
          el('input', { type: 'color', value: hex6(ps.color || p.color), title: ps.color ? 'Custom color (Reset this tab to restore)' : 'Script color', oninput: (e) => upd('color', e.target.value.toUpperCase() + alphaSuffix(p.color)) }),
          lineLike ? el('select', { onchange: (e) => upd('linewidth', Number(e.target.value)) }, [1, 2, 3, 4].map((w) => el('option', { value: w, selected: (ps.linewidth || p.linewidth || 1) === w ? true : null }, `${w}px`))) : el('span')));
      }
      out.push(el('div', { class: 'sec' }, 'Drawings'));
      for (const [k, label] of [['labels', 'Labels'], ['lines', 'Lines'], ['boxes', 'Boxes']]) {
        out.push(el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: st.style.drawings[k] !== false, onchange: (e) => { st.style.drawings[k] = e.target.checked; commit(); } }), label));
      }
      if (isStrategy) {
        const t = st.style.trades;
        const upd = (k, v) => { t[k] = v; commit(); };
        out.push(el('div', { class: 'sec' }, 'Strategy signals'),
          el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: t.show, onchange: (e) => upd('show', e.target.checked) }), 'Show trades on chart'),
          el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: t.entries, onchange: (e) => upd('entries', e.target.checked) }), 'Entry arrows'),
          el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: t.exits, onchange: (e) => upd('exits', e.target.checked) }), 'Exit arrows'),
          el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: t.lines, onchange: (e) => upd('lines', e.target.checked) }), 'Trade lines (entry → exit)'),
          el('div', { class: 'row' }, el('label', { class: 'lbl' }, 'Signal labels'),
            el('select', { onchange: (e) => upd('labels', e.target.value) },
              [['id_qty', 'Order name + quantity'], ['id', 'Order name only'], ['qty', 'Quantity only'], ['side', 'Buy / Sell'], ['none', 'None (arrows only)']]
                .map(([v, l]) => el('option', { value: v, selected: t.labels === v ? true : null }, l)))),
          el('div', { class: 'row' }, el('label', { class: 'lbl' }, 'Arrow size'),
            el('select', { onchange: (e) => upd('size', e.target.value) }, [['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']].map(([v, l]) => el('option', { value: v, selected: t.size === v ? true : null }, l)))),
          el('div', { class: 'row' }, el('label', { class: 'lbl' }, 'Colors (long / short / exit)'),
            el('div', { class: 'ctl' },
              el('input', { type: 'color', value: hex6(t.longColor), title: 'Long entries', oninput: (e) => upd('longColor', e.target.value) }),
              el('input', { type: 'color', value: hex6(t.shortColor), title: 'Short entries', oninput: (e) => upd('shortColor', e.target.value) }),
              el('input', { type: 'color', value: hex6(t.exitColor), title: 'Exits', oninput: (e) => upd('exitColor', e.target.value) }))));
      }
      out.push(el('div', { class: 'sec' }, 'Info panel'),
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: st.style.showInPanel, onchange: (e) => { st.style.showInPanel = e.target.checked; commit(); } }),
          isStrategy ? 'Show performance (P&L, win rate…) in the info panel' : 'Show in the info panel'));
      return out;
    }

    // ---- Visibility
    function renderVisibility() {
      const rows = [['seconds', 'Seconds', 1, 59], ['minutes', 'Minutes', 1, 59], ['hours', 'Hours', 1, 24], ['days', 'Days', 1, 366], ['weeks', 'Weeks', 1, 52], ['months', 'Months', 1, 12]];
      return [el('div', { class: 'hint' }, 'Show this script only on the chart timeframes ticked below.'),
        ...rows.map(([k, label, lo, hi]) => {
          const v = st.visibility[k];
          const upd = (f, x) => { st.visibility[k] = { ...st.visibility[k], [f]: x }; commit(); };
          return el('div', { class: 'vis' },
            el('input', { type: 'checkbox', checked: v.on, onchange: (e) => upd('on', e.target.checked) }),
            el('span', {}, label),
            el('input', { type: 'number', min: lo, max: hi, value: v.min, onchange: (e) => upd('min', Math.max(lo, Math.min(hi, Math.round(Number(e.target.value) || lo)))) }),
            el('span', { class: 'muted' }, '–'),
            el('input', { type: 'number', min: lo, max: hi, value: v.max, onchange: (e) => upd('max', Math.max(lo, Math.min(hi, Math.round(Number(e.target.value) || hi)))) }));
        })];
    }

    render();
  }

  window.PTOSettings = { open, merge, defaults: DEFAULT_SCRIPT_SETTINGS };
})();
