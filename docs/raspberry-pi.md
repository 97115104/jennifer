---
title: Raspberry Pi
layout: default
nav_order: 6
---

# Raspberry Pi
{: .no_toc }

Jennifer's server exposes a REST API so a Raspberry Pi (or any device) can act as a remote mic/speaker — no display required.

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## Architecture

```
Raspberry Pi
 ├─ Microphone → record audio
 ├─ GPIO button → trigger recording
 └─ POST /api/query/audio ──► Jennifer Server (Mac/Linux)
                                  ├─ Whisper STT
                                  ├─ 429 API inference
                                  └─ TTS audio
         ◄── base64 MP3 ──────────┘
 Speaker ◄── play audio
```

The Pi is a thin client — all intelligence lives on the Jennifer server. The Pi only needs Python + a few packages.

---

## Pi Setup

### 1. Install dependencies

```bash
sudo apt update && sudo apt install -y python3 python3-pip ffmpeg
pip3 install requests pyaudio sounddevice soundfile
```

### 2. Find Jennifer's IP

On the Jennifer server machine:

```bash
ifconfig | grep "inet " | grep -v 127
# e.g., 192.168.1.42
```

### 3. Pi client script

Save as `jennifer_pi.py`:

```python
#!/usr/bin/env python3
"""
Raspberry Pi client for Jennifer voice assistant.
Press ENTER (or wire a GPIO button) to record, releases on silence.
"""

import os, sys, time, base64, tempfile, subprocess
import sounddevice as sd
import soundfile as sf
import numpy as np
import requests

JENNIFER_URL = os.getenv("JENNIFER_URL", "http://192.168.1.42:3000")
SAMPLE_RATE = 16000
SILENCE_THRESHOLD = 0.01
SILENCE_DURATION = 3.0   # seconds of silence before stopping

def record_until_silence():
    print("Recording... (speak now)")
    chunks = []
    silent_since = None

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype='float32') as stream:
        while True:
            data, _ = stream.read(1600)  # 100ms chunks
            rms = float(np.sqrt(np.mean(data**2)))
            chunks.append(data)

            if rms < SILENCE_THRESHOLD:
                if silent_since is None:
                    silent_since = time.time()
                elif time.time() - silent_since >= SILENCE_DURATION:
                    print(f"Silence detected — stopping ({len(chunks)} chunks)")
                    break
            else:
                silent_since = None

    audio = np.concatenate(chunks, axis=0)
    return audio

def ask(audio_array=None, text=None):
    if text:
        r = requests.post(f"{JENNIFER_URL}/api/query/text",
                          json={"text": text}, timeout=60)
    else:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            sf.write(f.name, audio_array, SAMPLE_RATE)
            with open(f.name, 'rb') as af:
                r = requests.post(f"{JENNIFER_URL}/api/query/audio",
                                  files={"audio": ("recording.wav", af, "audio/wav")},
                                  timeout=60)
        os.unlink(f.name)

    if r.status_code != 200:
        print(f"Error: {r.status_code} {r.text}")
        return

    data = r.json()
    print(f"\nYou:      {data.get('transcript', text)}")
    print(f"Jennifer: {data['response']}\n")

    # Play audio response
    if data.get("audio"):
        audio_bytes = base64.b64decode(data["audio"])
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            f.write(audio_bytes)
            subprocess.run(["ffplay", "-nodisp", "-autoexit", f.name],
                           capture_output=True)
            os.unlink(f.name)

def main():
    print(f"Jennifer Pi Client — server: {JENNIFER_URL}")
    print("Press ENTER to speak, or type a question and press ENTER")
    print("Ctrl+C to exit\n")

    while True:
        try:
            user_input = input(">>> ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nGoodbye!")
            break

        if user_input:
            ask(text=user_input)
        else:
            audio = record_until_silence()
            ask(audio_array=audio)

if __name__ == "__main__":
    main()
```

### 4. Run it

```bash
JENNIFER_URL=http://192.168.1.42:3000 python3 jennifer_pi.py
```

---

## GPIO Button Trigger (optional)

Wire a momentary button to GPIO17 and add this to the script:

```python
import RPi.GPIO as GPIO

BUTTON_PIN = 17
GPIO.setmode(GPIO.BCM)
GPIO.setup(BUTTON_PIN, GPIO.IN, pull_up_down=GPIO.PUD_UP)

def wait_for_button():
    print("Press button to speak...")
    GPIO.wait_for_edge(BUTTON_PIN, GPIO.FALLING)

# In main loop:
while True:
    wait_for_button()
    audio = record_until_silence()
    ask(audio_array=audio)
```

---

## Streaming Mode (WebSocket)

For lower latency and real-time status updates, use the WebSocket API instead:

```python
import asyncio, websockets, json, base64
import sounddevice as sd
import soundfile as sf
import numpy as np
import tempfile, os

JENNIFER_WS = "ws://192.168.1.42:3000"

async def jennifer_ws():
    async with websockets.connect(JENNIFER_WS) as ws:
        while True:
            audio = record_until_silence()
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                sf.write(f.name, audio, 16000)
                with open(f.name, 'rb') as af:
                    b64 = base64.b64encode(af.read()).decode()
                os.unlink(f.name)

            await ws.send(json.dumps({"type": "audio", "data": b64, "mimeType": "audio/wav"}))

            while True:
                msg = json.loads(await ws.recv())
                if msg["type"] == "transcript":
                    print(f"You: {msg['text']}")
                elif msg["type"] == "response":
                    print(f"Jennifer: {msg['text']}")
                elif msg["type"] == "audio":
                    # play audio
                    break
                elif msg["type"] == "error":
                    print(f"Error: {msg['message']}")
                    break

asyncio.run(jennifer_ws())
```
