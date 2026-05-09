'use strict';

// Encode a Float32Array of 16kHz mono audio as a WAV ArrayBuffer.
// vad.utils.encodeWAV exists in some bundle versions; we keep our own copy
// so behaviour is always consistent regardless of bundle version.
function encodeWAV(samples) {
  const SR = 16000;
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function write(off, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  }

  write(0,  'RIFF');
  view.setUint32( 4, 36 + samples.length * 2, true);
  write(8,  'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);       // PCM chunk size
  view.setUint16(20,  1, true);       // PCM format
  view.setUint16(22,  1, true);       // mono
  view.setUint32(24, SR, true);
  view.setUint32(28, SR * 2, true);   // byte rate
  view.setUint16(32,  2, true);       // block align
  view.setUint16(34, 16, true);       // bit depth
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

// ─── Frequency-domain VAD fallback ───────────────────────────────────────────
// Used when Silero/ONNX VAD fails (e.g. SES lockdown from MetaMask extension).
// Monitors RMS energy via AnalyserNode; starts recording on speech, stops after silence.

class SpeechVAD {
  constructor(analyser, stream, onSpeech) {
    this.analyser = analyser;
    this.stream = stream;
    this.onSpeech = onSpeech;
    this.running = false;
    this.recording = false;
    this.recorder = null;
    this.chunks = [];
    this.silenceTimer = null;
    this.noiseFloor = 0.003;
    this.speechStart = 0;
    this.SPEECH_THRESHOLD = 0.018;
    this.SILENCE_MS = 1400;
    this.MIN_SPEECH_MS = 300;
  }

  start() {
    this.running = true;
    this._poll();
  }

  stop() {
    this.running = false;
    clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }

  _rms() {
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const s of buf) sum += s * s;
    return Math.sqrt(sum / buf.length);
  }

  _poll() {
    if (!this.running) return;
    const level = this._rms();

    // Slow-adapt noise floor while silent
    if (!this.recording) this.noiseFloor = this.noiseFloor * 0.97 + level * 0.03;

    const threshold = this.noiseFloor + this.SPEECH_THRESHOLD;

    if (!this.recording && level > threshold) {
      this._startRec();
    } else if (this.recording) {
      if (level < threshold * 0.55) {
        if (!this.silenceTimer) {
          this.silenceTimer = setTimeout(() => this._stopRec(), this.SILENCE_MS);
        }
      } else {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
    }

    setTimeout(() => this._poll(), 30);
  }

  _startRec() {
    this.chunks = [];
    this.recording = true;
    this.speechStart = Date.now();
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(t => MediaRecorder.isTypeSupported(t)) || '';
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = e => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.recorder.onstop = () => {
      if (Date.now() - this.speechStart >= this.MIN_SPEECH_MS) {
        const blob = new Blob(this.chunks, { type: this.recorder.mimeType || 'audio/webm' });
        this.onSpeech(blob);
      }
    };
    this.recorder.start(100);
    console.log('[jennifer] SpeechVAD: recording started');
  }

  _stopRec() {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.recording = false;
    this.running = false;
    if (this.recorder?.state === 'recording') this.recorder.stop();
    console.log('[jennifer] SpeechVAD: recording stopped');
  }
}

// ─── Main App ─────────────────────────────────────────────────────────────────

class JenniferApp {
  constructor() {
    this.ws = null;
    this.micVAD = null;
    this.speechVAD = null;  // frequency-domain fallback
    this.audioContext = null;
    this.analyser = null;
    this.stream = null;

    this.state = 'idle';
    this.isListeningForSpeech = false;
    this.isSpeaking = false;
    this.recognition = null;
    this.assistantName = 'Jennifer';
    this.wakeWord = 'jennifer';
    this._planEl = null;        // current plan block DOM element
    this._planStepEls = [];     // per-step DOM elements
    this.toolActivity = null;
    this.ttsProgress = {
      visible: false,
      startedAt: 0,
      progress: 0,
      timer: null,
    };
  }

  async init() {
    await this._loadAppSettings();
    window.addEventListener('pageshow', () => this._loadAppSettings());
    this._bindUI();
    this._connectWS();
  }

  async _loadAppSettings() {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      this._setAssistantName(data.app?.name || 'Jennifer');
    } catch (err) {
      console.warn('[jennifer] Settings load failed:', err.message);
      this._setAssistantName('Jennifer');
    }
  }

  _setAssistantName(name) {
    const cleaned = String(name || 'Jennifer').trim() || 'Jennifer';
    this.assistantName = cleaned;
    this.wakeWord = cleaned.toLowerCase();

    document.title = cleaned;
    const title = document.getElementById('assistant-title');
    if (title) title.textContent = cleaned;

    const orbLetter = document.getElementById('orb-letter');
    if (orbLetter) orbLetter.textContent = cleaned.slice(0, 1).toUpperCase();

    const wakePhrase = document.getElementById('wake-phrase');
    if (wakePhrase) wakePhrase.textContent = `"Ok ${cleaned}"`;
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
    document.getElementById('manual-btn').addEventListener('click', () => this._triggerListen());
  }

  _setState(state) {
    this.state = state;
    document.body.setAttribute('data-state', state);
    const labels = {
      idle:        'Ready',
      listening:   `Listening for "Ok ${this.assistantName}"…`,
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

  _resetToolActivity() {
    this.toolActivity = null;
  }

  _toolLabel(name) {
    const labels = {
      fetch_url: 'Searching internet',
      execute_shell: 'Running shell command',
      read_file: 'Reading file',
      write_file: 'Writing file',
      send_email: 'Sending email',
      github: 'Using GitHub',
    };
    return labels[name] || `Running ${name || 'tool'}`;
  }

  _showToolCall(name) {
    const container = document.getElementById('transcript-container');
    const el = document.getElementById('transcript');
    const label = this._toolLabel(name);

    if (!this.toolActivity?.el) {
      const div = document.createElement('div');
      div.className = 'message system-note tool-activity';
      el.appendChild(div);
      this.toolActivity = {
        el: div,
        count: 0,
        label,
      };
    }

    this.toolActivity.count += 1;
    if (this.toolActivity.label !== label) {
      this.toolActivity.label = 'Running tools';
    }

    const suffix = this.toolActivity.count === 1 ? 'time' : 'times';
    this.toolActivity.el.textContent = `${this.toolActivity.label} ${this.toolActivity.count} ${suffix}`;
    container.scrollTop = container.scrollHeight;
  }

  _showTTSProgress(message = 'Generating cloned speech...', progress = 8) {
    const panel = document.getElementById('tts-progress');
    const label = document.getElementById('tts-progress-label');
    const percent = document.getElementById('tts-progress-percent');
    const fill = document.getElementById('tts-progress-fill');
    if (!panel || !label || !percent || !fill) return;

    this.ttsProgress.visible = true;
    this.ttsProgress.startedAt = Date.now();
    this.ttsProgress.progress = Math.max(0, Math.min(100, Number(progress) || 0));

    panel.classList.remove('hidden', 'complete', 'error');
    label.textContent = `${message} 0s`;
    percent.textContent = `${Math.round(this.ttsProgress.progress)}%`;
    fill.style.width = `${this.ttsProgress.progress}%`;

    clearInterval(this.ttsProgress.timer);
    this.ttsProgress.timer = setInterval(() => {
      if (!this.ttsProgress.visible) return;
      const elapsed = Math.floor((Date.now() - this.ttsProgress.startedAt) / 1000);
      this.ttsProgress.progress = Math.min(92, this.ttsProgress.progress + (elapsed < 8 ? 3 : 1));
      label.textContent = `${message} ${elapsed}s`;
      percent.textContent = `${Math.round(this.ttsProgress.progress)}%`;
      fill.style.width = `${this.ttsProgress.progress}%`;
    }, 1000);
  }

  _completeTTSProgress(message = 'Cloned speech ready') {
    const panel = document.getElementById('tts-progress');
    const label = document.getElementById('tts-progress-label');
    const percent = document.getElementById('tts-progress-percent');
    const fill = document.getElementById('tts-progress-fill');
    if (!panel || !label || !percent || !fill) return;

    clearInterval(this.ttsProgress.timer);
    this.ttsProgress.timer = null;
    this.ttsProgress.visible = false;
    this.ttsProgress.progress = 0;
    panel.classList.add('complete');
    label.textContent = message;
    percent.textContent = '100%';
    fill.style.width = '100%';
  }

  _hideTTSProgress(delay = 0) {
    clearInterval(this.ttsProgress.timer);
    this.ttsProgress.timer = null;
    this.ttsProgress.visible = false;

    const panel = document.getElementById('tts-progress');
    if (!panel) return;
    setTimeout(() => {
      panel.classList.add('hidden');
      panel.classList.remove('complete', 'error');
    }, delay);
  }

  _failTTSProgress(message = 'Speech generation failed') {
    const panel = document.getElementById('tts-progress');
    const label = document.getElementById('tts-progress-label');
    const percent = document.getElementById('tts-progress-percent');
    const fill = document.getElementById('tts-progress-fill');
    if (!panel || !label || !percent || !fill) return;

    clearInterval(this.ttsProgress.timer);
    this.ttsProgress.timer = null;
    this.ttsProgress.visible = false;
    panel.classList.remove('hidden', 'complete');
    panel.classList.add('error');
    label.textContent = message;
    percent.textContent = '';
    fill.style.width = '100%';
  }

  // ─── Plan block UI ────────────────────────────────────────────────────────

  _showPlanStart(total, tasks) {
    const el = document.getElementById('transcript');
    const container = document.getElementById('transcript-container');

    const block = document.createElement('div');
    block.className = 'plan-block';
    block.innerHTML = `<div class="plan-header">📋 Plan · ${total} steps</div><div class="plan-steps"></div>`;

    const stepsEl = block.querySelector('.plan-steps');
    this._planStepEls = (tasks || []).map((desc, i) => {
      const step = document.createElement('div');
      step.className = 'plan-step pending';
      step.innerHTML = `<div class="step-icon"></div><div class="step-body"><div class="step-desc">${i + 1}. ${desc}</div></div>`;
      stepsEl.appendChild(step);
      return step;
    });

    el.appendChild(block);
    this._planEl = block;
    container.scrollTop = container.scrollHeight;
  }

  _activatePlanStep(stepNum) {
    const el = this._planStepEls[stepNum - 1];
    if (el) el.className = 'plan-step active';
    document.getElementById('transcript-container').scrollTop = 9999;
  }

  _completePlanStep(stepNum, result) {
    const el = this._planStepEls[stepNum - 1];
    if (!el) return;
    el.className = 'plan-step done';
    if (result) {
      const body = el.querySelector('.step-body');
      const r = document.createElement('div');
      r.className = 'step-result';
      r.textContent = result.slice(0, 120) + (result.length > 120 ? '…' : '');
      body.appendChild(r);
    }
    document.getElementById('transcript-container').scrollTop = 9999;
  }

  _finishPlan() {
    if (this._planEl) {
      this._planEl.querySelector('.plan-header').textContent = '✅ Plan complete';
    }
    this._planEl = null;
    this._planStepEls = [];
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
    this._startWaveform();

    // Init MicVAD (loads ~1.8MB ONNX model once)
    await this._initVAD();

    this._startWakeWord();

    document.getElementById('start-btn').style.display = 'none';
    document.getElementById('controls').classList.add('visible');
    this._setState('listening');
  }

  // ─── Audio Context + Waveform ─────────────────────────────────────────────

  _setupAudioContext() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.3;
    source.connect(this.analyser);
    console.log(`[jennifer] AudioContext: ${this.audioContext.sampleRate}Hz`);
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
      ctx.strokeStyle = this.isListeningForSpeech
        ? (this.state === 'recording' ? '#52c47a' : '#e05252')
        : '#4f8ef7';
      ctx.beginPath();
      const step = canvas.width / buf.length;
      for (let i = 0; i < buf.length; i++) {
        const y = (buf[i] / 255) * canvas.height;
        i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * step, y);
      }
      ctx.stroke();
    };
    draw();
  }

  // ─── Silero VAD ───────────────────────────────────────────────────────────
  // Uses @ricky0123/vad-web ML model (ONNX, ~1.8MB).
  // MicVAD.new() loads the model once; we call start()/pause() per utterance.

  async _initVAD() {
    if (!window.vad) {
      console.warn('[jennifer] vad bundle not loaded — falling back to manual record button only');
      this._addNote('⚠ VAD model unavailable — use Record button to speak');
      return;
    }

    console.log('[jennifer] Initialising Silero VAD...');
    try {
      this.micVAD = await window.vad.MicVAD.new({
        stream: this.stream,
        // All VAD model, worklet, and ONNX WASM assets are served locally at /vad/.
        baseAssetPath: '/vad/',
        onnxWASMBasePath: '/vad/',
        // ~1.6s of silence before onSpeechEnd fires (17 frames × 96ms)
        redemptionFrames: 17,
        // Must detect at least 3 speech frames (~290ms) to count as speech
        minSpeechFrames: 3,
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,

        onSpeechStart: () => {
          if (!this.isListeningForSpeech) return;
          console.log('[jennifer] VAD: speech start');
          this._setState('recording');
        },

        onSpeechEnd: async (audio) => {
          // audio is Float32Array @ 16kHz — encode to WAV and send
          console.log(`[jennifer] VAD: speech end (${audio.length} samples, ${(audio.length / 16000).toFixed(1)}s)`);
          this.isListeningForSpeech = false;
          this.micVAD.pause();
          this._setState('processing');

          const wavBuffer = encodeWAV(audio);
          const blob = new Blob([wavBuffer], { type: 'audio/wav' });
          console.log(`[jennifer] → Sending WAV: ${(blob.size / 1024).toFixed(1)}KB`);
          await this._sendAudio(blob);
        },

        onVADMisfire: () => {
          // Too short / too quiet — go back to listening
          console.log('[jennifer] VAD: misfire (too short)');
          this._setState('listening');
          this._startWakeWord();
        },
      });
      console.log('[jennifer] ✅ Silero VAD ready');
    } catch (err) {
      console.error('[jennifer] VAD init failed:', err.message);
      this._addNote('⚠ VAD failed to load — use Record button');
    }
  }

  // ─── Wake Word Detection ──────────────────────────────────────────────────

  _startWakeWord() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      console.warn('[jennifer] Web Speech API not available — Chrome required for wake word');
      this._addNote('⚠ Wake word unavailable — use the Record button (Chrome required)');
      return;
    }

    if (this.recognition) {
      try { this.recognition.stop(); } catch {}
    }

    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = event => {
      if (this.isListeningForSpeech || this.isSpeaking) return;
      const recent = Array.from(event.results)
        .slice(-4)
        .map(r => r[0].transcript.toLowerCase())
        .join(' ');
      if (recent.includes(this.wakeWord)) {
        console.log(`[jennifer] Wake word detected in: "${recent}"`);
        this._onWakeWord();
      }
    };

    this.recognition.onend = () => {
      if (this.state === 'listening' && !this.isListeningForSpeech) {
        try { this.recognition.start(); } catch {}
      }
    };

    this.recognition.onerror = e => {
      console.warn(`[jennifer] Speech recognition error: ${e.error}`);
      if (e.error === 'not-allowed') this._addNote('Speech recognition blocked by browser.');
    };

    try { this.recognition.start(); } catch {}
    console.log(`[jennifer] Wake word detection active (listening for "${this.assistantName}")`);
  }

  _stopWakeWord() {
    try { this.recognition?.stop(); } catch {}
  }

  // ─── Activate listening ───────────────────────────────────────────────────

  _onWakeWord() {
    if (this.isListeningForSpeech || this.isSpeaking) return;
    this._activateListen();
  }

  _triggerListen() {
    if (this.isListeningForSpeech || this.isSpeaking) return;
    if (!this.stream) { this._start(); return; }
    this._activateListen();
  }

  _activateListen() {
    this._stopWakeWord();
    this.isListeningForSpeech = true;
    this._setState('recording');
    this._setStatus('Speak now…');

    if (this.micVAD) {
      console.log('[jennifer] MicVAD starting');
      this.micVAD.start();
    } else if (this.analyser) {
      // Silero unavailable (e.g. SES lockdown from browser extension) — use frequency-domain VAD
      console.log('[jennifer] Using frequency-domain VAD fallback');
      this.speechVAD = new SpeechVAD(this.analyser, this.stream, async (blob) => {
        this.isListeningForSpeech = false;
        this._setState('processing');
        console.log(`[jennifer] SpeechVAD → ${(blob.size / 1024).toFixed(1)}KB`);
        await this._sendAudio(blob);
      });
      this.speechVAD.start();
    } else {
      // No audio context yet (shouldn't happen after _start()) — last resort
      console.warn('[jennifer] No VAD available — recording for 8s max');
      this._fallbackRecord();
    }
  }

  // ─── Fallback (no VAD): plain MediaRecorder with 8s max ──────────────────

  _fallbackRecord() {
    const mimeType = (() => {
      const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      return c.find(t => MediaRecorder.isTypeSupported(t)) || '';
    })();

    const chunks = [];
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      this.isListeningForSpeech = false;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      this._setState('processing');
      await this._sendAudio(blob);
    };
    recorder.start(100);
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 8000);
  }

  // ─── Audio send / receive ─────────────────────────────────────────────────

  async _sendAudio(blob) {
    this._resetToolActivity();
    this._hideTTSProgress();
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const base64 = btoa(binary);
    console.log(`[jennifer] → Sending audio: ${(base64.length * 0.75 / 1024).toFixed(1)}KB (${blob.type})`);
    this._send({ type: 'audio', data: base64, mimeType: blob.type });
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
        if (msg.state && msg.state !== 'idle') this._setState(msg.state);
        if (msg.message) this._setStatus(msg.message);
        break;

      case 'transcript':
        this._resetToolActivity();
        this._addMessage('user', msg.text);
        break;

      case 'response':
        this._addMessage('assistant', msg.text);
        break;

      case 'tool_call':
        // Don't show plan_and_execute as a generic tool call — plan_start handles that
        if (msg.name !== 'plan_and_execute') this._showToolCall(msg.name);
        break;

      case 'plan_start':
        this._showPlanStart(msg.total, msg.tasks);
        break;

      case 'plan_step':
        this._activatePlanStep(msg.step);
        this._showToolCall(msg.tool_hint || `step ${msg.step}/${msg.total}`);
        break;

      case 'plan_step_done':
        this._completePlanStep(msg.step, msg.result);
        break;

      case 'plan_complete':
        this._finishPlan();
        break;

      case 'tts_progress':
        if (msg.provider !== 'coqui') break;
        if (msg.phase === 'start') {
          this.isSpeaking = true;
          this._stopWakeWord();
          this._showTTSProgress(msg.message, msg.progress);
        } else if (msg.phase === 'ready') {
          this._completeTTSProgress(msg.message);
        } else if (msg.phase === 'error') {
          this._failTTSProgress(msg.message);
        }
        break;

      case 'audio':
        this._setState('speaking');
        this.isSpeaking = true;
        this._stopWakeWord();
        this._completeTTSProgress('Playing cloned speech');
        this._playAudio(msg.data, msg.mimeType).then(() => {
          this._hideTTSProgress(400);
          this.isSpeaking = false;
          this._setState('listening');
          this._startWakeWord();
        });
        break;

      case 'error':
        this._addNote(`⚠ ${msg.message}`);
        this._failTTSProgress(msg.message);
        this._hideTTSProgress(2400);
        this.isListeningForSpeech = false;
        this.isSpeaking = false;
        this._setState('listening');
        this._startWakeWord();
        break;
    }
  }

  // ─── Reset ────────────────────────────────────────────────────────────────

  _reset() {
    this._send({ type: 'reset' });
    document.getElementById('transcript').innerHTML = '';
    this._resetToolActivity();
    this._hideTTSProgress();
    this._addNote('Conversation cleared');
  }
}

const jennifer = new JenniferApp();
jennifer.init();
