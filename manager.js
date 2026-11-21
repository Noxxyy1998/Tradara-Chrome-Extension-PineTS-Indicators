'use strict';

let state = { settings: null, scripts: [], status: {} };
let selId = null;
let dirty = false;

const $ = (id) => document.getElementById(id);

async function refresh(keepEditor) {
  state = await loadAll();
  if (!selId || !state.scripts.some((s) => s.id === selId)) selId = state.scripts[0]?.id || null;
  renderList();
  if (!keepEditor) renderEditor();
  renderStatus();
  renderSettings();
}

function kindOf(code) { return /^\s*strategy\s*\(/m.test(code) ? 'strategy' : 'indicator'; }

let listSig = '';
function renderList() {
  const list = $('list');
  // skip rebuilding when nothing visible changed (rebuilding mid-click swallows the click)
  const sig = JSON.stringify([selId, state.scripts.map((s) => [s.id, s.name, !!s.enabled, kindOf(s.code || ''), state.status[s.id] ? !!state.status[s.id].ok : null])]);
  if (sig === listSig) return;
  listSig = sig;
  list.innerHTML = '';
  for (const s of state.scripts) {
    const st = state.status[s.id];
    const div = document.createElement('div');
    div.className = 'item' + (s.id === selId ? ' sel' : '');
    div.innerHTML = `<span class="dot ${s.enabled ? (st && !st.ok ? 'err' : 'on') : ''}"></span><span class="nm"></span><span class="kind"></span>`;
    div.querySelector('.nm').textContent = s.name;
    div.querySelector('.kind').textContent = kindOf(s.code || '');
    div.onclick = () => {
      if (dirty && !confirm('Discard unsaved changes?')) return;
      selId = s.id; dirty = false; showScriptPanel(); listSig = ''; renderList(); renderEditor(); renderStatus();
    };
    list.appendChild(div);
  }
}

function current() { return state.scripts.find((s) => s.id === selId); }

function showScriptPanel() {
  document.body.classList.remove('mode-note');
  $('scriptPanel').hidden = false;
  $('notePanel').hidden = true;
  if (window.notesDeselect) window.notesDeselect();
}

function renderEditor() {
  const s = current();
  const has = !!s;
  for (const id of ['name', 'enabled', 'save', 'del', 'code', 'settingsBtn']) $(id).disabled = !has;
  $('name').value = s ? s.name : '';
  $('enabled').checked = s ? !!s.enabled : false;
  $('code').value = s ? s.code : '';
}

function renderStatus() {
  const s = current();
  const el = $('status');
  el.className = '';
  if (!s) { el.textContent = 'Select or create a script.'; return; }
  const st = state.status[s.id];
  if (!s.enabled) { el.textContent = 'Not shown on chart. Tick "Show on chart" and save to run it on Tradara.'; return; }
  if (!st) { el.textContent = 'Waiting for a Tradara chart… (open terminal.tradara.com in a tab)'; return; }
  const when = new Date(st.at).toLocaleTimeString();
  if (st.ok) {
    el.className = 'ok';
    el.textContent = `✓ Ran OK in ${st.ms} ms at ${when}` + (st.warnings?.length ? '\nWarnings:\n' + st.warnings.join('\n') : '');
  } else {
    el.className = 'err';
    el.textContent = `✗ Error at ${when}\n${st.error}`;
  }
}

function renderSettings() {
  const s = state.settings;
  $('s_enabled').checked = s.enabled;
  $('s_showTrades').checked = s.showTrades;
  $('s_showHud').checked = s.showHud;
  $('s_closedOnly').checked = s.strategyClosedBarsOnly;
  if (document.activeElement !== $('s_maxBars')) $('s_maxBars').value = s.maxBars;
  if (document.activeElement !== $('s_pointValue')) $('s_pointValue').value = s.pointValue;
}

async function persistSettings() {
  const s = {
    ...state.settings,
    enabled: $('s_enabled').checked,
    showTrades: $('s_showTrades').checked,
    showHud: $('s_showHud').checked,
    strategyClosedBarsOnly: $('s_closedOnly').checked,
    maxBars: Math.max(100, Math.min(50000, parseInt($('s_maxBars').value, 10) || 5000)),
    pointValue: Math.max(0, parseFloat($('s_pointValue').value) || 0),
  };
  await saveSettings(s);
}
for (const id of ['s_enabled', 's_showTrades', 's_showHud', 's_closedOnly', 's_maxBars', 's_pointValue']) $(id).addEventListener('change', persistSettings);

async function save() {
  const s = current(); if (!s) return;
  const fresh = (await loadAll()).scripts;
  const t = fresh.find((x) => x.id === s.id); if (!t) return;
  t.code = $('code').value;
  t.name = $('name').value.trim() || nameFromCode(t.code, 'Untitled');
  t.enabled = $('enabled').checked;
  await saveScripts(fresh);
  dirty = false;
  $('savedMsg').classList.add('show'); setTimeout(() => $('savedMsg').classList.remove('show'), 1200);
}

async function addScript(code, name) {
  const fresh = (await loadAll()).scripts;
  const s = { id: crypto.randomUUID(), name: name || nameFromCode(code, 'New script'), code, enabled: true };
  fresh.push(s);
  selId = s.id;
  dirty = false;
  showScriptPanel();
  await saveScripts(fresh);
}

$('save').onclick = save;
$('settingsBtn').onclick = async () => {
  if (dirty) await save();
  if (selId) window.PTOSettings.open(selId);
};
$('del').onclick = async () => {
  const s = current(); if (!s || !confirm(`Delete "${s.name}"?`)) return;
  const fresh = (await loadAll()).scripts.filter((x) => x.id !== s.id);
  selId = null; dirty = false;
  await saveScripts(fresh);
};
$('enabled').onchange = save;
$('code').addEventListener('input', () => { dirty = true; });
$('name').addEventListener('input', () => { dirty = true; });
$('code').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target, a = ta.selectionStart, b = ta.selectionEnd;
    ta.setRangeText('    ', a, b, 'end'); dirty = true;
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!document.body.classList.contains('mode-note')) save(); }
});
$('newStrategy').onclick = () => addScript(TEMPLATES.strategy);
$('newIndicator').onclick = () => addScript(TEMPLATES.indicator);
$('newPane').onclick = () => addScript(TEMPLATES.pane);
$('import').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const code = await f.text();
  await addScript(code, nameFromCode(code, f.name.replace(/\.\w+$/, '')));
  e.target.value = '';
};
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.scripts && !changes.settings && !changes.status) return; // e.g. metadata updates
  // don't clobber the editor while the user is typing; status updates are fine
  refresh(dirty || !changes.scripts);
});
refresh(false);
