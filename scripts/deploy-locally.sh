#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Dependency checks ────────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "❌  Node.js not found. Install from https://nodejs.org (v18+)"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌  Node.js v18+ required (found v$(node --version))"
  exit 1
fi

if ! command -v ffmpeg &>/dev/null; then
  echo "❌  ffmpeg not found."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "    Install with: brew install ffmpeg"
  else
    echo "    Install with: sudo apt install ffmpeg"
  fi
  exit 1
fi

# ── Install npm dependencies ─────────────────────────────────────────────────

if [ ! -d "$ROOT/node_modules" ]; then
  echo "📦  Installing dependencies..."
  npm install
  echo "✅  Dependencies installed"
fi

# ── Check .env ───────────────────────────────────────────────────────────────

if [ ! -f "$ROOT/.env" ]; then
  echo "⚠   No .env file found. Creating from template..."
  cat > "$ROOT/.env" <<'ENVEOF'
429-API-KEY=your_key_here

# Optional: change TTS provider (system | coqui)
TTS_PROVIDER=system

# Optional: Coqui XTTS v2 voice server (see github.com/97115104/myvoice)
# COQUI_URL=http://localhost:5123
# COQUI_SPEAKER_WAV=/path/to/your/voice/sample.wav

# Optional: SMTP for email tool
# SMTP_HOST=smtp.gmail.com
# SMTP_USER=you@gmail.com
# SMTP_PASS=app_password
# SMTP_FROM=you@gmail.com

# Optional: change port
# PORT=3000
ENVEOF
  echo "   Edit .env and add your 429-API-KEY, then re-run this script."
  exit 1
fi

# Warn if API key looks like placeholder
if grep -q "your_key_here" "$ROOT/.env"; then
  echo "⚠   .env contains placeholder API key. Edit .env before starting."
  exit 1
fi

# ── Start server ─────────────────────────────────────────────────────────────

PORT="${PORT:-3000}"
echo ""
echo "🎙  Starting Jennifer on port $PORT..."
echo ""

# Kill any existing instance on this port
if lsof -ti:"$PORT" &>/dev/null; then
  echo "   Killing existing process on port $PORT..."
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

node "$ROOT/src/server/index.js" &
SERVER_PID=$!

# Wait for server to become ready
for i in $(seq 1 20); do
  if curl -s "http://localhost:$PORT/api/health" &>/dev/null; then
    break
  fi
  sleep 0.5
done

echo ""
echo "✅  Jennifer is running at http://localhost:$PORT"
echo ""

# Open browser
if [[ "$OSTYPE" == "darwin"* ]]; then
  open "http://localhost:$PORT"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  xdg-open "http://localhost:$PORT" 2>/dev/null || true
fi

echo "   Press Ctrl+C to stop"
echo ""

# Forward signals and wait
trap "kill $SERVER_PID 2>/dev/null; exit 0" INT TERM
wait $SERVER_PID
