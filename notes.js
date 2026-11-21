'use strict';
// Chart notes editor (manager page). Notes autosave as you type.

(() => {
  const $ = (id) => document.getElementById(id);
  let notes = [];
  let noteSel = null;
  let saveTimer = null;
  let editing = false;

  function cur() { return notes.find((n) => n.id === noteSel); }

  function renderNoteList() {
    const list = $('noteList');
    list.innerHTML = '';
    for (const n of notes) {
      const div = document.createElement('div');
      div.className = 'item' + (n.id === noteSel ? ' sel' : '');
      div.innerHTML = '<span class="dot"></span><span class="nm"></span><span class="kind">note</span>';
      div.querySelector('.dot').classList.toggle('on', !!n.enabled);
      div.querySelector('.nm').textContent = n.title || 'Note';
      div.onclick = () => select(n.id);
      list.appendChild(div);
    }
  }

  function renderNoteEditor() {
    const n = cur();
    if (!n) return;
    $('noteTitle').value = n.title || '';
    $('noteEnabled').checked = !!n.enabled;
    $('noteText').value = n.text || '';
    $('noteFont').value = String(n.fontSize || 13);
    $('noteOpacity').value = String(n.opacity ?? 0.88);
    $('noteAccent').value = /^#[0-9a-f]{6}$/i.test(n.accent || '') ? n.accent : '#00e5ff';
  }

  function select(id) {
    if (pendingId) flush();
    noteSel = id;
    document.body.classList.add('mode-note');
    $('scriptPanel').hidden = true;
    $('notePanel').hidden = false;
    renderNoteList();
    renderNoteEditor();
  }

  // called by manager.js when a script is picked
  window.notesDeselect = () => { noteSel = null; renderNoteList(); };

  let pendingId = null, pendingPatch = {};
  async function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!pendingId) return;
    const id = pendingId, patch = pendingPatch;
    pendingId = null; pendingPatch = {};
    editing = true;
    const fresh = await loadNotes();
    const t = fresh.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
    await saveNotes(fresh);
    editing = false;
    $('noteSaved').classList.add('show'); setTimeout(() => $('noteSaved').classList.remove('show'), 900);
  }

  // edits are merged and saved together (typing in the title then the text keeps both)
  function patchCurrent(patch, immediate) {
    const n = cur(); if (!n) return;
    Object.assign(n, patch);
    if (pendingId && pendingId !== n.id) flush();
    pendingId = n.id;
    Object.assign(pendingPatch, patch);
    renderNoteList();
    clearTimeout(saveTimer);
    if (immediate) flush(); else saveTimer = setTimeout(flush, 400);
  }
  window.addEventListener('beforeunload', () => { if (pendingId) flush(); });

  $('noteTitle').addEventListener('input', (e) => patchCurrent({ title: e.target.value }));
  $('noteText').addEventListener('input', (e) => patchCurrent({ text: e.target.value }));
  $('noteEnabled').addEventListener('change', (e) => patchCurrent({ enabled: e.target.checked }, true));
  $('noteFont').addEventListener('change', (e) => patchCurrent({ fontSize: Number(e.target.value) }, true));
  $('noteOpacity').addEventListener('input', (e) => patchCurrent({ opacity: Number(e.target.value) }));
  $('noteAccent').addEventListener('input', (e) => patchCurrent({ accent: e.target.value }));
  $('noteResetPos').addEventListener('click', () => patchCurrent({ x: 0.02, y: 0.1, w: 380, collapsed: false }, true));
  $('noteDel').addEventListener('click', async () => {
    const n = cur(); if (!n || !confirm(`Delete note "${n.title || 'Note'}"?`)) return;
    const fresh = (await loadNotes()).filter((x) => x.id !== n.id);
    noteSel = null;
    await saveNotes(fresh);
    document.body.classList.remove('mode-note');
    $('notePanel').hidden = true; $('scriptPanel').hidden = false;
  });
  $('newNote').addEventListener('click', async () => {
    const fresh = await loadNotes();
    // stagger new boxes so they don't sit exactly on top of each other
    const n = newNote({ title: 'New note', y: Math.min(0.7, 0.1 + 0.06 * fresh.length), x: Math.min(0.6, 0.02 + 0.03 * fresh.length) });
    fresh.push(n);
    await saveNotes(fresh);
    notes = fresh;
    select(n.id);
    $('noteTitle').focus(); $('noteTitle').select();
  });

  async function reload() {
    notes = await loadNotes();
    if (noteSel && !cur()) noteSel = null;
    renderNoteList();
    // don't overwrite fields while typing; positions/collapse changed from the chart are harmless
    if (noteSel && !editing && document.activeElement !== $('noteText') && document.activeElement !== $('noteTitle')) renderNoteEditor();
  }
  chrome.storage.onChanged.addListener((c) => { if (c.notes) reload(); });
  reload();
})();
