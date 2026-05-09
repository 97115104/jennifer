"""
Jennifer TTS Server — Voice Cloning via XTTS v2
Embedded from github.com/97115104/myvoice (MIT)

Usage:
    python tts/server.py [--port PORT]

API:
    GET  /api/health  — model status
    POST /api/tts     — generate speech { text, voice (base64 data URL), language, speed }
"""

import os
import sys

# Accept Coqui TOS automatically
os.environ["COQUI_TOS_AGREED"] = "1"

import json
import base64
import tempfile
import argparse
import logging
import re
from pathlib import Path
from io import BytesIO
from urllib.parse import urlparse

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS

import torch
import torchaudio
from TTS.api import TTS
from TTS.config.shared_configs import BaseDatasetConfig
from TTS.tts.configs.xtts_config import XttsAudioConfig, XttsConfig
from TTS.tts.models.xtts import XttsArgs

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

tts_model = None
MODEL_NAME = "tts_models/multilingual/multi-dataset/xtts_v2"


def allow_trusted_xtts_checkpoint_globals():
    """Allow Coqui XTTS config classes for PyTorch 2.6+ safe checkpoint load."""
    add_safe_globals = getattr(torch.serialization, "add_safe_globals", None)
    if not add_safe_globals:
        return

    add_safe_globals([
        BaseDatasetConfig,
        XttsAudioConfig,
        XttsArgs,
        XttsConfig,
    ])


def load_model():
    global tts_model

    logger.info("Loading XTTS v2 model...")
    logger.info("First run downloads ~2GB — subsequent starts are fast")

    if torch.cuda.is_available():
        device = "cuda"
        logger.info("Using NVIDIA GPU")
    else:
        device = "cpu"
        logger.info("Using CPU (generation: ~15-30s per sentence)")

    try:
        allow_trusted_xtts_checkpoint_globals()
        tts_model = TTS(MODEL_NAME).to(device)
        logger.info("XTTS v2 model loaded")
        return True
    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        return False


def decode_audio_data(audio_data_url):
    """Decode base64 audio data URL → temp file"""
    if ',' in audio_data_url:
        header, data = audio_data_url.split(',', 1)
    else:
        data = audio_data_url

    audio_bytes = base64.b64decode(data)

    suffix = '.wav'
    if 'audio/mp3' in audio_data_url or 'audio/mpeg' in audio_data_url:
        suffix = '.mp3'
    elif 'audio/webm' in audio_data_url:
        suffix = '.webm'
    elif 'audio/ogg' in audio_data_url:
        suffix = '.ogg'

    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.write(audio_bytes)
    tmp.close()
    return tmp.name


def convert_to_wav(input_path):
    """Convert any audio file to 22050 Hz mono WAV (XTTS requirement)"""
    output_path = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name

    try:
        from pydub import AudioSegment
        ext = Path(input_path).suffix.lower().lstrip('.')
        if ext == 'm4a':
            ext = 'mp4'
        audio = AudioSegment.from_file(input_path, format=ext or None)
        audio = audio.set_channels(1).set_frame_rate(22050)
        audio.export(output_path, format='wav')
        return output_path
    except Exception as e:
        logger.warning(f"pydub conversion failed ({e}), trying torchaudio")
        try:
            waveform, sample_rate = torchaudio.load(input_path)
            if waveform.shape[0] > 1:
                waveform = torch.mean(waveform, dim=0, keepdim=True)
            if sample_rate != 22050:
                waveform = torchaudio.transforms.Resample(sample_rate, 22050)(waveform)
            torchaudio.save(output_path, waveform, 22050)
            return output_path
        except Exception as e2:
            logger.error(f"Audio conversion fallback failed: {e2}")
            return input_path


def split_text_into_chunks(text, max_chars=300):
    """Split text on sentence boundaries for better XTTS prosody"""
    sentence_endings = re.compile(r'(?<=[.!?])\s+')
    sentences = sentence_endings.split(text)

    chunks = []
    current = ""

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue

        if len(sentence) > max_chars:
            for clause in re.split(r'(?<=[,;:])\s+', sentence):
                clause = clause.strip()
                if not clause:
                    continue
                if len(current) + len(clause) + 1 <= max_chars:
                    current = f"{current} {clause}".strip()
                else:
                    if current:
                        chunks.append(current)
                    current = clause
        elif len(current) + len(sentence) + 1 <= max_chars:
            current = f"{current} {sentence}".strip()
        else:
            if current:
                chunks.append(current)
            current = sentence

    if current:
        chunks.append(current)

    return chunks


def concatenate_audio_files(audio_paths, output_path, crossfade_ms=50):
    from pydub import AudioSegment

    combined = AudioSegment.from_wav(audio_paths[0])
    for path in audio_paths[1:]:
        try:
            seg = AudioSegment.from_wav(path)
            if crossfade_ms > 0 and len(combined) > crossfade_ms and len(seg) > crossfade_ms:
                combined = combined.append(seg, crossfade=crossfade_ms)
            else:
                combined += AudioSegment.silent(duration=100) + seg
        except Exception as e:
            logger.warning(f"Skipping chunk {path}: {e}")

    combined.export(output_path, format='wav')
    return output_path


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.route('/api/health', methods=['GET'])
@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'model': 'XTTS v2',
        'model_loaded': tts_model is not None,
        'device': 'cuda' if torch.cuda.is_available() else 'cpu',
    })


@app.route('/api/tts', methods=['POST'])
@app.route('/tts', methods=['POST'])
def text_to_speech():
    """POST { text, voice (base64 data URL), language?, speed? } → MP3"""
    if tts_model is None:
        return jsonify({'error': 'Model not loaded'}), 503

    data = request.get_json()
    text = (data.get('text') or '').strip()
    voice_data = data.get('voice') or data.get('speaker_wav_b64')
    language = data.get('language', 'en')
    speed = float(data.get('speed', 1.0))

    if not text:
        return jsonify({'error': 'No text provided'}), 400
    if not voice_data:
        return jsonify({'error': 'No voice sample provided (pass base64 data URL as "voice")'}), 400

    logger.info(f"TTS: {len(text)} chars, lang={language}, speed={speed}")

    voice_path = decode_audio_data(voice_data)
    wav_path = convert_to_wav(voice_path)

    chunks = split_text_into_chunks(text, max_chars=200)
    logger.info(f"Split into {len(chunks)} chunk(s)")

    chunk_paths = []
    for i, chunk in enumerate(chunks):
        logger.info(f"  Chunk {i+1}/{len(chunks)}: {len(chunk)} chars")
        out = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
        try:
            tts_model.tts_to_file(
                text=chunk,
                speaker_wav=wav_path,
                language=language,
                file_path=out,
                speed=speed,
            )
            chunk_paths.append(out)
        except Exception as e:
            logger.error(f"  Chunk {i+1} failed: {e}")

    if not chunk_paths:
        return jsonify({'error': 'Failed to generate audio'}), 500

    # Concatenate chunks
    if len(chunk_paths) == 1:
        wav_out = chunk_paths[0]
    else:
        wav_out = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
        concatenate_audio_files(chunk_paths, wav_out)
        for p in chunk_paths:
            try: os.unlink(p)
            except: pass

    # Convert to MP3
    mp3_out = tempfile.NamedTemporaryFile(suffix='.mp3', delete=False).name
    from pydub import AudioSegment
    AudioSegment.from_wav(wav_out).export(mp3_out, format='mp3', bitrate='192k')

    # Cleanup temp files
    for p in [voice_path, wav_path, wav_out]:
        try: os.unlink(p)
        except: pass

    logger.info("TTS complete")
    return send_file(mp3_out, mimetype='audio/mpeg', download_name='speech.mp3')


@app.route('/', methods=['GET'])
def root():
    return "Jennifer TTS server running", 200


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=5123)
    args = parser.parse_args()

    if not load_model():
        logger.error("Failed to load XTTS v2 model — check installation")
        sys.exit(1)

    logger.info(f"Jennifer TTS server on http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == '__main__':
    main()
