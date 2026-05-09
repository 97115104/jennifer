'use strict';

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 4000);
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// Read ?connected= or ?error= from URL and show toast
const params = new URLSearchParams(location.search);
if (params.get('connected')) showToast(`${params.get('connected')} connected!`, 'success');
if (params.get('error')) showToast(`Error: ${params.get('error')}`, 'error');
if (params.get('connected') || params.get('error')) {
  history.replaceState(null, '', '/settings');
}

// ─── Load Settings ────────────────────────────────────────────────────────────

let settings = {};
let health = {};

async function loadSettings() {
  const [settingsRes, healthRes] = await Promise.all([
    fetch('/api/settings'),
    fetch('/api/health'),
  ]);
  settings = await settingsRes.json();
  health = await healthRes.json();
  renderApp(settings.app);
  renderInference(settings.inference);
  renderTTSStatus(settings.tts, health.tts);
  renderVoices(settings.voices, settings.tts);
  renderGoogle(settings.google);
  renderGitHub(settings.github);
}

loadSettings().catch(err => console.error('[settings] Load failed:', err));

// ─── Voice Cloning ────────────────────────────────────────────────────────────


let recorder = null;
let recordChunks = [];
let recTimerInterval = null;
let recSeconds = 0;
let mediaStream = null;

const startBtn = document.getElementById('record-start-btn');
const stopBtn = document.getElementById('record-stop-btn');
const uploadSourceBtn = document.getElementById('upload-source-btn');
const voiceFileInput = document.getElementById('voice-file');
const recIndicator = document.getElementById('rec-indicator');
const recTimer = document.getElementById('rec-timer');
const promptsBox = document.getElementById('reading-prompts');
const assistantNameInput = document.getElementById('assistant-name');
const saveAssistantNameBtn = document.getElementById('save-assistant-name-btn');

function renderApp(app = {}) {
  const name = app.name || 'Jennifer';
  if (assistantNameInput) assistantNameInput.value = name;
  document.title = `${name} — Settings`;
}

saveAssistantNameBtn?.addEventListener('click', async () => {
  const name = assistantNameInput.value.trim();
  if (!name) { showToast('Enter an assistant name', 'error'); return; }

  try {
    const res = await fetch('/api/settings/app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(`Assistant name saved as "${data.app.name}"`, 'success');
    await loadSettings();
  } catch (err) {
    showToast('Name update failed: ' + err.message, 'error');
  }
});

// ─── AI Model Tab ─────────────────────────────────────────────────────────────

// Per 1M tokens pricing (source: provider websites)
const PRICING = {
  'gpt-4o-mini':               { i: 0.15,  o: 0.60  },
  'gpt-4o':                    { i: 2.50,  o: 10.00 },
  'gpt-4-turbo':               { i: 10.00, o: 30.00 },
  'gpt-3.5-turbo':             { i: 0.50,  o: 1.50  },
  'o1-mini':                   { i: 3.00,  o: 12.00 },
  'o1':                        { i: 15.00, o: 60.00 },
  'o3-mini':                   { i: 1.10,  o: 4.40  },
  'claude-haiku-4-5-20251001': { i: 0.80,  o: 4.00  },
  'claude-haiku-3-5-20241022': { i: 0.80,  o: 4.00  },
  'claude-sonnet-4-6':         { i: 3.00,  o: 15.00 },
  'claude-opus-4-7':           { i: 15.00, o: 75.00 },
  'gemini-2.5-flash-lite':     { i: 0.10,  o: 0.40  },
  'gemini-2.0-flash-lite':     { i: 0.075, o: 0.30  },
  'gemini-2.0-flash':          { i: 0.10,  o: 0.40  },
  'gemini-2.5-flash':          { i: 0.15,  o: 0.60  },
  'gemini-2.5-pro':            { i: 1.25,  o: 10.00 },
};

// ~500 input + 200 output tokens per typical voice turn
function costPerRequest(modelId) {
  const p = PRICING[modelId];
  if (!p) return null;
  const c = (500 * p.i + 200 * p.o) / 1_000_000;
  return c < 0.001 ? `~$${c.toFixed(4)}/req` : `~$${c.toFixed(3)}/req`;
}

const PROVIDER_DEFAULTS = {
  '429-inference': 'gpt-oss',
  'chatgpt':       'gpt-4o-mini',
  'anthropic':     'claude-haiku-4-5-20251001',
  'gemini':        'gemini-2.5-flash',
  'custom':        '',
};

const PRICING_ROWS = {
  chatgpt: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini',  badge: 'Cheapest' },
    { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', badge: '' },
    { id: 'o3-mini',     label: 'o3 mini',       badge: '' },
    { id: 'gpt-4o',      label: 'GPT-4o',        badge: '' },
    { id: 'o1-mini',     label: 'o1 mini',        badge: '' },
    { id: 'o1',          label: 'o1',             badge: 'Smartest' },
  ],
  anthropic: [
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',  badge: 'Cheapest' },
    { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6', badge: '' },
    { id: 'claude-opus-4-7',           label: 'Claude Opus 4.7',   badge: 'Smartest' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', badge: 'Cheapest' },
    { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite', badge: '' },
    { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash',      badge: '' },
    { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro',        badge: 'Smartest' },
  ],
};

function _buildPricingTable(provider) {
  const rows = PRICING_ROWS[provider];
  const el = document.getElementById(`pricing-${provider}`);
  if (!el) return;
  if (!rows) {
    el.innerHTML = `<div class="config-note" style="margin-top:8px">See <a href="https://429inference.com/pricing" target="_blank">429inference.com/pricing</a> for rates.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="pricing-table-inner" style="margin-top:12px">
      <table>
        <thead><tr>
          <th>Model</th>
          <th>Input /1M</th>
          <th>Output /1M</th>
          <th>~Cost/req</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => {
            const p = PRICING[r.id] || {};
            const inP  = p.i  != null ? `$${p.i}`  : '—';
            const outP = p.o != null ? `$${p.o}` : '—';
            const cost = costPerRequest(r.id) || '—';
            return `<tr>
              <td>${r.label}${r.badge ? `<span class="pricing-badge">${r.badge}</span>` : ''}</td>
              <td>${inP}</td><td>${outP}</td>
              <td class="cost">${cost}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <div style="font-size:0.72rem;color:var(--text-muted);padding:6px 10px">~req = 500 input + 200 output tokens (typical voice turn)</div>
    </div>`;
}

function _showProviderSection(provider) {
  const MAP = { '429-inference': '429', chatgpt: 'chatgpt', anthropic: 'anthropic', gemini: 'gemini', custom: 'custom' };
  const active = MAP[provider] || '429';
  for (const [p, id] of Object.entries(MAP)) {
    const el = document.getElementById(`inf-${id}-section`);
    if (el) el.style.display = (p === provider) ? '' : 'none';
  }
}

function renderInference(inf = {}) {
  const provider = _normalizeProvider(inf.provider || '429-inference');
  const sel = document.getElementById('inf-provider');
  if (sel) sel.value = provider;

  const fields = {
    'inf-429-key':       inf.hasApi429Key    ? '***' : '',
    'inf-chatgpt-key':   inf.hasChatgptKey   ? '***' : '',
    'inf-anthropic-key': inf.hasAnthropicKey ? '***' : '',
    'inf-gemini-key':    inf.hasGeminiKey    ? '***' : '',
    'inf-api-key':       inf.hasApiKey       ? '***' : '',
    'inf-api-url':       inf.apiUrl          || '',
  };
  for (const [id, val] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }

  _showProviderSection(provider);
  _buildPricingTable('429');
  _buildPricingTable('chatgpt');
  _buildPricingTable('anthropic');
  _buildPricingTable('gemini');
  _fetchAndPopulateModels(provider, inf.model || '');
}

function _normalizeProvider(p) {
  if (p === 'openai-compatible') return 'custom';
  return ['429-inference','chatgpt','anthropic','gemini','custom'].includes(p) ? p : '429-inference';
}

let _modelsAbortCtrl = null;

async function _fetchAndPopulateModels(provider, currentModel) {
  const sel  = document.getElementById('inf-model-select');
  const note = document.getElementById('inf-model-note');
  if (!sel) return;

  sel.innerHTML = '<option value="">Loading models…</option>';
  if (note) note.textContent = '';

  if (_modelsAbortCtrl) _modelsAbortCtrl.abort();
  _modelsAbortCtrl = new AbortController();

  try {
    const res  = await fetch(`/api/settings/inference/models?provider=${encodeURIComponent(provider)}`, { signal: _modelsAbortCtrl.signal });
    const data = await res.json();

    if (data.models?.length) {
      // Sort: known-pricing models cheapest-first, then alphabetical for rest
      const sorted = [...data.models].sort((a, b) => {
        const pa = PRICING[a.id], pb = PRICING[b.id];
        if (pa && pb) return (pa.i + pa.o) - (pb.i + pb.o);
        if (pa) return -1;
        if (pb) return  1;
        return a.id.localeCompare(b.id);
      });

      sel.innerHTML = sorted.map(m => {
        const cost  = costPerRequest(m.id);
        const label = cost ? `${m.id}  (${cost})` : m.id;
        return `<option value="${m.id}"${m.id === currentModel ? ' selected' : ''}>${label}</option>`;
      }).join('');

      // If saved model isn't in list, prepend it
      if (currentModel && !data.models.find(m => m.id === currentModel)) {
        sel.innerHTML = `<option value="${currentModel}" selected>${currentModel}</option>` + sel.innerHTML;
      }

      // Auto-select cheapest default if nothing selected
      if (!sel.value) sel.value = sorted[0]?.id || '';

      if (note) note.textContent = `${data.models.length} models available`;
    } else {
      const fallback = currentModel || PROVIDER_DEFAULTS[provider] || '';
      sel.innerHTML = `<option value="${fallback}">${fallback || 'Save API key first to load models'}</option>`;
      if (note && data.error) note.textContent = data.error;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    const fallback = currentModel || '';
    sel.innerHTML = `<option value="${fallback}">${fallback || ''}</option>`;
    if (note) note.textContent = 'Could not load models — save your API key first';
  }
}

document.getElementById('inf-provider')?.addEventListener('change', e => {
  const provider = e.target.value;
  _showProviderSection(provider);
  _fetchAndPopulateModels(provider, PROVIDER_DEFAULTS[provider] || '');
});

document.getElementById('inf-refresh-models-btn')?.addEventListener('click', () => {
  const provider = document.getElementById('inf-provider')?.value || '429-inference';
  const current  = document.getElementById('inf-model-select')?.value || '';
  _fetchAndPopulateModels(provider, current);
});

document.getElementById('save-inference-btn')?.addEventListener('click', async () => {
  const provider = document.getElementById('inf-provider')?.value || '429-inference';
  const model    = document.getElementById('inf-model-select')?.value || PROVIDER_DEFAULTS[provider] || '';
  const MASK = '***';

  const body = { provider, model };
  const keyFields = {
    api429Key:       'inf-429-key',
    chatgptApiKey:   'inf-chatgpt-key',
    anthropicApiKey: 'inf-anthropic-key',
    geminiApiKey:    'inf-gemini-key',
    apiKey:          'inf-api-key',
    apiUrl:          'inf-api-url',
  };
  for (const [field, id] of Object.entries(keyFields)) {
    const val = document.getElementById(id)?.value.trim() || '';
    if (val !== MASK) body[field] = val;
  }

  const resultEl = document.getElementById('inf-save-result');
  try {
    const res = await fetch('/api/settings/inference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast('AI provider settings saved', 'success');
    if (resultEl) resultEl.textContent = '';
    await loadSettings();
    // Refresh model list after saving (key may have changed)
    setTimeout(() => _fetchAndPopulateModels(provider, model), 300);
  } catch (err) {
    if (resultEl) resultEl.textContent = err.message;
    showToast('Save failed: ' + err.message, 'error');
  }
});

function cleanVoiceName(value) {
  return (value || '').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

startBtn.addEventListener('click', async () => {
  const name = document.getElementById('voice-name').value.trim();
  if (!name) { showToast('Enter a name for this voice first', 'error'); return; }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('Microphone access denied: ' + err.message, 'error');
    return;
  }

  recordChunks = [];
  const mimeType = (() => {
    const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return c.find(t => MediaRecorder.isTypeSupported(t)) || '';
  })();

  recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = e => { if (e.data.size > 0) recordChunks.push(e.data); };
  recorder.onstop = () => uploadVoice(name);
  recorder.start(100);

  recSeconds = 0;
  recTimer.textContent = '0s';
  recTimerInterval = setInterval(() => {
    recSeconds++;
    recTimer.textContent = `${recSeconds}s`;
    // Highlight current prompt based on time (one prompt ~every 4 seconds)
    const lines = document.querySelectorAll('.prompt-line');
    const idx = Math.floor(recSeconds / 4) % lines.length;
    lines.forEach((el, i) => el.classList.toggle('active-prompt', i === idx));
  }, 1000);

  startBtn.style.display = 'none';
  stopBtn.style.display = '';
  recIndicator.classList.add('visible');
  promptsBox.style.display = 'block';
  console.log('[settings] Recording started for voice:', name);
});

stopBtn.addEventListener('click', () => {
  if (recorder && recorder.state === 'recording') recorder.stop();
  mediaStream?.getTracks().forEach(t => t.stop());
  clearInterval(recTimerInterval);
  stopBtn.style.display = 'none';
  startBtn.style.display = '';
  recIndicator.classList.remove('visible');
  promptsBox.style.display = 'none';
  document.querySelectorAll('.prompt-line').forEach(el => el.classList.remove('active-prompt'));
});

uploadSourceBtn.addEventListener('click', async () => {
  const file = voiceFileInput.files?.[0];
  if (!file) { showToast('Choose an audio source file first', 'error'); return; }

  const typedName = document.getElementById('voice-name').value.trim();
  const name = cleanVoiceName(typedName || file.name);
  if (!name) { showToast('Enter a name for this voice source', 'error'); return; }

  await saveVoiceBlob(name, file, file.name || 'source.wav');
});

async function uploadVoice(name) {
  const blob = new Blob(recordChunks, { type: recorder?.mimeType || 'audio/webm' });
  await saveVoiceBlob(name, blob, 'sample.webm');
}

async function saveVoiceBlob(name, blob, filename) {
  console.log(`[settings] Uploading voice "${name}": ${(blob.size / 1024).toFixed(0)}KB`);
  showToast('Uploading and converting voice sample…');

  const form = new FormData();
  form.append('audio', blob, filename);
  form.append('name', name);

  try {
    const res = await fetch('/api/settings/voices/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // Auto-activate the voice we just recorded
    const savedName = data.name;
    await fetch('/api/settings/voices/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: savedName }),
    });

    showToast(`Voice "${savedName}" saved and activated`, 'success');
    document.getElementById('voice-name').value = '';
    if (voiceFileInput) voiceFileInput.value = '';
    await loadSettings();
  } catch (err) {
    console.error('[settings] Upload failed:', err);
    showToast('Upload failed: ' + err.message, 'error');
  }
}

function renderTTSStatus(tts = {}, ttsHealth = {}) {
  const el = document.getElementById('tts-status');
  if (!el) return;

  const active = ttsHealth.activeProvider || tts.provider || 'system';
  const configured = ttsHealth.configuredProvider || tts.provider || 'system';
  const voiceName = tts.activeVoice ? tts.activeVoice.split('/').pop().replace('.wav', '') : null;

  if (active === 'coqui' && voiceName) {
    el.innerHTML = `
      <div class="info-banner success">
        <strong>Voice cloning active: "${voiceName}"</strong><br>
        Jennifer is using the embedded XTTS v2 service at <code>localhost:5123</code>.
      </div>`;
    return;
  }

  if (active === 'coqui') {
    el.innerHTML = `
      <div class="info-banner">
        Voice cloning is running. Record or activate a voice sample below to use it.
      </div>`;
    return;
  }

  const providerHint = configured === 'coqui'
    ? 'Jennifer was configured for Coqui, but startup fell back to system TTS. Check <code>tts/server.log</code>.'
    : 'Set <code>TTS_PROVIDER=coqui</code> in <code>.env</code>, then restart Jennifer to enable voice cloning.';

  el.innerHTML = `
    <div class="info-banner warning">
      <strong>Using system TTS.</strong><br>
      ${voiceName ? `Active voice sample: "${voiceName}". ` : ''}${providerHint}
    </div>`;
}

function renderVoices(voices = [], tts = {}) {
  const list = document.getElementById('voice-list');
  if (!voices.length) {
    list.innerHTML = '<li style="color:var(--text-muted);font-size:0.85rem;padding:4px 0">No voices saved yet — record one above.</li>';
    return;
  }

  list.innerHTML = voices.map(v => {
    const isActive = tts.activeVoice && tts.activeVoice.includes(`${v.name}.wav`);
    return `
      <li class="voice-item" data-name="${v.name}">
        <span class="voice-name">${v.name}</span>
        ${isActive ? '<span class="active-tag">Active</span>' : ''}
        ${!isActive
          ? `<button class="btn ghost" style="padding:5px 12px;font-size:0.8rem" onclick="setActiveVoice('${v.name}')">Use</button>`
          : `<button class="btn ghost" style="padding:5px 12px;font-size:0.8rem" onclick="setActiveVoice(null)">Deactivate</button>`
        }
        <a class="btn ghost" style="padding:5px 12px;font-size:0.8rem;text-decoration:none" href="/api/settings/voices/${encodeURIComponent(v.name)}/download">Download</a>
        <button class="btn danger" style="padding:5px 12px;font-size:0.8rem" onclick="deleteVoice('${v.name}')">Delete</button>
      </li>`;
  }).join('');
}

async function setActiveVoice(name) {
  const res = await fetch('/api/settings/voices/active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (res.ok) {
    showToast(name ? `"${name}" set as active voice` : 'Voice deactivated', 'success');
    await loadSettings();
  }
}

async function deleteVoice(name) {
  if (!confirm(`Delete voice "${name}"? This cannot be undone.`)) return;
  const res = await fetch(`/api/settings/voices/${name}`, { method: 'DELETE' });
  if (res.ok) {
    showToast(`Voice "${name}" deleted`);
    await loadSettings();
  }
}

// ─── Google ───────────────────────────────────────────────────────────────────

const GOOGLE_SERVICES = [
  { key: 'gmail',    icon: '✉',  cls: 'gmail',    label: 'Gmail',          desc: 'Send email' },
  { key: 'calendar', icon: '📅', cls: 'calendar', label: 'Calendar',       desc: 'Create and manage events' },
  { key: 'docs',     icon: '📄', cls: 'docs',     label: 'Google Docs',    desc: 'Create, read, and update documents' },
  { key: 'sheets',   icon: '📊', cls: 'sheets',   label: 'Google Sheets',  desc: 'Create, read, and update spreadsheets' },
  { key: 'drive',    icon: '💾', cls: 'drive',    label: 'Drive',          desc: 'File management for Docs and Sheets' },
];

function renderServiceRows(services = null) {
  const container = document.getElementById('google-service-rows');
  if (!container) return;
  container.innerHTML = GOOGLE_SERVICES.map(s => {
    let badgeClass = 'checking';
    let badgeText = 'Checking...';
    if (services !== null) {
      badgeClass = services[s.key] ? 'ok' : 'missing';
      badgeText  = services[s.key] ? 'Authorized' : 'Not authorized';
    }
    return `
      <div class="service-row">
        <div class="service-icon ${s.cls}">${s.icon}</div>
        <div style="flex:1">
          <div class="service-name">${s.label}</div>
          <div class="service-desc">${s.desc}</div>
        </div>
        <span class="service-badge ${badgeClass}" id="svc-badge-${s.key}">${badgeText}</span>
      </div>`;
  }).join('');
}

function renderGoogle(g = {}) {
  const status   = document.getElementById('google-status');
  const services = document.getElementById('google-services');
  const actions  = document.getElementById('google-actions');

  if (g.connected) {
    status.innerHTML = `<div class="connected-badge"><span>✓</span> Connected as ${g.email || g.name || 'Google account'}</div>`;
    services.style.display = 'block';
    renderServiceRows(null); // show "Checking..." state
    actions.innerHTML = `<button class="btn danger" onclick="disconnectGoogle()">Disconnect Google</button>`;
    validateGoogleServices(); // auto-validate on render
  } else {
    status.innerHTML = `<div class="disconnected-badge"><span>○</span> Not connected</div>`;
    services.style.display = 'none';
    actions.innerHTML = `
      <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:12px">
        Connect your Google account to enable Gmail, Calendar, Docs, and Sheets.<br>
        Requires <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in <code>.env</code>.
      </p>
      <a href="/auth/google" class="btn primary" style="display:inline-block;text-decoration:none">Connect Google Account</a>`;
  }
}

async function validateGoogleServices() {
  const btn = document.getElementById('google-validate-btn');
  if (btn) { btn.textContent = 'Checking...'; btn.disabled = true; }

  try {
    const res  = await fetch('/api/settings/google/validate');
    const data = await res.json();

    if (!data.connected) {
      renderServiceRows({});
    } else if (data.error && !data.services) {
      showToast('Validation error: ' + data.error, 'error');
      renderServiceRows({});
    } else {
      renderServiceRows(data.services || {});
      const allOk = Object.values(data.services || {}).every(Boolean);
      if (!allOk) showToast('Some services need re-authorization — disconnect and reconnect Google.', 'error');
    }
  } catch (err) {
    showToast('Validation failed: ' + err.message, 'error');
    renderServiceRows({});
  } finally {
    if (btn) { btn.textContent = 'Validate Access'; btn.disabled = false; }
  }
}

async function disconnectGoogle() {
  if (!confirm('Disconnect Google? This removes all Google access including email, calendar, docs, and sheets.')) return;
  await fetch('/auth/google/disconnect', { method: 'POST' });
  showToast('Google disconnected');
  await loadSettings();
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

function renderGitHub(g = {}) {
  const status = document.getElementById('github-status');
  const actions = document.getElementById('github-actions');

  if (g.connected) {
    status.innerHTML = `<div class="connected-badge"><span>✓</span> Connected as @${g.username}</div>`;
    actions.innerHTML = `
      <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:10px">
        Jennifer can now create repos, push files, and manage your GitHub projects.
      </p>
      <button class="btn danger" onclick="disconnectGitHub()">Disconnect GitHub</button>`;
  } else {
    status.innerHTML = `<div class="disconnected-badge"><span>○</span> Not connected</div>`;
    actions.innerHTML = `
      <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:12px">
        Connect GitHub so Jennifer can create repos, push code, and manage projects.<br>
        Requires <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> in <code>.env</code>.
      </p>
      <a href="/auth/github" class="btn primary" style="display:inline-block;text-decoration:none">Connect GitHub Account</a>`;
  }
}

async function disconnectGitHub() {
  if (!confirm('Disconnect GitHub?')) return;
  await fetch('/auth/github/disconnect', { method: 'POST' });
  showToast('GitHub disconnected');
  await loadSettings();
}
