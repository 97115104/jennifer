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

async function loadSettings() {
  const res = await fetch('/api/settings');
  settings = await res.json();
  renderTTSStatus(settings.tts);
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
const recIndicator = document.getElementById('rec-indicator');
const recTimer = document.getElementById('rec-timer');
const promptsBox = document.getElementById('reading-prompts');

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

async function uploadVoice(name) {
  const blob = new Blob(recordChunks, { type: recorder?.mimeType || 'audio/webm' });
  console.log(`[settings] Uploading voice "${name}": ${(blob.size / 1024).toFixed(0)}KB`);
  showToast('Uploading and converting voice sample…');

  const form = new FormData();
  form.append('audio', blob, 'sample.webm');
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
    await loadSettings();
  } catch (err) {
    console.error('[settings] Upload failed:', err);
    showToast('Upload failed: ' + err.message, 'error');
  }
}

function renderTTSStatus(tts = {}) {
  const el = document.getElementById('tts-status');
  if (!el) return;

  const isSystem = !tts.activeVoice || true; // check env via health
  fetch('/api/health').then(r => r.json()).then(data => {
    // We can't easily tell TTS provider from health, so check activeVoice
    if (tts.activeVoice) {
      const voiceName = tts.activeVoice.split('/').pop().replace('.wav', '');
      el.innerHTML = `
        <div class="info-banner warning">
          <strong>Active voice: "${voiceName}"</strong><br>
          To hear this voice, set <code>TTS_PROVIDER=coqui</code> in your <code>.env</code> and restart the server.
          Your myvoice server must also be running: <code>cd ~/myvoice && python server.py</code>
        </div>`;
    } else {
      el.innerHTML = `<div class="info-banner">Using system TTS (macOS <code>say</code>). Record a voice sample below to enable voice cloning.</div>`;
    }
  }).catch(() => {});
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
    showToast(name ? `"${name}" set as active voice — restart server to apply` : 'Voice deactivated', 'success');
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

function renderGoogle(g = {}) {
  const status = document.getElementById('google-status');
  const actions = document.getElementById('google-actions');

  if (g.connected) {
    status.innerHTML = `<div class="connected-badge"><span>✓</span> Connected as ${g.email || g.name}</div>`;
    actions.innerHTML = `
      <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:10px">
        Jennifer will now send emails using Gmail on your behalf.
      </p>
      <button class="btn danger" onclick="disconnectGoogle()">Disconnect Google</button>`;
  } else {
    status.innerHTML = `<div class="disconnected-badge"><span>○</span> Not connected</div>`;
    actions.innerHTML = `
      <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:12px">
        Connect your Google account so Jennifer can send emails via Gmail.<br>
        Requires <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in <code>.env</code>.
      </p>
      <a href="/auth/google" class="btn primary" style="display:inline-block;text-decoration:none">Connect Google Account</a>`;
  }
}

async function disconnectGoogle() {
  if (!confirm('Disconnect Google?')) return;
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
