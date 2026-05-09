#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Read only the .env values this Bash script needs. Do not source the file:
# 429-API-KEY is intentionally not a valid shell variable name, but Node's
# dotenv loader supports it.
read_dotenv_value() {
  local key="$1"
  local line value

  if [ ! -f "$ROOT/.env" ]; then
    return 1
  fi

  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ROOT/.env" | tail -n 1 || true)"
  if [ -z "$line" ]; then
    return 1
  fi

  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi

  printf '%s\n' "$value"
}

# ── Dependency checks ─────────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "❌  Node.js not found. Run ./scripts/install.sh first."
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌  Node.js v18+ required (found v$(node --version))"
  exit 1
fi

if ! command -v ffmpeg &>/dev/null; then
  echo "❌  ffmpeg not found. Run ./scripts/install.sh first."
  exit 1
fi

# ── npm dependencies ──────────────────────────────────────────────────────────

if [ ! -d "$ROOT/node_modules" ]; then
  echo "📦  Installing Node.js packages..."
  npm install
fi

# ── .env check ────────────────────────────────────────────────────────────────

if [ ! -f "$ROOT/.env" ]; then
  echo "⚠   No .env file found — run ./scripts/install.sh first"
  exit 1
fi

if grep -q "your_key_here" "$ROOT/.env"; then
  echo "⚠   Add your 429-API-KEY to .env before starting"
  exit 1
fi

if ENV_TTS_PROVIDER="$(read_dotenv_value TTS_PROVIDER)"; then
  export TTS_PROVIDER="$ENV_TTS_PROVIDER"
fi

if ENV_PORT="$(read_dotenv_value PORT)"; then
  export PORT="$ENV_PORT"
fi

# ── Coqui TTS server (only when TTS_PROVIDER=coqui) ──────────────────────────

TTS_PID=""
VENV_PYTHON="$ROOT/tts/.venv/bin/python"

if [[ "${TTS_PROVIDER:-system}" == "coqui" ]]; then
  echo ""
  echo "🎤  Voice cloning enabled (Coqui XTTS v2)"

  if [ ! -f "$VENV_PYTHON" ]; then
    echo "❌  TTS venv not found at tts/.venv"
    echo "    Run ./scripts/install.sh first to set up voice cloning"
    exit 1
  fi

  # Kill any stale TTS server on port 5123
  if lsof -ti:5123 &>/dev/null; then
    echo "   Stopping existing TTS server on :5123..."
    lsof -ti:5123 | xargs kill -9 2>/dev/null || true
    sleep 1
  fi

  echo "   Starting TTS server (XTTS v2 model loading...)"
  "$VENV_PYTHON" "$ROOT/tts/server.py" > "$ROOT/tts/server.log" 2>&1 &
  TTS_PID=$!

  # Wait up to 3 minutes for model to load (first run may also download it)
  echo "   Waiting for TTS model to load (up to 3 min — first run downloads ~2GB)..."
  TTS_READY=false
  for i in $(seq 1 180); do
    if curl -s "http://localhost:5123/api/health" 2>/dev/null | grep -q '"model_loaded":true'; then
      TTS_READY=true
      break
    fi
    # Show log tail every 15 seconds
    if (( i % 15 == 0 )); then
      LAST_LOG=$(tail -1 "$ROOT/tts/server.log" 2>/dev/null || echo "...")
      echo "   [${i}s] $LAST_LOG"
    fi
    sleep 1
  done

  if [ "$TTS_READY" = false ]; then
    echo ""
    echo "⚠   TTS server didn't become ready in 3 minutes"
    echo "    Check logs: tail -f $ROOT/tts/server.log"
    echo "    Continuing with system TTS fallback..."
    kill "$TTS_PID" 2>/dev/null || true
    TTS_PID=""
  else
    echo "✅  TTS server ready"
  fi
fi

# ── Start Jennifer ────────────────────────────────────────────────────────────

PORT="${PORT:-3000}"
echo ""
echo "🎙  Starting Jennifer on port $PORT..."

# Kill any existing instance on this port
if lsof -ti:"$PORT" &>/dev/null; then
  echo "   Stopping existing server on :$PORT..."
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

node "$ROOT/src/server/index.js" &
SERVER_PID=$!

# Wait for Jennifer to become ready
for i in $(seq 1 20); do
  if curl -s "http://localhost:$PORT/api/health" &>/dev/null; then
    break
  fi
  sleep 0.5
done

echo ""
echo "✅  Jennifer is running at http://localhost:$PORT"
if [[ "${TTS_PROVIDER:-system}" == "coqui" && -n "$TTS_PID" ]]; then
  echo "   Voice cloning: active (XTTS v2)"
fi
echo ""

# Open browser
if [[ "$OSTYPE" == "darwin"* ]]; then
  open "http://localhost:$PORT"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  xdg-open "http://localhost:$PORT" 2>/dev/null || true
fi

echo "   Press Ctrl+C to stop"
echo ""

# Cleanup on exit — kill both servers
cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$SERVER_PID" 2>/dev/null || true
  if [ -n "$TTS_PID" ]; then
    kill "$TTS_PID" 2>/dev/null || true
    echo "   TTS server stopped"
  fi
  exit 0
}

trap cleanup INT TERM
wait "$SERVER_PID"
