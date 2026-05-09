'use strict';

let entries = [];

const form = document.getElementById('memory-form');
const idInput = document.getElementById('entry-id');
const typeInput = document.getElementById('entry-type');
const keyInput = document.getElementById('entry-key');
const valueInput = document.getElementById('entry-value');
const aliasesInput = document.getElementById('entry-aliases');
const noteInput = document.getElementById('entry-note');
const list = document.getElementById('memory-list');
const formTitle = document.getElementById('form-title');
const saveBtn = document.getElementById('save-btn');
const cancelBtn = document.getElementById('cancel-btn');

function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function formatAliases(aliases = []) {
  return aliases.length ? `Aliases: ${aliases.join(', ')}` : '';
}

function setValuePlaceholder() {
  const placeholders = {
    email: 'dakota@example.com',
    url: 'blog.example.com',
    text: 'Reusable value Jennifer should remember',
  };
  valueInput.placeholder = placeholders[typeInput.value] || placeholders.text;
}

function entryPayload() {
  return {
    type: typeInput.value,
    key: keyInput.value.trim(),
    value: valueInput.value.trim(),
    aliases: aliasesInput.value.trim(),
    note: noteInput.value.trim(),
  };
}

function resetForm() {
  form.reset();
  idInput.value = '';
  formTitle.textContent = 'Add Variable';
  saveBtn.textContent = 'Save Variable';
  cancelBtn.style.display = 'none';
  setValuePlaceholder();
}

function editEntry(entry) {
  idInput.value = entry.id;
  typeInput.value = entry.type;
  keyInput.value = entry.key;
  valueInput.value = entry.value;
  aliasesInput.value = (entry.aliases || []).join(', ');
  noteInput.value = entry.note || '';
  formTitle.textContent = 'Edit Variable';
  saveBtn.textContent = 'Update Variable';
  cancelBtn.style.display = '';
  setValuePlaceholder();
  keyInput.focus();
}

function memoryItem(entry) {
  const item = document.createElement('li');
  item.className = 'memory-item';

  const main = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'memory-title';

  const name = document.createElement('span');
  name.textContent = entry.key;
  const type = document.createElement('span');
  type.className = 'memory-type';
  type.textContent = entry.type;
  title.append(name, type);

  const value = document.createElement('div');
  value.className = 'memory-value';
  value.textContent = entry.value;

  const meta = document.createElement('div');
  meta.className = 'memory-meta';
  const aliasText = formatAliases(entry.aliases || []);
  meta.textContent = [aliasText, entry.note || ''].filter(Boolean).join('  ');

  main.append(title, value);
  if (meta.textContent) main.append(meta);

  const actions = document.createElement('div');
  actions.className = 'memory-actions';

  const edit = document.createElement('button');
  edit.className = 'btn ghost';
  edit.type = 'button';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => editEntry(entry));

  const del = document.createElement('button');
  del.className = 'btn danger';
  del.type = 'button';
  del.textContent = 'Delete';
  del.addEventListener('click', () => deleteEntry(entry));

  actions.append(edit, del);
  item.append(main, actions);
  return item;
}

function render() {
  list.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No memory variables saved yet.';
    list.appendChild(empty);
    return;
  }

  for (const entry of entries) list.appendChild(memoryItem(entry));
}

async function loadEntries() {
  const res = await fetch('/api/memory');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  entries = data.entries || [];
  render();
}

async function saveEntry(event) {
  event.preventDefault();

  const id = idInput.value;
  const url = id ? `/api/memory/${encodeURIComponent(id)}` : '/api/memory';
  const method = id ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entryPayload()),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    showToast(id ? 'Variable updated' : 'Variable saved', 'success');
    resetForm();
    await loadEntries();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteEntry(entry) {
  if (!confirm(`Delete "${entry.key}"?`)) return;

  try {
    const res = await fetch(`/api/memory/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast('Variable deleted');
    if (idInput.value === entry.id) resetForm();
    await loadEntries();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

form.addEventListener('submit', saveEntry);
cancelBtn.addEventListener('click', resetForm);
typeInput.addEventListener('change', setValuePlaceholder);

setValuePlaceholder();
loadEntries().catch(err => showToast(err.message, 'error'));
