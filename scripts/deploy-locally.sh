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

NODE_VERSION=$(node -e "console.log(process.versions.node)")
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
NODE_MINOR=$(node -e "console.log(process.versions.node.split('.')[1])")
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "❌  Node.js v22.5+ required (found v${NODE_VERSION})"
  echo "   Install via: nvm install 22 && nvm use 22"
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

case "${TTS_PROVIDER:-system}" in
  system|429) ;;
  *)
    echo "❌  Invalid TTS_PROVIDER='${TTS_PROVIDER}'. Use 'system' or '429'."
    exit 1
    ;;
esac

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
if [[ "${TTS_PROVIDER:-system}" == "429" ]]; then
  echo "   Voice: 429 Inference"
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

# Cleanup on exit
cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$SERVER_PID" 2>/dev/null || true
  exit 0
}

trap cleanup INT TERM
wait "$SERVER_PID"
