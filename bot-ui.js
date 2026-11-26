'use strict';
// Auto-Trading tab in the manager: password screen, then mode, account, rules, risk limits, status and journal.

(() => {
  const $ = (id) => document.getElementById(id);
  const B = window.PTOBot;
  const TFS = [['chart', 'Chart timeframe'], [60000, '1m'], [120000, '2m'], [180000, '3m'], [300000, '5m'], [600000, '10m'], [900000, '15m'], [1800000, '30m'], [2700000, '45m'], [3600000, '1h'], [7200000, '2h'], [10800000, '3h'], [14400000, '4h']];

  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v) => `${v < 0 ? '-' : '+'}$${Math.abs(Number(v) || 0).toFixed(2)}`;

  function show() {
    document.body.classList.add('mode-note');
    for (const id of ['scriptPanel', 'notePanel']) $(id).hidden = true;
    $('botPanel').hidden = false;
    if (window.notesDeselect) window.notesDeselect();
    render();
  }
  window.botHide = () => { $('botPanel').hidden = true; };

  async function render() {
    const root = $('botBody');
    if (!(await B.auth.hasPassword())) return renderCreate(root);
    if (!(await B.auth.isUnlocked())) return renderLocked(root);
    return renderUnlocked(root);
  }

  function renderCreate(root) {
    root.innerHTML = `
      <div class="botcard narrow">
        <h2>🔒 Protect Auto-Trading with a password</h2>
        <p class="muted">You'll need this password to open Auto-Trading or switch it on. It stays unlocked until you lock it or close Chrome.</p>
        <label>Password <input type="password" id="pw1" autocomplete="new-password"></label>
        <label>Confirm password <input type="password" id="pw2" autocomplete="new-password"></label>
        <div class="err" id="pwErr"></div>
        <button class="primary" id="pwSet">Set password</button>
        <p class="muted small">This protects the feature on this computer. Anyone who can change the extension's files could get around it, so don't rely on it against someone who has your PC.</p>
      </div>`;
    $('pwSet').onclick = async () => {
      const a = $('pw1').value, b = $('pw2').value;
      if (a !== b) { $('pwErr').textContent = "Passwords don't match."; return; }
      try { await B.auth.setPassword(a); await B.auth.unlock(a); render(); }
      catch (e) { $('pwErr').textContent = e.message; }
    };
  }

  function renderLocked(root) {
    root.innerHTML = `
      <div class="botcard narrow">
        <h2>🔒 Auto-Trading is locked</h2>
        <label>Password <input type="password" id="pwIn" autocomplete="current-password"></label>
        <div class="err" id="pwErr"></div>
        <button class="primary" id="pwGo">Unlock</button>
        <details class="small"><summary>Forgot password?</summary>
          <p class="muted">This deletes the password and all Auto-Trading settings, and switches the bot off. Type <b>RESET</b> to confirm.</p>
          <input type="text" id="resetIn" placeholder="RESET"> <button class="danger" id="resetGo">Reset Auto-Trading</button>
        </details>
      </div>`;
    const go = async () => {
      $('pwErr').textContent = '';
      if (await B.auth.unlock($('pwIn').value)) render(); else $('pwErr').textContent = 'Wrong password.';
    };
    $('pwGo').onclick = go;
    $('pwIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    $('resetGo').onclick = async () => { if ($('resetIn').value.trim() === 'RESET') { await B.auth.resetEverything(); render(); } };
    setTimeout(() => $('pwIn').focus(), 50);
  }

  async function renderUnlocked(root) {
    const cfg = await B.loadCfg();
    const st = await B.loadState();
    const { botJournal = [], botAccounts = null } = await chrome.storage.local.get(['botJournal', 'botAccounts']);
    const accounts = (botAccounts && botAccounts.list) || [];
    const save = async (mut) => { const c = await B.loadCfg(); mut(c); await B.saveCfg(c); };
    const liveOk = !!cfg.accountId && cfg.liveAck;

    root.innerHTML = `
      <div class="bothead">
        <h2>🤖 Auto-Trading <span class="muted">· EMA Rejections</span></h2>
        <span class="sp"></span>
        <button id="lockBtn">🔒 Lock</button>
      </div>

      <div class="botcard status ${cfg.mode}">
        <div class="row3">
          <div><div class="k">Mode</div><div class="v">${cfg.mode === 'live' ? '<b class="live">LIVE</b>' : cfg.mode === 'paper' ? '<b>Paper</b>' : 'Off'}</div></div>
          <div><div class="k">Position</div><div class="v">${st.position ? `${st.position.dir > 0 ? 'LONG' : 'SHORT'} ${st.position.qty} @ ${st.position.entry} <span class="muted">(${st.position.mode})</span>` : 'Flat'}</div></div>
          <div><div class="k">Today</div><div class="v">${st.tradesToday}/${cfg.risk.maxTradesPerDay} trades · <span class="${st.pnlToday < 0 ? 'neg' : 'pos'}">${money(st.pnlToday)}</span></div></div>
        </div>
        ${st.halted ? `<div class="halt">⏹ Bot stopped itself: ${esc(st.halted)} <button id="resumeBtn">Resume</button></div>` : ''}
        <div class="actions">
          <button class="danger big" id="killBtn">⏹ Stop bot &amp; close its position</button>
          <span class="muted small">Works from here or the ⏹ button on the chart. The Tradara tab must be open.</span>
        </div>
      </div>

      <div class="botgrid">
        <section class="botcard">
          <h3>Mode</h3>
          <label class="radio"><input type="radio" name="mode" value="off" ${cfg.mode === 'off' ? 'checked' : ''}> <span>Off</span></label>
          <label class="radio"><input type="radio" name="mode" value="paper" ${cfg.mode === 'paper' ? 'checked' : ''}> <span>Paper: simulated trades, no orders sent</span></label>
          <label class="radio"><input type="radio" name="mode" value="live" ${cfg.mode === 'live' ? 'checked' : ''} ${liveOk ? '' : 'disabled'}> <span><b>Live</b>: real orders on the account below${liveOk ? '' : ' <span class="muted">(pick an account and tick the box below first)</span>'}</span></label>
          <h3>Account</h3>
          <div class="line"><select id="acct"><option value="">Select an account…</option>${accounts.filter((a) => a.open).map((a) => `<option value="${esc(a.id)}" ${a.id === cfg.accountId ? 'selected' : ''}>${esc(a.name)} · ${esc(a.type)} · ${esc(a.firm)}</option>`).join('')}</select>
            <button id="acctRefresh" title="Needs a Tradara tab open">↻</button></div>
          ${botAccounts && botAccounts.error ? `<div class="err small">${esc(botAccounts.error)}</div>` : !accounts.length ? '<div class="muted small">Open Tradara in a tab, then press ↻ to load your accounts.</div>' : ''}
          <label class="chk ack"><input type="checkbox" id="ack" ${cfg.liveAck ? 'checked' : ''}> <span>I understand Live mode places <b>real orders on my Tradara account without asking me first</b>, and I've checked my firm allows automated trading.</span></label>
        </section>

        <section class="botcard">
          <h3>Entry signal</h3>
          <label>Timeframe <select id="sigTf">${TFS.map(([v, l]) => `<option value="${v}" ${String(cfg.signal.tf) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Direction <select id="sides"><option value="both" ${cfg.signal.sides === 'both' ? 'selected' : ''}>Long &amp; short</option><option value="long" ${cfg.signal.sides === 'long' ? 'selected' : ''}>Long only (green arrows)</option><option value="short" ${cfg.signal.sides === 'short' ? 'selected' : ''}>Short only (orange arrows)</option></select></label>
          <label class="chk"><input type="checkbox" id="rsiOn" ${cfg.signal.useRsiFilter ? 'checked' : ''}> <span>RSI filter: green arrow only below the level, orange only above it</span></label>
          <div class="pair"><label>RSI length <input type="number" id="rsiLen" min="2" value="${cfg.signal.rsiLength}"></label><label>RSI level <input type="number" id="rsiLvl" min="1" max="99" value="${cfg.signal.rsiLevel}"></label></div>
          <h3>Order</h3>
          <label>Contracts per trade <input type="number" id="qty" min="1" value="${cfg.order.qty}"></label>
        </section>

        <section class="botcard">
          <h3>Exits</h3>
          <div class="pair"><label>Stop-loss (ticks) <input type="number" id="slT" min="0" value="${cfg.exits.stopTicks}"></label><label>Take-profit (ticks) <input type="number" id="tpT" min="0" value="${cfg.exits.targetTicks}"></label></div>
          <div class="muted small">Sent with every entry and held on Tradara's servers, so they stay in place even if your browser closes. A stop-loss is required in Live mode. NQ: 4 ticks = 1 point = $20.</div>
          <label>Opposite arrow while in a trade <select id="opp"><option value="close" ${cfg.exits.onOpposite === 'close' ? 'selected' : ''}>Close the trade</option><option value="reverse" ${cfg.exits.onOpposite === 'reverse' ? 'selected' : ''}>Close and reverse</option><option value="ignore" ${cfg.exits.onOpposite === 'ignore' ? 'selected' : ''}>Ignore it</option></select></label>
          <label>Close everything at (ET) <input type="time" id="flat" value="${esc(cfg.exits.flattenAt)}"></label>
        </section>

        <section class="botcard">
          <h3>Safety limits</h3>
          <div class="pair"><label>Max trades per day <input type="number" id="mtd" min="1" value="${cfg.risk.maxTradesPerDay}"></label><label>Max daily loss ($) <input type="number" id="mdl" min="0" value="${cfg.risk.maxDailyLoss}"></label></div>
          <div class="pair"><label>Stop after losses in a row <input type="number" id="mls" min="0" value="${cfg.risk.maxLossStreak}"></label><label>Max contracts <input type="number" id="mq" min="1" value="${cfg.risk.maxQty}"></label></div>
          <div class="pair"><label>New trades from (ET) <input type="time" id="hs" value="${esc(cfg.risk.start)}"></label><label>until (ET) <input type="time" id="he" value="${esc(cfg.risk.end)}"></label></div>
          <div class="muted small">Set the daily loss below your evaluation's own daily loss limit. When a limit is hit, the bot stops itself until the next trading day (6 PM ET). It also stops on any order error, if Tradara locks the account, or if the account already has a position the bot didn't open.</div>
        </section>
      </div>

      <section class="botcard">
        <div class="bothead"><h3>Journal</h3><span class="sp"></span><button id="clearJ">Clear</button></div>
        <table class="journal"><tbody>${botJournal.slice(-80).reverse().map((j) => `<tr class="${j.kind}"><td>${new Date(j.at).toLocaleString()}</td><td>${esc(j.mode || '')}</td><td>${esc(j.text)}</td><td class="${j.pnl < 0 ? 'neg' : 'pos'}">${j.pnl !== undefined ? money(j.pnl) : ''}</td></tr>`).join('') || '<tr><td class="muted">Nothing yet.</td></tr>'}</tbody></table>
      </section>

      <details class="botcard small"><summary>Change password</summary>
        <label>Current <input type="password" id="cp0"></label><label>New <input type="password" id="cp1"></label>
        <button id="cpGo">Change</button> <span class="err" id="cpErr"></span>
      </details>`;

    // ---- handlers
    $('lockBtn').onclick = async () => { await B.auth.lock(); render(); };
    $('killBtn').onclick = async () => {
      if (!confirm('Stop the bot and close the position it opened?')) return;
      await save((c) => { c.mode = 'off'; });
      await chrome.storage.local.set({ botKillRequest: Date.now() });
    };
    if ($('resumeBtn')) $('resumeBtn').onclick = async () => { const s = await B.loadState(); s.halted = ''; await B.saveState(s); };
    for (const r of document.querySelectorAll('input[name=mode]')) r.onchange = async (e) => {
      const v = e.target.value;
      if (v === 'live' && !confirm('Switch to LIVE trading? The bot will place real orders on your Tradara account by itself.')) { render(); return; }
      await save((c) => { c.mode = v; });
      if (v !== 'off') { const s = await B.loadState(); if (s.halted && !/daily|streak/.test(s.halted)) { s.halted = ''; await B.saveState(s); } }
    };
    $('acct').onchange = (e) => save((c) => {
      const a = accounts.find((x) => x.id === e.target.value);
      c.accountId = e.target.value; c.accountName = a ? a.name : '';
      if (c.mode === 'live') c.mode = 'off'; // changing account always turns Live off
    });
    $('acctRefresh').onclick = () => chrome.storage.local.set({ botAccountsRequest: Date.now() });
    $('ack').onchange = (e) => save((c) => { c.liveAck = e.target.checked; if (!c.liveAck && c.mode === 'live') c.mode = 'off'; });
    const num = (id, fn, min = 0) => { $(id).onchange = (e) => save((c) => fn(c, Math.max(min, Number(e.target.value) || 0))); };
    $('sigTf').onchange = (e) => save((c) => { c.signal.tf = e.target.value === 'chart' ? 'chart' : Number(e.target.value); });
    $('sides').onchange = (e) => save((c) => { c.signal.sides = e.target.value; });
    $('rsiOn').onchange = (e) => save((c) => { c.signal.useRsiFilter = e.target.checked; });
    num('rsiLen', (c, v) => { c.signal.rsiLength = Math.round(v) || 14; }, 2);
    num('rsiLvl', (c, v) => { c.signal.rsiLevel = Math.min(99, v) || 50; }, 1);
    num('qty', (c, v) => { c.order.qty = Math.round(v) || 1; }, 1);
    num('slT', (c, v) => { c.exits.stopTicks = Math.round(v); });
    num('tpT', (c, v) => { c.exits.targetTicks = Math.round(v); });
    $('opp').onchange = (e) => save((c) => { c.exits.onOpposite = e.target.value; });
    $('flat').onchange = (e) => save((c) => { c.exits.flattenAt = e.target.value; });
    num('mtd', (c, v) => { c.risk.maxTradesPerDay = Math.round(v) || 1; }, 1);
    num('mdl', (c, v) => { c.risk.maxDailyLoss = v; });
    num('mls', (c, v) => { c.risk.maxLossStreak = Math.round(v); });
    num('mq', (c, v) => { c.risk.maxQty = Math.round(v) || 1; }, 1);
    $('hs').onchange = (e) => save((c) => { c.risk.start = e.target.value; });
    $('he').onchange = (e) => save((c) => { c.risk.end = e.target.value; });
    $('clearJ').onclick = () => chrome.storage.local.set({ botJournal: [] });
    $('cpGo').onclick = async () => {
      if (!(await B.auth.verify($('cp0').value))) { $('cpErr').textContent = 'Current password is wrong.'; return; }
      try { await B.auth.setPassword($('cp1').value); $('cpErr').textContent = 'Password changed.'; } catch (e) { $('cpErr').textContent = e.message; }
    };
  }

  $('botOpen').onclick = show;
  let t = null;
  const refresh = () => { clearTimeout(t); t = setTimeout(() => { if (!$('botPanel').hidden && !document.activeElement.matches('input[type=password], input[type=number], input[type=text], input[type=time]')) render(); }, 200); };
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'session' && ch.botUnlocked) refresh();
    if (area === 'local' && (ch.bot || ch.botState || ch.botJournal || ch.botAccounts || ch.botAuth)) refresh();
  });
})();
