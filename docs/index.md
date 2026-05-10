---
title: Home
layout: home
nav_order: 1
---

# Jennifer
{: .no_toc }

An always-on AI voice assistant — say "Ok Jennifer" and it does real things.
{: .fs-6 .fw-300 }

[Get Started](getting-started){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[API Reference](api-reference){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## What is Jennifer?

Jennifer is a locally-hosted AI voice assistant built with Node.js. It:

- Listens for "Ok Jennifer" as a wake word (no cloud wake-word service)
- Records your question until 3 seconds of silence
- Transcribes audio locally using **Whisper** (no STT API cost)
- Sends the transcript to the **429 Inference API** for a response
- Speaks the answer aloud using your system voice or **429 Inference voice**
- Can take **real actions** via tools: fetch URLs, run shell commands, send email, read/write files

## Key Features

| Feature | Details |
|---------|---------|
| Wake word | "Ok Jennifer" via Web Speech API |
| STT | Whisper (local, via `@xenova/transformers`) |
| Inference | 429inference.com — `gpt-oss` reasoning model |
| TTS | macOS `say` / Linux `espeak-ng` / 429 Inference voice |
| Tools | fetch_url, execute_shell, read_file, write_file, send_email |
| API | REST + WebSocket — connects Raspberry Pi and other devices |
| Voice | Optional 429 Inference voice from a saved source sample |

## Example Queries

```
Ok Jennifer, what is the weather today?
Ok Jennifer, how old is Justin Bieber?
Ok Jennifer, read the latest post from blog.97115104.com aloud
Ok Jennifer, create a Jekyll site called Steve's Blog in ~/Sites
Ok Jennifer, what should we make for dinner? (check our fridge server)
Ok Jennifer, send an email to steve@example.com with the GitHub repo link
```

## Architecture

```
Browser (Chrome)
 ├─ Web Speech API → wake word "Jennifer"
 ├─ MediaRecorder  → audio capture
 └─ WebSocket ──────────────────────────────┐
                                            ↓
                                   Node.js Server
                                    ├─ WhisperProvider → local Whisper STT
                                    ├─ InferenceClient → 429 API (tools loop)
                                    │    ├─ fetch_url
                                    │    ├─ execute_shell
                                    │    ├─ read_file / write_file
                                    │    └─ send_email
                                    └─ TTSProvider → audio file
                                            ↓
                                   WebSocket → Browser plays audio
```
