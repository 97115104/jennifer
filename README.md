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
                                                └─ TTS (system / 429 Inference voice)
                                                        ↓
                                               WebSocket → Browser plays audio
```

---

## Features

- **Wake word** — "Ok Jennifer" via Web Speech API (no cloud service)
- **Local STT** — Whisper via `@xenova/transformers` (~150MB, no API cost)
- **Reasoning model** — 429inference.com `gpt-oss` with chain-of-thought
- **Tool system** — extensible plugin registry; model picks the right tool
- **Memory variables** — save contacts, URLs, blogs, and reusable values at `/memory`
- **System TTS** — macOS `say` / Linux `espeak-ng` / Windows SAPI — installed automatically on Linux
- **429 voice** — Chatterbox Turbo voice through 429 Inference with a saved source sample
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
│   │   ├── SystemTTSProvider.js — macOS say / Linux espeak-ng / Windows SAPI
│   │   └── Remote429TTSProvider.js — 429 Inference voice
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

## 429 Voice

Set `TTS_PROVIDER=429` in `.env` or choose 429 Inference in `/settings` to use 429 voice:

```bash
TTS_PROVIDER=429
# Optional: if omitted, Jennifer can reuse 429-API-KEY.
429-VOICE-API-KEY=your_voice_key_here
```

Record or upload a voice source in `/settings`, then click `Use` next to that saved source. Without 429 voice configuration, Jennifer uses the system voice by default.

See [429 Voice docs](https://97115104.github.io/jennifer/voice-cloning) for full setup.

---

## Memory Variables

Open `http://localhost:3000/memory` to save named emails, URLs, blogs, and reusable text values. Jennifer can use those names with tools, such as "send email to Dakota" or "read the latest from my blog."

---

## Assistant Name

Open `http://localhost:3000/settings` and use the General tab to rename Jennifer. The main screen and wake phrase update to the saved name, for example `Ok Dakota`.

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
| `429-VOICE-API-KEY` | `429-API-KEY` | Optional separate key for 429 voice |
| `TTS_PROVIDER` | `system` | `system` or `429` |
| `TTS_TIMEOUT_MS` | `0` | Reserved for TTS requests; `0` disables the client timeout |
| `API_MAX_TOKENS` | `8192` | Maximum model response tokens |
| `API_TIMEOUT_MS` | `120000` | Inference request timeout in milliseconds |
| `FETCH_MAX_CHARS` | `50000` | Maximum readable characters returned by one fetch |
| `FETCH_TIMEOUT_MS` | `45000` | URL fetch timeout in milliseconds |
| `QUERY_AUDIO_MAX_MB` | `500` | Maximum uploaded query audio size |
| `VOICE_UPLOAD_MAX_MB` | `500` | Maximum uploaded voice source size |
| `WHISPER_MODEL` | `Xenova/whisper-base.en` | Whisper model ID |
| `SMTP_HOST` | — | SMTP server for email tool |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |
| `PORT` | `3000` | Server port |

---

## Requirements

- Node.js 22.5+
- ffmpeg — auto-installed by `install.sh`; or manually: `brew install ffmpeg` / `sudo apt install ffmpeg` / `sudo pacman -S ffmpeg`
- espeak-ng — auto-installed by `install.sh` on Linux (system TTS)
- Chrome (for wake word — Web Speech API)

---

## License

MIT
