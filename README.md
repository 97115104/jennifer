# Jennifer

An always-on AI voice assistant. Say "Ok Jennifer" and it does real things.

> **Docs →** [97115104.github.io/jennifer](https://97115104.github.io/jennifer)

---

## Quick Start

```bash
# 1. Install dependencies
./scripts/install.sh

# 2. Add your API key
echo "429-API-KEY=your_key_here" > .env

# 3. Start
./scripts/deploy-locally.sh
```

Open Chrome at [http://localhost:3000](http://localhost:3000), click **Start Listening**, say "Ok Jennifer".

---

## How It Works

```
"Ok Jennifer, read the latest post from my blog"
        │
        ▼
Browser (Chrome)
 ├─ Web Speech API  → wake word detection
 ├─ MediaRecorder   → audio capture (stops on 3s silence)
 └─ WebSocket ──────────────────────────────────────────┐
                                                        ↓
                                               Node.js Server
                                                ├─ Whisper (local)    → transcript
                                                ├─ 429 inference API  → response
                                                │    └─ tools loop:
                                                │         fetch_url
                                                │         execute_shell
                                                │         read_file / write_file
                                                │         send_email
                                                └─ TTS (system / Coqui XTTS v2)
                                                        ↓
                                               WebSocket → Browser plays audio
```

---

## Features

- **Wake word** — "Ok Jennifer" via Web Speech API (no cloud service)
- **Local STT** — Whisper via `@xenova/transformers` (~150MB, no API cost)
- **Reasoning model** — 429inference.com `gpt-oss` with chain-of-thought
- **Tool system** — extensible plugin registry; model picks the right tool
- **System TTS** — macOS `say` / Linux `espeak` / Windows SAPI out of the box
- **Voice cloning** — Coqui XTTS v2 via [myvoice](https://github.com/97115104/myvoice) (no ElevenLabs)
- **REST + WebSocket API** — connect any device (Raspberry Pi, mobile, etc.)

---

## Example Queries

```
Ok Jennifer, what is the weather today?
Ok Jennifer, how old is Justin Bieber?
Ok Jennifer, read the latest post from blog.97115104.com aloud
Ok Jennifer, create a Jekyll blog in ~/Sites called "Steve's Blog"
Ok Jennifer, using my recipe list (check our fridge server) what should we make tonight?
Ok Jennifer, send an email to x@97115104.com with the GitHub repo link
Ok Jennifer, what can you learn about Steve Harshberger online?
```

---

## Architecture

```
jennifer/
├── src/
│   ├── config/index.js          — environment config
│   ├── core/
│   │   ├── Assistant.js         — main orchestrator (EventEmitter)
│   │   └── Conversation.js      — chat history
│   ├── stt/
│   │   └── WhisperProvider.js   — local Whisper transcription
│   ├── inference/
│   │   └── InferenceClient.js   — 429 API + tool-call loop
│   ├── tts/
│   │   ├── SystemTTSProvider.js — macOS say / Linux espeak / Windows SAPI
│   │   └── CoquiTTSProvider.js  — XTTS v2 voice cloning
│   ├── tools/
│   │   ├── ToolRegistry.js      — plugin system
│   │   ├── WebFetchTool.js      — fetch any URL
│   │   ├── ShellTool.js         — shell commands
│   │   ├── ReadFileTool.js      — read local files
│   │   ├── WriteFileTool.js     — write local files
│   │   └── EmailTool.js         — SMTP email
│   └── server/
│       ├── app.js               — Express + WebSocket
│       └── index.js             — entry point
├── public/                      — browser UI
├── docs/                        — GitHub Pages documentation
└── scripts/
    ├── install.sh               — one-time setup
    └── deploy-locally.sh        — start server + open browser
```

---

## API

### REST

```bash
POST /api/query/text    # { "text": "..." }           → { transcript, response, audio }
POST /api/query/audio   # multipart audio file        → { transcript, response, audio }
GET  /api/health        # server status + tool list
GET  /api/test          # verify 429 API connection
```

### WebSocket

```
ws://localhost:3000

Client → { type: "audio", data: "<base64>", mimeType: "audio/webm" }
Client → { type: "text",  content: "..." }
Client → { type: "reset" }

Server → { type: "transcript", text }
Server → { type: "response",   text }
Server → { type: "audio",      data, mimeType }
Server → { type: "status",     state, message }
Server → { type: "tool_call",  name, args }
Server → { type: "error",      message }
```

---

## Voice Cloning

Set TTS_PROVIDER=coqui in `.env` to use [myvoice](https://github.com/97115104/myvoice) (Coqui XTTS v2):

```bash
TTS_PROVIDER=coqui
COQUI_URL=http://localhost:5123
COQUI_SPEAKER_WAV=/path/to/voice_sample.wav  # 10–30s of clean audio
```

Run myvoice first: `cd ~/myvoice && python server.py`

See [Voice Cloning docs](https://97115104.github.io/jennifer/voice-cloning) for full setup.

---

## Raspberry Pi

```bash
JENNIFER_URL=http://your-server-ip:3000 python3 scripts/jennifer_pi.py
```

See [Raspberry Pi docs](https://97115104.github.io/jennifer/raspberry-pi).

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `429-API-KEY` | — | **Required.** Get at 429inference.com |
| `TTS_PROVIDER` | `system` | `system` or `coqui` |
| `COQUI_URL` | `http://localhost:5123` | Coqui server URL |
| `COQUI_SPEAKER_WAV` | — | Path to voice sample WAV |
| `WHISPER_MODEL` | `Xenova/whisper-base.en` | Whisper model ID |
| `SMTP_HOST` | — | SMTP server for email tool |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |
| `PORT` | `3000` | Server port |

---

## Requirements

- Node.js 18+
- ffmpeg (`brew install ffmpeg`)
- Chrome (for wake word — Web Speech API)
- Python 3.9–3.11 (optional, for Coqui voice cloning)

---

## License

MIT
