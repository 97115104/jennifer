---
title: 429 Voice
layout: default
nav_order: 5
---

# 429 Voice
{: .no_toc }

Jennifer can speak through 429 Inference voice when you provide a 429 API key and a saved voice source sample. If 429 voice is not configured, Jennifer uses the system voice by default.

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
Remote429TTSProvider
     │  POST /v1/tts/synthesize { text, voice }
     ▼
429 Inference Chatterbox Turbo
     │
     ▼
MP3 audio
     │
     ▼
Browser plays it
```

The source sample is stored under `data/voices/` and sent to 429 Inference for synthesis.

---

## Setup

### 1. Configure a key

Use `/settings` or add this to `.env`:

```bash
TTS_PROVIDER=429
# Optional: if omitted, Jennifer can reuse 429-API-KEY.
429-VOICE-API-KEY=your_voice_key_here
```

### 2. Save a voice source

- Start Jennifer with `./scripts/deploy-locally.sh`
- Open [http://localhost:3000/settings](http://localhost:3000/settings)
- Choose `429 Inference (Chatterbox Turbo)` in the Voice tab
- Record or upload a clean 20-30 second source sample
- Click `Use` next to the saved source

### 3. Test speech

Click `Test` in the Voice tab. Jennifer should play "This is a test."

---

## Fallback Behavior

If 429 voice fails during a conversation, Jennifer falls back to the system voice for that response. Configuration problems appear in the Voice tab test result so they can be fixed without checking server logs.

To check which TTS provider is active:

```bash
curl http://localhost:3000/api/health
```

---

## Troubleshooting

**"429 TTS API key is not configured"**
- Add `429-VOICE-API-KEY` to `.env`, or save the key in `/settings`.
- If you do not need a separate voice key, Jennifer can reuse `429-API-KEY`.

**"429 TTS needs a saved voice source"**
- Record or upload a source sample in the Voice tab.
- Click `Use` next to that saved source before testing.

**Voice source file is missing**
- The selected file under `data/voices/` was deleted.
- Upload or record a new source sample and select it.
