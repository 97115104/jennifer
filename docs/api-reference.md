---
title: API Reference
layout: default
nav_order: 3
---

# API Reference
{: .no_toc }

Jennifer exposes a REST API and WebSocket interface so any device (browser, Raspberry Pi, mobile app) can use it.

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## Base URL

```
http://localhost:3000
```

---

## REST Endpoints

### GET /api/health

Returns server status and list of registered tools.

```bash
curl http://localhost:3000/api/health
```

```json
{
  "status": "ok",
  "version": "1.0.0",
  "tools": ["fetch_url", "execute_shell", "read_file", "write_file", "send_email"]
}
```

---

### GET /api/test

Tests the 429 API connection. Useful for verifying your API key works.

```bash
curl http://localhost:3000/api/test
```

```json
{
  "status": "ok",
  "reply": "API OK",
  "worker": "beast-5090",
  "ms": 1920,
  "model": "gpt-oss"
}
```

---

### POST /api/query/text

Submit a text query. Returns transcript, text response, and base64-encoded MP3 audio.

```bash
curl -X POST http://localhost:3000/api/query/text \
  -H "Content-Type: application/json" \
  -d '{"text": "What is the weather today?"}'
```

**Request body:**

```json
{
  "text": "What is the weather today?"
}
```

**Response:**

```json
{
  "transcript": "What is the weather today?",
  "response": "I checked and it looks like it's 72 degrees and sunny in your area today.",
  "audio": "base64_mp3_data...",
  "mimeType": "audio/mpeg"
}
```

---

### POST /api/query/audio

Submit a raw audio file. The server transcribes it with Whisper, runs inference, and returns the response.

```bash
curl -X POST http://localhost:3000/api/query/audio \
  -F "audio=@recording.wav;type=audio/wav"
```

**Supported formats:** WAV, WebM, MP4, OGG (anything ffmpeg can decode)

**Response:** same as `/api/query/text`

---

## WebSocket Protocol

Connect to `ws://localhost:3000` for real-time bidirectional communication.

### Client → Server Messages

#### audio

Send a base64-encoded audio recording.

```json
{
  "type": "audio",
  "data": "base64_encoded_audio...",
  "mimeType": "audio/webm"
}
```

#### text

Send a text query directly (skip transcription).

```json
{
  "type": "text",
  "content": "What is the capital of France?"
}
```

#### reset

Clear conversation history and start fresh.

```json
{
  "type": "reset"
}
```

---

### Server → Client Messages

#### status

State updates during processing.

```json
{
  "type": "status",
  "state": "transcribing",
  "message": "Transcribing..."
}
```

States: `idle` | `transcribing` | `thinking` | `tool_executing` | `speaking`

#### transcript

The transcribed text from speech recognition.

```json
{
  "type": "transcript",
  "text": "What is the weather today?"
}
```

#### response

Jennifer's text response.

```json
{
  "type": "response",
  "text": "It looks like it's 72 degrees and sunny."
}
```

#### audio

The TTS audio response as base64 MP3.

```json
{
  "type": "audio",
  "data": "base64_mp3_data...",
  "mimeType": "audio/mpeg"
}
```

#### tool_call

Fired when Jennifer is executing a tool.

```json
{
  "type": "tool_call",
  "name": "fetch_url",
  "args": { "url": "https://example.com" }
}
```

#### error

An error occurred.

```json
{
  "type": "error",
  "message": "Could not transcribe audio"
}
```

---

## Raspberry Pi Quick Start

```python
import requests, base64, pyaudio, wave, tempfile

JENNIFER_URL = "http://jennifer-host:3000"

def ask(text):
    r = requests.post(f"{JENNIFER_URL}/api/query/text", json={"text": text})
    data = r.json()
    print("Jennifer:", data["response"])
    # play audio
    audio_bytes = base64.b64decode(data["audio"])
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(audio_bytes)
        # play f.name with pygame or omxplayer

ask("What is the weather today?")
```
