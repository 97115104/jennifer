---
title: Getting Started
layout: default
nav_order: 2
---

# Getting Started
{: .no_toc }

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 22.5+ | [nodejs.org](https://nodejs.org) — auto-installed on Arch/Debian by `install.sh` |
| ffmpeg | any | Auto-installed by `install.sh` |
| espeak-ng | any | Auto-installed by `install.sh` on Linux (system TTS) |
| Chrome | any | Required for wake word (Web Speech API) |
| 429 API key | — | Get at [429inference.com](https://429inference.com) |

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/97115104/jennifer.git
cd jennifer
```

### 2. Run the installer

```bash
./scripts/install.sh
```

This will:
- Check for Node.js 22.5+ and ffmpeg (auto-installs both on Arch and Debian/Ubuntu)
- Install `espeak-ng` on Linux for system TTS
- Run `npm install`
- Create a `.env` template
- Optionally pre-download the Whisper model (~150MB)

### 3. Configure your API key

Edit `.env`:

```bash
429-API-KEY=your_key_here
```

### 4. Start Jennifer

```bash
./scripts/deploy-locally.sh
```

This starts the server and opens Chrome automatically. Click **Start Listening**, then say "Ok Jennifer".

---

## First Run Notes

- **Whisper model downloads on first query** (~150MB for `base.en`). Subsequent queries are instant.
- The model is a reasoning model — it thinks before responding, which takes 2–5 seconds.
- Web Speech API requires Chrome. Safari and Firefox do not support continuous recognition.

---

## Configuration

All configuration is in `.env`:

```bash
# Required
429-API-KEY=your_key_here

# TTS provider:
#   system — built-in (macOS: say / Linux: espeak-ng — no extra setup)
#   429    — 429 Inference voice using a saved voice source
TTS_PROVIDER=system

# Optional 429 Inference voice key. If omitted, Jennifer can reuse 429-API-KEY.
# 429-VOICE-API-KEY=your_voice_key_here

# Email tool (optional)
# SMTP_HOST=smtp.gmail.com
# SMTP_USER=you@gmail.com
# SMTP_PASS=app_password
# SMTP_FROM=you@gmail.com

# Port (default: 3000)
# PORT=3000
```

### Whisper model sizes

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| `Xenova/whisper-tiny.en` | ~40MB | fastest | good |
| `Xenova/whisper-base.en` | ~150MB | fast | **default** |
| `Xenova/whisper-small.en` | ~250MB | moderate | better |

Change with `WHISPER_MODEL=Xenova/whisper-small.en` in `.env`.

---

## Troubleshooting

**"Could not transcribe audio"**
- Speak clearly and at normal volume
- Check that the audio waveform is moving when you speak
- Try clicking the Record button manually

**"Inference API error"**
- Verify your `429-API-KEY` in `.env`
- Check connectivity: `curl https://api.429inference.com/v1/models`
- Test in browser: [http://localhost:3000/api/test](http://localhost:3000/api/test)

**Wake word not triggering**
- Use Chrome (Web Speech API is Chrome-only)
- Speak clearly: "Ok Jennifer" or just "Jennifer"
- Use the manual Record button as fallback

**No audio playback**
- Check browser console for errors
- Ensure ffmpeg is installed: `ffmpeg -version`
- macOS: `say` must be available (pre-installed)
- Linux: `espeak-ng` must be installed — run `install.sh` or `sudo pacman -S espeak-ng` / `sudo apt install espeak-ng`
