'use strict';

let listSig = '';

function statusText(s, st) {
  if (!s.enabled) return { t: '', err: false };
  if (!st) return { t: 'waiting for chart…', err: false };
  return st.ok ? { t: `ok · ${st.ms ?? '?'} ms`, err: false } : { t: 'error', err: true, title: st.error || '' };
}

async function render() {
  const { settings, scripts, status } = await loadAll();
  const master = document.getElementById('master');
  master.checked = settings.enabled;
  master.onchange = async () => {
    const fresh = (await loadAll()).settings;
    await saveSettings({ ...fresh, enabled: master.checked });
  };

  const list = document.getElementById('list');
  // Only rebuild the rows when the list itself changes; status updates just change text.
  // (Rebuilding while you click can swallow the click.)
  const sig = JSON.stringify(scripts.map((s) => [s.id, s.name, !!s.enabled]));
  if (sig !== listSig) {
    listSig = sig;
    list.innerHTML = '';
    if (!scripts.length) {
      list.innerHTML = '<div class="empty">No scripts yet. Open the manager to add one.</div>';
      return;
    }
    for (const s of scripts) {
      const li = document.createElement('li');
      li.dataset.id = s.id;
      li.innerHTML = `
        <label class="switch"><input type="checkbox" ${s.enabled ? 'checked' : ''}><span></span></label>
        <div class="name"></div><div class="st"></div>`;
      li.querySelector('.name').textContent = s.name;
      li.querySelector('.name').title = s.name;
      li.querySelector('input').onchange = async (e) => {
        const want = e.target.checked;
        const fresh = (await loadAll()).scripts;
        const t = fresh.find((x) => x.id === s.id);
        if (t) t.enabled = want;
        await saveScripts(fresh);
      };
      list.appendChild(li);
    }
  }
  for (const s of scripts) {
    const li = list.querySelector(`li[data-id="${CSS.escape(s.id)}"]`);
    if (!li) continue;
    const box = li.querySelector('input');
    if (document.activeElement !== box) box.checked = !!s.enabled;
    const st = statusText(s, status[s.id]);
    const el = li.querySelector('.st');
    el.textContent = st.t;
    el.className = 'st' + (st.err ? ' err' : '');
    el.title = st.title || '';
  }
}

let notesSig = '';
async function renderNotes() {
  const notes = await loadNotes();
  const ul = document.getElementById('notes');
  const sig = JSON.stringify(notes.map((n) => [n.id, n.title, !!n.enabled]));
  if (sig === notesSig) return;
  notesSig = sig;
  ul.innerHTML = '';
  if (!notes.length) { ul.innerHTML = '<div class="empty">No notes. Add one in the manager.</div>'; return; }
  for (const n of notes) {
    const li = document.createElement('li');
    li.innerHTML = `<label class="switch"><input type="checkbox" ${n.enabled ? 'checked' : ''}><span></span></label><div class="name"></div>`;
    li.querySelector('.name').textContent = n.title || 'Note';
    li.querySelector('input').onchange = async (e) => {
      const fresh = await loadNotes();
      const t = fresh.find((x) => x.id === n.id);
      if (t) t.enabled = e.target.checked;
      await saveNotes(fresh);
    };
    ul.appendChild(li);
  }
}

document.getElementById('open').onclick = () => chrome.runtime.openOptionsPage();
chrome.storage.onChanged.addListener((changes) => {
  if (changes.scripts || changes.settings || changes.status) render();
  if (changes.notes) renderNotes();
});
render();
renderNotes();
