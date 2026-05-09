'use strict';

// ─── Voice Activity Detector ──────────────────────────────────────────────────
//
// Real services (Siri, Google, Alexa) use trained VAD models that look at the
// 300–3400Hz speech frequency band and compare it to an adaptive noise floor.
// We replicate this in the browser without ML:
//   1. Only measure energy in the speech band (ignores HVAC, fans, etc.)
//   2. Adaptive noise floor: slowly drifts toward ambient level during silence
//   3. Speech = energy at least SNR_THRESHOLD × above the noise floor
//   4. Silence countdown only begins AFTER speech has been detected
//      (so an accidental wake-word trigger that produces no speech auto-cancels)
//
class SpeechVAD {
  constructor(analyser, sampleRate) {
    const binWidth = sampleRate / analyser.fftSize;
    this.lowBin  = Math.max(1, Math.round(300  / binWidth));   // ~300Hz
    this.highBin = Math.min(analyser.frequencyBinCount - 1, Math.round(3400 / binWidth)); // ~3400Hz
    this.analyser = analyser;
    this.buf = new Uint8Array(analyser.frequencyBinCount);

    this.noiseFloor = null;
    this.SNR_THRESHOLD = 2.2;   // speech must be 2.2× above noise floor
    this.ABS_THRESHOLD = 12;    // and above this absolute minimum energy
    this.NOISE_ADAPT   = 0.02;  // noise floor adaptation speed (0=never, 1=instant)
  }

  measure() {
    this.analyser.getByteFrequencyData(this.buf);
    let sum = 0;
    for (let i = this.lowBin; i < this.highBin; i++) sum += this.buf[i];
    const energy = sum / (this.highBin - this.lowBin);

    if (this.noiseFloor === null) this.noiseFloor = energy;

    const isSpeech = energy > this.ABS_THRESHOLD && energy > this.noiseFloor * this.SNR_THRESHOLD;

    // Only adapt noise floor during non-speech — don't let loud speech raise it
    if (!isSpeech) {
      this.noiseFloor += (energy - this.noiseFloor) * this.NOISE_ADAPT;
    }

    return { energy, isSpeech, noiseFloor: this.noiseFloor };
  }

  reset() { this.noiseFloor = null; }
}

// ─── Main App ─────────────────────────────────────────────────────────────────

class JenniferApp {
  constructor() {
    this.ws = null;
    this.recognition = null;
    this.recorder = null;
    this.audioContext = null;
    this.analyser = null;
    this.vad = null;
    this.stream = null;

    this.state = 'idle';
    this.isRecording = false;
    this.isSpeaking = false;

    // VAD state — reset each recording session
    this.hasSpeech = false;    // has any speech been detected this session?
    this.silenceStart = null;  // when silence began (after speech was detected)

    // How long silence must persist after speech ends before we stop.
    // 1500ms matches most voice assistants. Increase if you get cut off mid-sentence.
    this.SILENCE_DURATION = 1500;
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
      if (msg.type !== 'status') {
        console.log(`[jennifer] ← ws:${msg.type}`,
          msg.type === 'audio' ? `(~${(msg.data?.length * 0.75 / 1024).toFixed(1)}KB)` : msg);
      }
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
      idle:        'Ready',
      listening:   'Listening for "Ok Jennifer"…',
      recording:   'Listening…',
      processing:  'Processing…',
      thinking:    'Thinking…',
      speaking:    'Speaking…',
    };
    this._setStatus(labels[state] || state);
  }

  _setStatus(text) {
    document.getElementById('status').textContent = text;
  }

  _addMessage(role, text) {
    const container = document.getElementById('transcript-container');
    const el = document.getElementById('transcript');
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = text;
    el.appendChild(div);
    // Scroll the container (the element with overflow:auto), not the inner div
    container.scrollTop = container.scrollHeight;
  }

  _addNote(text) {
    const container = document.getElementById('transcript-container');
    const el = document.getElementById('transcript');
    const div = document.createElement('div');
    div.className = 'message system-note';
    div.textContent = text;
    el.appendChild(div);
    container.scrollTop = container.scrollHeight;
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
    document.getElementById('controls').classList.add('visible');

    this._setState('listening');
  }

  // ─── Audio Context + Waveform ─────────────────────────────────────────────

  _setupAudioContext() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;        // 1024 bins — more frequency resolution for VAD
    this.analyser.smoothingTimeConstant = 0.3;
    source.connect(this.analyser);

    this.vad = new SpeechVAD(this.analyser, this.audioContext.sampleRate);
    console.log(`[jennifer] AudioContext: ${this.audioContext.sampleRate}Hz, VAD speech bins: ${this.vad.lowBin}–${this.vad.highBin}`);
  }

  _startWaveform() {
    const canvas = document.getElementById('waveform');
    const ctx = canvas.getContext('2d');
    const buf = new Uint8Array(this.analyser.fftSize);

    const draw = () => {
      requestAnimationFrame(draw);
      this.analyser.getByteTimeDomainData(buf);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = this.isRecording
        ? (this.hasSpeech ? '#52c47a' : '#e05252')  // green=speech detected, red=waiting
        : '#4f8ef7';
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
      console.warn('[jennifer] Web Speech API not available — Chrome required for wake word');
      this._addNote('⚠ Wake word unavailable — use the Record button (Chrome required)');
      return;
    }

    console.log('[jennifer] Wake word detection active (listening for "Jennifer")');
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
        console.log(`[jennifer] Wake word in: "${recent}"`);
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
      if (e.error === 'not-allowed') this._addNote('Speech recognition blocked by browser.');
    };

    try { this.recognition.start(); } catch (e) {}
  }

  _stopWakeWord() {
    try { this.recognition?.stop(); } catch (e) {}
  }

  // ─── Recording ───────────────────────────────────────────────────────────

  _onWakeWord() {
    if (this.isRecording || this.isSpeaking) return;
    this._startRecording();
  }

  _triggerRecord() {
    if (this.isRecording || this.isSpeaking) return;
    if (!this.stream) { this._start(); return; }
    this._startRecording();
  }

  _startRecording() {
    this.isRecording = true;
    this.hasSpeech = false;
    this.silenceStart = null;
    this.vad.reset();
    this._setState('recording');
    this._stopWakeWord();

    const mimeType = this._bestMime();
    console.log(`[jennifer] Recording started (mimeType=${mimeType || 'default'}, VAD active)`);
    const chunks = [];

    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    this.recorder.onstop = () => {
      const blob = new Blob(chunks, { type: this.recorder.mimeType || 'audio/webm' });
      console.log(`[jennifer] Recording stopped: ${chunks.length} chunks, ${(blob.size / 1024).toFixed(1)}KB`);
      if (this.hasSpeech) {
        this._sendAudio(blob);
      } else {
        console.log('[jennifer] No speech detected — discarding and going back to listening');
        this._setState('listening');
        this._startWakeWord();
      }
    };

    this.recorder.start(100);
    this._runVAD();
  }

  _bestMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  _runVAD() {
    if (!this.isRecording) return;

    const { isSpeech, energy, noiseFloor } = this.vad.measure();
    const now = Date.now();

    if (isSpeech) {
      // Speech detected — reset silence timer
      if (!this.hasSpeech) {
        console.log(`[jennifer] Speech onset detected (energy=${energy.toFixed(1)}, floor=${noiseFloor.toFixed(1)})`);
      }
      this.hasSpeech = true;
      this.silenceStart = null;
      this._setStatus('Recording…');

    } else if (this.hasSpeech) {
      // Speech ended — count down to stop
      if (!this.silenceStart) {
        this.silenceStart = now;
        console.log(`[jennifer] Speech offset — silence countdown started`);
      }
      const elapsed = now - this.silenceStart;
      const remaining = Math.ceil((this.SILENCE_DURATION - elapsed) / 1000);
      this._setStatus(remaining > 0 ? `Done? Sending in ${remaining}s…` : 'Sending…');

      if (elapsed >= this.SILENCE_DURATION) {
        this._stopRecording();
        return;
      }

    } else {
      // No speech yet — show pulsing prompt
      this._setStatus('Speak now…');
    }

    requestAnimationFrame(() => this._runVAD());
  }

  _stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;
    this.recorder?.stop();
    if (this.hasSpeech) this._setState('processing');
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
      console.log(`[jennifer] Playing audio: ${(blob.size / 1024).toFixed(1)}KB`);
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); console.log('[jennifer] Playback done'); resolve(); };
      audio.onerror = e => { console.error('[jennifer] Playback error:', e); URL.revokeObjectURL(url); resolve(); };
      audio.play().catch(e => { console.error('[jennifer] play() failed:', e); resolve(); });
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
