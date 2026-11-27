// PineTS Overlay: Auto-Trading (EMA Rejections only).
// Shared by the content script (engine) and the manager page (settings UI).
// Modes: off / paper (simulated) / live (real orders through Tradara). Locked behind a password.
'use strict';

(() => {
  if (typeof window !== 'undefined' && window.PTOBot) return;

  // Live orders use Tradara's own order endpoints (verified against its app: OTOCO bracket, flatten, positions).
  const LIVE_READY = true;

  const DEFAULTS = () => ({
    mode: 'off', // off | paper | live
    accountId: '', accountName: '',
    liveAck: false, // user ticked "I understand this places real orders"
    signal: {
      tf: 'chart', // 'chart' or a timeframe in ms (built from the chart's candles, like alerts)
      useRsiFilter: true, rsiLength: 14, rsiLevel: 50,
      sides: 'both', // both | long | short
    },
    exits: {
      stopTicks: 40, targetTicks: 80, // attached to every entry (0 = none, not allowed in live mode)
      onOpposite: 'close', // close | reverse | ignore
      flattenAt: '15:55', // ET, '' = never
    },
    order: { qty: 1 },
    risk: {
      maxTradesPerDay: 3, maxDailyLoss: 500, maxLossStreak: 3, maxQty: 1,
      start: '09:30', end: '15:45', // ET trading window for new entries
    },
  });

  const STATE_DEFAULTS = () => ({
    day: '', tradesToday: 0, pnlToday: 0, lossStreak: 0,
    position: null, // { dir, qty, entry, stop, target, t, tfMs, symbol, mode }
    halted: '', // reason the bot stopped itself
  });

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function deepMerge(base, over) {
    if (!isObj(over)) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
    return out;
  }

  // ---------- storage ----------
  async function loadCfg() { const d = await chrome.storage.local.get('bot'); return deepMerge(DEFAULTS(), d.bot || {}); }
  async function saveCfg(cfg) { await chrome.storage.local.set({ bot: cfg }); }
  async function loadState() { const d = await chrome.storage.local.get('botState'); return deepMerge(STATE_DEFAULTS(), d.botState || {}); }
  async function saveState(st) { await chrome.storage.local.set({ botState: st }); }
  async function journal(entry) {
    const d = await chrome.storage.local.get('botJournal');
    const list = Array.isArray(d.botJournal) ? d.botJournal : [];
    list.push({ at: Date.now(), ...entry });
    while (list.length > 500) list.shift();
    await chrome.storage.local.set({ botJournal: list });
  }

  // ---------- password ----------
  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  async function derive(pw, saltHex, iterations) {
    const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
  }
  const auth = {
    async hasPassword() { const d = await chrome.storage.local.get('botAuth'); return !!(d.botAuth && d.botAuth.hash); },
    async setPassword(pw) {
      if (!pw || pw.length < 6) throw new Error('Use at least 6 characters.');
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const iterations = 210000;
      await chrome.storage.local.set({ botAuth: { salt, iterations, hash: await derive(pw, salt, iterations) } });
    },
    async verify(pw) {
      const d = await chrome.storage.local.get('botAuth');
      const a = d.botAuth;
      if (!a || !a.hash) return false;
      return (await derive(pw || '', a.salt, a.iterations)) === a.hash;
    },
    // Unlocking lasts until you lock it again or close Chrome (kept in session storage, never on disk)
    async unlock(pw) {
      if (!(await auth.verify(pw))) return false;
      await chrome.storage.session.set({ botUnlocked: true });
      return true;
    },
    async lock() {
      await chrome.storage.session.set({ botUnlocked: false });
      const cfg = await loadCfg();
      if (cfg.mode !== 'off') { cfg.mode = 'off'; await saveCfg(cfg); }
    },
    async isUnlocked() { try { const d = await chrome.storage.session.get('botUnlocked'); return !!d.botUnlocked; } catch (_) { return false; } },
    // Forgot password: wipes the password and all bot settings (the bot is switched off)
    async resetEverything() {
      await chrome.storage.local.remove(['botAuth', 'bot', 'botState']);
      await chrome.storage.session.set({ botUnlocked: false });
    },
  };

  // ---------- time helpers (New York) ----------
  const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function et(t) {
    const p = Object.fromEntries(etFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour) * 60 + (+p.minute), hhmm: `${p.hour}:${p.minute}` };
  }
  // trading day rolls at 6 PM ET (CME futures session)
  const sessionDay = (t) => et(t + 6 * 3600000).date;
  const toMins = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  function inWindow(t, start, end) {
    const a = toMins(start), b = toMins(end);
    if (a === null || b === null) return true;
    const m = et(t).mins;
    return a <= b ? m >= a && m <= b : m >= a || m <= b; // window may wrap past midnight
  }

  // Temporary connection problems between Tradara and the broker (no order was accepted)
  const VENUE_PAUSE_MS = 3 * 60 * 1000;
  function isConnectionError(e) {
    const m = String((e && e.message) || e || '');
    return /session (is )?(connecting|unavailable|disconnected|not connected)|venue session|not connected|reconnect|temporarily unavailable|timed? ?out|did not respond|HTTP 50[234]|gateway|ECONN|network/i.test(m);
  }

  // ---------- engine (runs in the content script on the Tradara page) ----------
  class Engine {
    constructor(opts) {
      this.say = opts.say; // (text, title, {voice, notify}) => void
      this.broker = opts.broker; // live adapter (page.js), or null
      this.onStatus = opts.onStatus || (() => {});
      this.instance = Math.random().toString(36).slice(2);
      this.cfg = DEFAULTS(); this.state = STATE_DEFAULTS(); this.unlocked = false;
      this.seen = new Map();
      this.busy = Promise.resolve();
      this.ready = this.reload();
      chrome.storage.onChanged.addListener((ch, area) => {
        if ((area === 'local' && (ch.bot || ch.botState || ch.license)) || (area === 'session' && ch.botUnlocked)) this.reload();
        // requests from the manager page (it can't reach Tradara itself)
        if (area === 'local' && ch.botKillRequest && ch.botKillRequest.newValue) this.queue(() => this.kill('you (manager)'));
        if (area === 'local' && ch.botAccountsRequest && ch.botAccountsRequest.newValue) this.queue(() => this.fetchAccounts());
      });
      setInterval(() => this.queue(() => this.heartbeat()), 2000);
      setInterval(() => this.reload(), 3600000); // re-check the license (expiry) every hour
    }

    async reload() {
      this.lastMode = this.cfg && this.cfg.mode;
      this.cfg = await loadCfg();
      this.state = await loadState();
      this.unlocked = await auth.isUnlocked();
      try { this.licensed = typeof PTOLicense !== 'undefined' ? (await PTOLicense.status()).ok : false; } catch (_) { this.licensed = false; }
      if (!this.licensed) this.unlocked = false; // Auto-Trading needs an active license
      if (this.unlocked && !this.accountsFetched) { this.accountsFetched = true; setTimeout(() => this.queue(() => this.fetchAccounts()), 1500); }
      this.publish();
    }

    queue(fn) { this.busy = this.busy.then(fn).catch((e) => console.warn('[PineTS Bot]', e)); return this.busy; }

    get active() { return this.unlocked && (this.cfg.mode === 'paper' || (this.cfg.mode === 'live' && LIVE_READY)) && !this.state.halted; }

    // what the indicator run needs from the bot (so the sandbox computes the bot's timeframe + all arrows)
    wants(chartTfMs) {
      if (!this.unlocked || this.cfg.mode === 'off') return null;
      const tf = this.cfg.signal.tf === 'chart' ? chartTfMs : Number(this.cfg.signal.tf);
      return { tfMs: tf, rsiLength: this.cfg.signal.rsiLength, rsiLevel: this.cfg.signal.rsiLevel };
    }

    // only one Tradara tab may run the bot at a time
    async holdLease() {
      const d = await chrome.storage.local.get('botLease');
      const l = d.botLease;
      const now = Date.now();
      if (l && l.id !== this.instance && now - l.at < 6000) return false;
      await chrome.storage.local.set({ botLease: { id: this.instance, at: now } });
      return true;
    }

    async newDayCheck(t) {
      const day = sessionDay(t);
      if (this.state.day !== day) {
        this.state.day = day; this.state.tradesToday = 0; this.state.pnlToday = 0; this.state.lossStreak = 0;
        if (this.state.halted && /daily|streak/i.test(this.state.halted)) this.state.halted = '';
        await saveState(this.state);
      }
    }

    async halt(reason) {
      this.state.halted = reason;
      await saveState(this.state);
      await journal({ kind: 'halt', mode: this.cfg.mode, text: `Bot stopped: ${reason}` });
      this.say(`Trading bot stopped. ${reason}`, '⏹ Trading bot stopped', { voice: true, notify: true });
      this.publish();
    }

    // You pressed stop: switch off, and close any open position
    async kill(by = 'you') {
      const cfg = await loadCfg();
      cfg.mode = 'off'; await saveCfg(cfg); this.cfg = cfg;
      if (this.state.position) await this.exit(this.state.position.lastPrice || this.state.position.entry, `Stopped by ${by}`);
      await journal({ kind: 'halt', mode: 'off', text: `Bot switched off by ${by}` });
      this.publish();
    }

    // Called with every EMA Rejections result
    onResult(ctx) { return this.queue(() => this.process(ctx)); }

    async process({ chartKey, symbol, chartTfMs, payload, bars }) {
      if (!this.active || !payload || !Array.isArray(payload.alertTfs)) { this.publish(); return; }
      if (!(await this.holdLease())) { this.publish('Running in another Tradara tab'); return; }
      this.chartKey = chartKey;
      const now = Date.now();
      await this.newDayCheck(now);
      const pv = payload.pointValue || 1, tick = payload.mintick || 0.25;
      const want = this.wants(chartTfMs);
      const tf = payload.alertTfs.find((x) => x.ms === want.tfMs);
      const lastClosed = bars && bars.length ? bars[bars.length - (bars.lastBarForming ? 2 : 1)] : null;

      // manage an open paper position against the candles that have closed since entry
      if (this.state.position && this.cfg.mode === 'paper' && bars) await this.paperManage(bars, pv);
      if (this.state.position && lastClosed) this.state.position.lastPrice = lastClosed.c;

      // flatten-at time
      const fa = toMins(this.cfg.exits.flattenAt);
      if (this.state.position && fa !== null && et(now).mins >= fa && et(now).mins < fa + 60) {
        await this.exit(lastClosed ? lastClosed.c : this.state.position.entry, `Flatten time ${this.cfg.exits.flattenAt} ET`, pv);
      }

      if (!tf || tf.unsupported || tf.tooShort) { this.publish(tf && tf.unsupported ? 'Signal timeframe needs a lower chart timeframe' : ''); return; }
      const key = `${chartKey}|${symbol}|${want.tfMs}|${want.rsiLength}|${want.rsiLevel}`;
      const closed = tf.signals.filter((x) => !x.forming);
      const newest = closed.length ? closed[closed.length - 1].t : 0;
      if (!this.seen.has(key)) { this.seen.set(key, newest); this.publish(); return; } // never trade old signals
      const seen = this.seen.get(key);
      this.seen.set(key, Math.max(seen, newest));
      const fresh = closed.filter((x) => x.t > seen && x.i >= tf.n - 2); // only the candle that just closed
      for (const sgl of fresh) await this.onSignal(sgl, { symbol, tfMs: want.tfMs, pv, tick, now });
      this.publish();
    }

    async onSignal(sgl, m) {
      const c = this.cfg, s = this.state;
      const side = sgl.dir > 0 ? 'LONG' : 'SHORT';
      const label = `${sgl.dir > 0 ? 'Green' : 'Orange'} arrow, RSI ${sgl.rsiB ?? sgl.rsi}`;
      const skip = (why) => journal({ kind: 'skip', mode: c.mode, text: `${label}: skipped (${why})` });
      const r = sgl.rsiB !== undefined && sgl.rsiB !== null ? sgl.rsiB : sgl.rsi;
      const lvl = Number(c.signal.rsiLevel) || 50;
      const meets = (sgl.dir > 0 && r < lvl) || (sgl.dir < 0 && r > lvl);
      if (c.signal.useRsiFilter && !meets) return skip(`RSI ${r} doesn't meet the ${sgl.dir > 0 ? 'below' : 'above'} ${lvl} rule`);
      if ((c.signal.sides === 'long' && sgl.dir < 0) || (c.signal.sides === 'short' && sgl.dir > 0)) return skip(`${side.toLowerCase()}s are off`);

      // opposite position open
      if (s.position && s.position.dir !== sgl.dir) {
        if (c.exits.onOpposite === 'ignore') return skip('opposite position open');
        await this.exit(sgl.price, `Opposite signal (${label})`, m.pv);
        if (c.exits.onOpposite !== 'reverse') return;
      }
      if (s.position && s.position.dir === sgl.dir) return skip(`already ${side.toLowerCase()}`);
      if (c.mode === 'live' && s.venuePauseUntil && Date.now() < s.venuePauseUntil) return skip(`paused after a broker connection error, resumes ${new Date(s.venuePauseUntil).toLocaleTimeString()}`);
      if (!inWindow(sgl.t, c.risk.start, c.risk.end)) return skip(`outside trading hours ${c.risk.start}–${c.risk.end} ET`);
      if (s.tradesToday >= c.risk.maxTradesPerDay) return skip(`max ${c.risk.maxTradesPerDay} trades today`);
      if (c.risk.maxDailyLoss > 0 && s.pnlToday <= -Math.abs(c.risk.maxDailyLoss)) { await this.halt(`daily loss limit reached`); return; }
      if (c.risk.maxLossStreak > 0 && s.lossStreak >= c.risk.maxLossStreak) { await this.halt(`${s.lossStreak} losses in a row`); return; }
      const qty = Math.max(1, Math.min(Math.round(c.order.qty || 1), Math.round(c.risk.maxQty || 1)));
      await this.enter(sgl, qty, m, label);
    }

    async enter(sgl, qty, m, label) {
      const c = this.cfg;
      let entry = sgl.price;
      let st = c.exits.stopTicks > 0 ? sgl.price - sgl.dir * c.exits.stopTicks * m.tick : null;
      let tg = c.exits.targetTicks > 0 ? sgl.price + sgl.dir * c.exits.targetTicks * m.tick : null;
      let equityAtEntry = null;
      if (c.mode === 'live') {
        if (!(c.exits.stopTicks > 0)) { await this.halt('live trading needs a stop-loss'); return; }
        if (!c.accountId) { await this.halt('no account selected'); return; }
        try {
          const inst = await this.instrument();
          const risk = await this.broker.call('risk', { accountId: c.accountId });
          if (risk.locked) { await this.halt(`Tradara has locked the account${risk.reason ? ` (${risk.reason})` : ''}`); return; }
          const pos = await this.broker.call('position', { accountId: c.accountId, instrumentId: inst.id });
          if (pos.qty !== 0) { await this.halt(`the account already has ${pos.qty} ${inst.symbol} open that the bot didn't open`); return; }
          equityAtEntry = Number.isFinite(risk.equity) ? risk.equity : null;
          // place the order ONCE. If the broker link is down (e.g. "Tradovate session is connecting") the bot does NOT
          // resend: repeated orders against a reconnecting broker link only add load. It checks nothing went through,
          // skips the signal and pauses new entries for a few minutes.
          const orderKey = `pto-${sgl.t}-${sgl.dir}-${Math.random().toString(36).slice(2, 10)}`;
          const args = { accountId: c.accountId, instrumentId: inst.id, symbol: inst.symbol, side: sgl.dir > 0 ? 'BUY' : 'SELL', qty, stopTicks: c.exits.stopTicks, targetTicks: c.exits.targetTicks, key: orderKey };
          let placed = false, lastErr = null;
          try { await this.broker.call('placeBracket', args); placed = true; }
          catch (e) { lastErr = e; if (!isConnectionError(e)) throw e; /* a real rejection: bot stops (below) */ }
          if (!placed) {
            // still not connected: make sure nothing went through late, then skip this signal and keep running
            await new Promise((r) => setTimeout(r, 3000));
            const late = await this.broker.call('position', { accountId: c.accountId, instrumentId: inst.id }).catch(() => ({ qty: 0 }));
            if (late.qty === 0) {
              this.state.venueFails = (this.state.venueFails || 0) + 1;
              this.state.venuePauseUntil = Date.now() + VENUE_PAUSE_MS;
              await saveState(this.state);
              const msg = String(lastErr && lastErr.message || lastErr);
              await journal({ kind: 'skip', mode: 'live', text: `${label}: skipped, broker not connected (${msg}). No order was placed. New entries paused ${VENUE_PAUSE_MS / 60000} min.` });
              if (this.state.venueFails >= 2) { await this.halt(`broker connection failed on ${this.state.venueFails} signals in a row (${msg})`); return; }
              this.say(`Signal skipped. ${/tradovate/i.test(msg) ? 'Tradovate' : 'The broker'} isn't connected. Pausing new trades for ${VENUE_PAUSE_MS / 60000} minutes.`, '🤖 Signal skipped: broker not connected', { voice: true, notify: true });
              return;
            }
            // it did go through: carry on and manage it (its stop and target are attached on Tradara)
          }
          this.state.venueFails = 0;
          // confirm the fill
          let filled = null;
          for (let k = 0; k < 10 && !filled; k++) {
            await new Promise((r) => setTimeout(r, 800));
            const p = await this.broker.call('position', { accountId: c.accountId, instrumentId: inst.id });
            if (p.qty !== 0) filled = p;
          }
          if (!filled) {
            // no position now: either it never filled, or it filled and its stop/target was hit before we looked
            const after = await this.broker.call('risk', { accountId: c.accountId });
            if (Number.isFinite(after.equity) && Number.isFinite(equityAtEntry) && Math.abs(after.equity - equityAtEntry) > 0.004) {
              const usd = Math.round((after.equity - equityAtEntry) * 100) / 100;
              const exitPx = Math.round((sgl.price + usd / (qty * (inst.pointValue || m.pv) * sgl.dir)) / inst.tick) * inst.tick;
              this.state.tradesToday += 1;
              this.state.pnlToday = Math.round((this.state.pnlToday + usd) * 100) / 100;
              this.state.lossStreak = usd < 0 ? this.state.lossStreak + 1 : 0;
              await saveState(this.state);
              await journal({ kind: 'entry', mode: 'live', text: `${sgl.dir > 0 ? 'Bought' : 'Sold'} ${qty} ${inst.symbol}. ${label}` });
              await journal({ kind: 'exit', mode: 'live', pnl: usd, text: `Closed ${sgl.dir > 0 ? 'long' : 'short'} ${qty} near ${exitPx}: ${usd >= 0 ? '+' : '-'}$${Math.abs(usd).toFixed(2)}. Stop/target filled within a second` });
              this.say(`Trade opened and closed right away. ${usd >= 0 ? 'Profit' : 'Loss'} of ${Math.abs(usd).toFixed(0)} dollars.`, `🤖 LIVE quick trade ${usd >= 0 ? '+' : '-'}$${Math.abs(usd).toFixed(2)}`, { voice: true, notify: true });
              if (this.cfg.risk.maxDailyLoss > 0 && this.state.pnlToday <= -Math.abs(this.cfg.risk.maxDailyLoss)) await this.halt('daily loss limit reached');
              return;
            }
            await this.broker.call('flatten', { accountId: c.accountId }).catch(() => {});
            await this.halt('entry order was not filled');
            return;
          }
          if (Math.sign(filled.qty) !== sgl.dir || Math.abs(filled.qty) !== qty) {
            await this.broker.call('flatten', { accountId: c.accountId }).catch(() => {});
            await this.halt(`unexpected position size ${filled.qty} after the order, closed it`);
            return;
          }
          if (filled.avg) {
            entry = filled.avg;
            st = entry - sgl.dir * c.exits.stopTicks * inst.tick;
            tg = c.exits.targetTicks > 0 ? entry + sgl.dir * c.exits.targetTicks * inst.tick : null;
          }
          m.symbol = inst.symbol;
        } catch (e) {
          await this.broker.call('flatten', { accountId: c.accountId }).catch(() => {});
          await this.halt(`order failed: ${e && e.message ? e.message : e}`);
          return;
        }
      }
      this.state.position = { dir: sgl.dir, qty, entry, stop: st, target: tg, t: sgl.t, tfMs: m.tfMs, symbol: m.symbol, mode: c.mode, lastPrice: entry, equityAtEntry, accountId: c.mode === 'live' ? c.accountId : '' };
      this.state.tradesToday += 1;
      await saveState(this.state);
      const what = `${sgl.dir > 0 ? 'Bought' : 'Sold'} ${qty} ${m.symbol} at ${entry}`;
      await journal({ kind: 'entry', mode: c.mode, text: `${what}. ${label}. Stop ${st ?? '–'}, target ${tg ?? '–'}` });
      this.say(`${c.mode === 'paper' ? 'Paper trade. ' : ''}${sgl.dir > 0 ? 'Long' : 'Short'} ${qty} ${String(m.symbol).replace(/^\//, '')} at ${entry}.`, `🤖 ${c.mode === 'paper' ? 'Paper ' : 'LIVE '}${what}`, { voice: true, notify: true });
    }

    async instrument() {
      if (this.inst && this.inst.chartKey === this.chartKey && Date.now() - this.inst.at < 600000) return this.inst;
      const i = await this.broker.call('instrument', { chartKey: this.chartKey });
      if (!i.tick) throw new Error('unknown tick size');
      this.inst = { ...i, chartKey: this.chartKey, at: Date.now() };
      return this.inst;
    }

    async exit(price, why, pv = 1, opts = {}) {
      const p = this.state.position;
      if (!p) return;
      let usd = null;
      if (p.mode === 'live') {
        const acct = p.accountId || this.cfg.accountId;
        try {
          if (!opts.alreadyFlat) {
            const inst0 = await this.instrument();
            const now0 = await this.broker.call('position', { accountId: acct, instrumentId: inst0.id });
            if (now0.qty === 0) { opts.alreadyFlat = true; why = 'Closed on Tradara'; }
          }
          if (!opts.alreadyFlat) {
            await this.broker.call('flatten', { accountId: acct });
            const inst = await this.instrument();
            let flat = false;
            for (let k = 0; k < 10 && !flat; k++) {
              await new Promise((r) => setTimeout(r, 700));
              flat = (await this.broker.call('position', { accountId: acct, instrumentId: inst.id })).qty === 0;
            }
            if (!flat) { await this.halt('could not confirm the position was closed. Check Tradara now'); return; }
          }
          const risk = await this.broker.call('risk', { accountId: acct });
          if (Number.isFinite(risk.equity) && Number.isFinite(p.equityAtEntry)) {
            usd = Math.round((risk.equity - p.equityAtEntry) * 100) / 100;
            // the real exit price, worked out from the account's equity change
            const inst = this.inst || {};
            const ppv = inst.pointValue || pv;
            if (ppv > 0 && p.qty) {
              let px = p.entry + usd / (p.qty * ppv * p.dir);
              if (inst.tick) px = Math.round(px / inst.tick) * inst.tick;
              price = Math.round(px * 1e6) / 1e6;
              if (opts.alreadyFlat) {
                const t = (inst.tick || 0.25) * 1.01;
                why = p.target !== null && Math.abs(price - p.target) <= t ? 'Take-profit filled'
                  : p.stop !== null && Math.abs(price - p.stop) <= t ? 'Stop-loss filled' : 'Closed on Tradara';
              }
            }
          }
        } catch (e) { await this.halt(`could not close position: ${e && e.message ? e.message : e}. Check Tradara now`); return; }
      }
      const pts = (price - p.entry) * p.dir;
      if (usd === null) usd = pts * p.qty * pv;
      this.state.position = null;
      this.state.pnlToday = Math.round((this.state.pnlToday + usd) * 100) / 100;
      this.state.lossStreak = usd < 0 ? this.state.lossStreak + 1 : 0;
      await saveState(this.state);
      const txt = `Closed ${p.dir > 0 ? 'long' : 'short'} ${p.qty} at ${price}: ${usd >= 0 ? '+' : '-'}$${Math.abs(usd).toFixed(2)} (${pts.toFixed(2)} pts). ${why}`;
      await journal({ kind: 'exit', mode: p.mode, pnl: usd, text: txt });
      this.say(`${p.mode === 'paper' ? 'Paper trade closed. ' : 'Position closed. '}${usd >= 0 ? 'Profit' : 'Loss'} of ${Math.abs(usd).toFixed(0)} dollars.`, `🤖 ${txt}`, { voice: true, notify: true });
      if (this.cfg.risk.maxDailyLoss > 0 && this.state.pnlToday <= -Math.abs(this.cfg.risk.maxDailyLoss)) await this.halt('daily loss limit reached');
      else if (this.cfg.risk.maxLossStreak > 0 && this.state.lossStreak >= this.cfg.risk.maxLossStreak) await this.halt(`${this.state.lossStreak} losses in a row`);
    }

    // paper fills: walk closed candles after entry; if stop and target are both inside one candle, assume the stop (conservative)
    async paperManage(bars, pv) {
      const p = this.state.position;
      if (!p) return;
      const closedCount = bars.length - (bars.lastBarForming ? 1 : 0);
      for (let i = 0; i < closedCount; i++) {
        const b = bars[i];
        if (b.t <= p.t || (p.checkedTo && b.t <= p.checkedTo)) continue;
        p.checkedTo = b.t;
        const hitStop = p.stop !== null && (p.dir > 0 ? b.l <= p.stop : b.h >= p.stop);
        const hitTarget = p.target !== null && (p.dir > 0 ? b.h >= p.target : b.l <= p.target);
        if (hitStop) { await this.exit(p.stop, 'Stop-loss hit', pv); return; }
        if (hitTarget) { await this.exit(p.target, 'Take-profit hit', pv); return; }
      }
      await saveState(this.state);
    }

    async fetchAccounts() {
      if (!this.broker) return;
      try {
        const list = await this.broker.call('accounts', {});
        await chrome.storage.local.set({ botAccounts: { at: Date.now(), list } });
      } catch (e) {
        await chrome.storage.local.set({ botAccounts: { at: Date.now(), list: [], error: String(e && e.message || e) } });
      }
    }

    async heartbeat() {
      if (this.active) await this.holdLease();
      const p = this.state.position;
      // keep watching a live position even if the bot was switched off or locked (its stop/target are still on Tradara)
      if (p && p.mode === 'live' && this.cfg.accountId && this.chartKey && Date.now() - (this.lastLiveCheck || 0) > 3000) {
        this.lastLiveCheck = Date.now();
        try {
          const inst = await this.instrument();
          const pos = await this.broker.call('position', { accountId: p.accountId || this.cfg.accountId, instrumentId: inst.id });
          if (pos.qty === 0) await this.exit(p.lastPrice || p.entry, 'Closed on Tradara', inst.pointValue || 1, { alreadyFlat: true });
        } catch (e) { /* network hiccup: try again next beat */ }
      }
      this.publish();
    }

    publish(note) {
      const c = this.cfg, s = this.state;
      this.onStatus({
        mode: c.mode, unlocked: this.unlocked, liveReady: LIVE_READY, halted: s.halted || '', note: note || '',
        position: s.position ? { dir: s.position.dir, qty: s.position.qty, entry: s.position.entry, stop: s.position.stop, target: s.position.target, last: s.position.lastPrice } : null,
        tradesToday: s.tradesToday, maxTrades: c.risk.maxTradesPerDay, pnlToday: s.pnlToday,
      });
    }
  }

  const api = { LIVE_READY, DEFAULTS, STATE_DEFAULTS, loadCfg, saveCfg, loadState, saveState, journal, auth, Engine, et, sessionDay, inWindow };
  if (typeof window !== 'undefined') window.PTOBot = api;
})();
