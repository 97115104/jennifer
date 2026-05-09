---
title: Voice Cloning
layout: default
nav_order: 5
---

# Voice Cloning
{: .no_toc }

Jennifer can speak in a cloned voice using the embedded **Coqui XTTS v2** service. No ElevenLabs account or API key is required.

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
     │  POST /api/tts { text, voice }
     ▼
Embedded Flask server: tts/server.py (localhost:5123)
     │  XTTS v2 model (~1.8GB)
     ▼
MP3 audio in cloned voice
     │
     ▼
Browser plays it
```

The embedded server runs locally, generates audio using the XTTS v2 model, and Jennifer streams it back to you.

---

## Setup

### 1. Set up the local TTS environment

```bash
./scripts/install.sh
```

When prompted, opt into voice cloning. This creates `tts/.venv`, installs the Python dependencies, and can optionally pre-download the XTTS v2 model.

### 2. Record a voice sample in Jennifer

You need 10–30 seconds of clean audio in the voice you want to clone.

- Start Jennifer with `./scripts/deploy-locally.sh`
- Open [http://localhost:3000/settings](http://localhost:3000/settings)
- Use the Voice Cloning tab to record and activate a voice sample

For best results:
- Record in a quiet environment
- Speak naturally, not reading a list
- Aim for 20–30 seconds of clean speech

### 3. Configure Jennifer

Add to `.env`:

```bash
TTS_PROVIDER=coqui
COQUI_URL=http://localhost:5123
# Optional if you want to bypass the Settings page active voice:
COQUI_SPEAKER_WAV=/Users/you/path/to/voice_sample.wav
```

### 4. Start Jennifer

```bash
./scripts/deploy-locally.sh
```

The deploy script starts `tts/server.py` automatically, waits for XTTS to load, then starts Jennifer. Jennifer logs `[boot] Using Coqui XTTS v2 voice` when the integration is active.

---

## Fallback Behavior

If the Coqui server is unreachable at startup, Jennifer automatically falls back to system TTS (macOS `say`) — you won't get an error, just the default voice.

To check which TTS is active:

```bash
curl http://localhost:3000/api/health
# look for tts.activeProvider == "coqui"
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
- Make sure `.env` says exactly `TTS_PROVIDER=coqui`
- Re-run `./scripts/install.sh` and opt into voice cloning if `tts/.venv` is missing
- Check the embedded service: `curl http://localhost:5123/api/health`
- Check logs: `tail -f tts/server.log`

**Voice sounds robotic or wrong**
- Use a longer, cleaner voice sample (30+ seconds)
- Ensure sample and output are in the same language
- Avoid background noise in the sample

**First synthesis is slow**
- XTTS v2 loads the model at startup.
- CPU synthesis can still take several seconds per short response.
