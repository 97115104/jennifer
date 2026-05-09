'use strict';

class JenniferApp {
  constructor() {
    this.ws = null;
    this.recognition = null;
    this.recorder = null;
    this.audioContext = null;
    this.analyser = null;
    this.stream = null;

    this.state = 'idle';
    this.isRecording = false;
    this.isSpeaking = false;
    this.silenceStart = null;
    this.waveformRaf = null;

    this.SILENCE_THRESHOLD = 8;
    this.SILENCE_DURATION = 3000;
  }

  init() {
    this._bindUI();
    this._connectWS();
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────

  _connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}`;
    console.log(`[jennifer] Connecting WebSocket to ${url}`);
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      console.log('[jennifer] ✅ WebSocket connected');
      this._setStatus('Connected — click Start to begin');
    };
    this.ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type !== 'status') console.log(`[jennifer] ← ws:${msg.type}`, msg.type === 'audio' ? `(~${(msg.data?.length * 0.75 / 1024).toFixed(1)}KB)` : msg);
      this._onMessage(msg);
    };
    this.ws.onclose = e => {
      console.warn(`[jennifer] WebSocket closed (code=${e.code}) — reconnecting in 2s`);
      this._setStatus('Disconnected — reconnecting...');
      setTimeout(() => this._connectWS(), 2000);
    };
    this.ws.onerror = e => console.error('[jennifer] WebSocket error', e);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // ─── UI ──────────────────────────────────────────────────────────────────

  _bindUI() {
    document.getElementById('start-btn').addEventListener('click', () => this._start());
    document.getElementById('reset-btn').addEventListener('click', () => this._reset());
    document.getElementById('manual-btn').addEventListener('click', () => this._triggerRecord());
  }

  _setState(state) {
    this.state = state;
    document.body.setAttribute('data-state', state);
    const labels = {
      idle: 'Ready',
      listening: 'Listening for "Ok Jennifer"…',
      recording: 'Recording… (3s silence to send)',
      processing: 'Processing…',
      thinking: 'Thinking…',
      speaking: 'Speaking…',
    };
    this._setStatus(labels[state] || state);
  }

  _setStatus(text) {
    document.getElementById('status').textContent = text;
  }

  _addMessage(role, text) {
    const el = document.getElementById('transcript');
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = text;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  _addNote(text) {
    const el = document.getElementById('transcript');
    const div = document.createElement('div');
    div.className = 'message system-note';
    div.textContent = text;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  // ─── Startup ─────────────────────────────────────────────────────────────

  async _start() {
    console.log('[jennifer] Requesting microphone access...');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      console.log('[jennifer] ✅ Microphone granted');
    } catch (err) {
      console.error('[jennifer] ✗ Microphone denied:', err.message);
      alert('Microphone access denied: ' + err.message);
      return;
    }

    this._setupAudioContext();
    this._startWakeWord();
    this._startWaveform();

    document.getElementById('start-btn').style.display = 'none';
    const controls = document.getElementById('controls');
    controls.classList.add('visible');

    this._setState('listening');
  }

  // ─── Audio Context + Waveform ─────────────────────────────────────────────

  _setupAudioContext() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);
  }

  _startWaveform() {
    const canvas = document.getElementById('waveform');
    const ctx = canvas.getContext('2d');
    const buf = new Uint8Array(this.analyser.frequencyBinCount);

    const draw = () => {
      this.waveformRaf = requestAnimationFrame(draw);
      this.analyser.getByteTimeDomainData(buf);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = this.isRecording ? '#e05252' : '#4f8ef7';
      ctx.beginPath();

      const step = canvas.width / buf.length;
      for (let i = 0; i < buf.length; i++) {
        const y = (buf[i] / 255) * canvas.height;
        i === 0 ? ctx.moveTo(i * step, y) : ctx.lineTo(i * step, y);
      }
      ctx.stroke();
    };
    draw();
  }

  // ─── Wake Word Detection ──────────────────────────────────────────────────

  _startWakeWord() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      console.warn('[jennifer] Web Speech API not available — Chrome required for wake word detection');
      this._addNote('⚠ Wake word unavailable — use the Record button (Chrome required)');
      return;
    }

    console.log('[jennifer] Starting wake word detection (listening for "Jennifer")');
    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';
    this.recognition.maxAlternatives = 1;

    this.recognition.onresult = event => {
      if (this.isRecording || this.isSpeaking) return;
      const recent = Array.from(event.results)
        .slice(-4)
        .map(r => r[0].transcript.toLowerCase())
        .join(' ');
      if (recent.includes('jennifer')) {
        console.log(`[jennifer] Wake word detected in: "${recent}"`);
        this._onWakeWord();
      }
    };

    this.recognition.onend = () => {
      if (this.state === 'listening' && !this.isRecording) {
        console.log('[jennifer] Speech recognition restarting...');
        try { this.recognition.start(); } catch (e) {}
      }
    };

    this.recognition.onerror = e => {
      console.warn(`[jennifer] Speech recognition error: ${e.error}`);
      if (e.error === 'not-allowed') {
        this._addNote('Speech recognition blocked by browser.');
      }
    };

    try { this.recognition.start(); } catch (e) {}
  }

  _stopWakeWord() {
    try { this.recognition?.stop(); } catch (e) {}
  }

  // ─── Recording ───────────────────────────────────────────────────────────

  _onWakeWord() {
    if (this.isRecording || this.isSpeaking) return;
    console.log('[jennifer] Wake word detected');
    this._startRecording();
  }

  _triggerRecord() {
    if (this.isRecording || this.isSpeaking) return;
    if (!this.stream) { this._start(); return; }
    this._startRecording();
  }

  _startRecording() {
    this.isRecording = true;
    this.silenceStart = null;
    this._setState('recording');
    this._stopWakeWord();

    const mimeType = this._bestMime();
    console.log(`[jennifer] Recording started (mimeType=${mimeType || 'browser default'})`);
    const chunks = [];

    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    this.recorder.onstop = () => {
      const blob = new Blob(chunks, { type: this.recorder.mimeType || 'audio/webm' });
      console.log(`[jennifer] Recording stopped: ${chunks.length} chunks, ${(blob.size / 1024).toFixed(1)}KB (${blob.type})`);
      this._sendAudio(blob);
    };

    this.recorder.start(100);
    this._monitorSilence();
  }

  _bestMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  _monitorSilence() {
    if (!this.isRecording) return;

    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(buf);

    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);

    if (rms < this.SILENCE_THRESHOLD) {
      if (!this.silenceStart) this.silenceStart = Date.now();
      else if (Date.now() - this.silenceStart >= this.SILENCE_DURATION) {
        this._stopRecording();
        return;
      }
    } else {
      this.silenceStart = null;
    }

    requestAnimationFrame(() => this._monitorSilence());
  }

  _stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;
    this.recorder?.stop();
    this._setState('processing');
  }

  // ─── Audio send / receive ─────────────────────────────────────────────────

  async _sendAudio(blob) {
    console.log(`[jennifer] → Sending audio to server (${(blob.size / 1024).toFixed(1)}KB)...`);
    const buffer = await blob.arrayBuffer();
    const base64 = this._bufToB64(buffer);
    console.log(`[jennifer] → Base64 encoded: ${(base64.length / 1024).toFixed(1)}KB`);
    this._send({ type: 'audio', data: base64, mimeType: blob.type });
  }

  _bufToB64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async _playAudio(base64, mimeType) {
    return new Promise(resolve => {
      const bytes = atob(base64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: mimeType || 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      console.log(`[jennifer] Playing audio response: ${(blob.size / 1024).toFixed(1)}KB (${mimeType})`);
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); console.log('[jennifer] Audio playback finished'); resolve(); };
      audio.onerror = e => { console.error('[jennifer] Audio playback error:', e); URL.revokeObjectURL(url); resolve(); };
      audio.play().catch(e => { console.error('[jennifer] audio.play() failed:', e); resolve(); });
    });
  }

  // ─── WebSocket messages ───────────────────────────────────────────────────

  _onMessage(msg) {
    switch (msg.type) {
      case 'status':
        if (msg.message) this._setStatus(msg.message);
        if (msg.state && msg.state !== 'idle') this._setState(msg.state);
        break;

      case 'transcript':
        this._addMessage('user', msg.text);
        break;

      case 'response':
        this._addMessage('assistant', msg.text);
        break;

      case 'tool_call':
        this._addNote(`⚙ Running tool: ${msg.name}`);
        break;

      case 'audio':
        this._setState('speaking');
        this.isSpeaking = true;
        this._stopWakeWord();
        this._playAudio(msg.data, msg.mimeType).then(() => {
          this.isSpeaking = false;
          this._setState('listening');
          this._startWakeWord();
        });
        break;

      case 'error':
        this._addNote(`⚠ ${msg.message}`);
        this._setState('listening');
        this._startWakeWord();
        break;
    }
  }

  // ─── Reset ────────────────────────────────────────────────────────────────

  _reset() {
    this._send({ type: 'reset' });
    document.getElementById('transcript').innerHTML = '';
    this._addNote('Conversation cleared');
  }
}

const jennifer = new JenniferApp();
jennifer.init();
