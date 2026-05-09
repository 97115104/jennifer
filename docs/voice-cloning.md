---
title: Voice Cloning
layout: default
nav_order: 5
---

# Voice Cloning
{: .no_toc }

Jennifer can speak in a cloned voice using **Coqui XTTS v2** — the same technology used in [myvoice](https://github.com/97115104/myvoice). No ElevenLabs account or API key required.

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## How It Works

```
Text response
     │
     ▼
CoquiTTSProvider
     │  POST /tts { text, speaker_wav }
     ▼
myvoice Flask server (localhost:5123)
     │  XTTS v2 model (~1.8GB)
     ▼
WAV audio in cloned voice
     │
     ▼
Browser plays it
```

The myvoice server runs locally, generates audio using the XTTS v2 model, and Jennifer streams it back to you — fully offline, no external API calls.

---

## Setup

### 1. Clone and set up myvoice

```bash
git clone https://github.com/97115104/myvoice ~/myvoice
cd ~/myvoice
bash setup.sh   # installs Python deps and downloads XTTS v2 model (~1.8GB)
```

### 2. Record a voice sample

You need 10–30 seconds of clean audio in the voice you want to clone.

- Open [http://localhost:5123](http://localhost:5123) in a browser
- Use the built-in recorder to capture your voice
- Save the file — note its path (e.g., `~/myvoice/samples/steve.wav`)

For best results:
- Record in a quiet environment
- Speak naturally, not reading a list
- Use 16kHz or 44.1kHz WAV

### 3. Configure Jennifer

Add to `.env`:

```bash
TTS_PROVIDER=coqui
COQUI_URL=http://localhost:5123
COQUI_SPEAKER_WAV=/Users/you/myvoice/samples/steve.wav
```

### 4. Start myvoice, then start Jennifer

```bash
# Terminal 1 — voice server
cd ~/myvoice && python server.py

# Terminal 2 — Jennifer
./scripts/deploy-locally.sh
```

Jennifer will log `[boot] Using Coqui XTTS v2 voice` on startup.

---

## Fallback Behavior

If the Coqui server is unreachable at startup, Jennifer automatically falls back to system TTS (macOS `say`) — you won't get an error, just the default voice.

To check which TTS is active:

```bash
curl http://localhost:3000/api/health
# look for "tts" field in response
```

---

## Supported Languages

XTTS v2 supports 16+ languages. Jennifer defaults to `en` (English). To change:

Edit `src/tts/CoquiTTSProvider.js`:

```js
const payload = { text, language: 'fr' };  // French
```

---

## Troubleshooting

**"Coqui server unavailable"**
- Start the myvoice server first: `cd ~/myvoice && python server.py`
- Check it's running: `curl http://localhost:5123/health`

**Voice sounds robotic or wrong**
- Use a longer, cleaner voice sample (30+ seconds)
- Ensure sample and output are in the same language
- Avoid background noise in the sample

**First synthesis is slow**
- XTTS v2 loads the model on first request (~10s on M-series Mac)
- Subsequent calls are fast (2–5s)
