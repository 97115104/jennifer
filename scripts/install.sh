#!/usr/bin/env bash
# Jennifer — Dependency Installer
# Run once before deploy-locally.sh

set -euo pipefail
JENNIFER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TTS_DIR="$JENNIFER_ROOT/tts"
VENV_DIR="$TTS_DIR/.venv"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅  $*${NC}"; }
warn() { echo -e "${YELLOW}⚠   $*${NC}"; }
err()  { echo -e "${RED}❌  $*${NC}"; exit 1; }
info() { echo -e "${BLUE}ℹ   $*${NC}"; }

prompt_reply() {
  local prompt="$1"
  local result_var="$2"
  local reply

  read -r -p "$prompt" reply || reply=""
  printf -v "$result_var" '%s' "$reply"
}

no_reply() {
  # Returns 0 (true) if reply is y/Y/yes/YES (no default — user must type y)
  case "${1:-n}" in [Yy]|[Yy][Ee][Ss]) return 0;; *) return 1;; esac
}

ensure_homebrew_path() {
  if command -v brew &>/dev/null; then
    return 0
  fi

  for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$brew_bin" ]; then
      export PATH="$(dirname "$brew_bin"):$PATH"
      return 0
    fi
  done

  return 1
}

set_env_value() {
  local key="$1"
  local value="$2"
  local env_file="$JENNIFER_ROOT/.env"
  local tmp

  tmp="$(mktemp "$JENNIFER_ROOT/.env.tmp.XXXXXX")"
  if awk -v key="$key" -v value="$value" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      if (!replaced) {
        print key "=" value
        replaced = 1
      }
      next
    }
    { print }
    END {
      if (!replaced) {
        print key "=" value
      }
    }
  ' "$env_file" > "$tmp"; then
    mv "$tmp" "$env_file"
  else
    rm -f "$tmp"
    return 1
  fi
}

echo ""
echo "  ╔══════════════════════════════╗"
echo "  ║   Jennifer — Installer       ║"
echo "  ╚══════════════════════════════╝"
echo ""

OS=""
if [[ "$OSTYPE" == "darwin"* ]]; then OS="mac"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then OS="linux"
else warn "Unknown OS: $OSTYPE — proceeding anyway"; OS="unknown"; fi

info "Detected OS: $OS"
echo ""

# ─── Homebrew (macOS only) ───────────────────────────────────────────────────
if [[ "$OS" == "mac" ]]; then
  ensure_homebrew_path || true
  if ! command -v brew &>/dev/null; then
    info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    ensure_homebrew_path || err "Homebrew installed, but brew was not found on PATH. Restart your shell and re-run this script."
    ok "Homebrew installed"
  else
    ok "Homebrew: $(brew --version | head -1)"
  fi
fi

# ─── Node.js ─────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  info "Installing Node.js..."
  if [[ "$OS" == "mac" ]]; then brew install node
  elif [[ "$OS" == "linux" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    err "Install Node.js 18+ from https://nodejs.org and re-run"
  fi
fi
NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
[ "$NODE_MAJOR" -lt 18 ] && err "Node.js v18+ required (found v$(node --version))"
ok "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
  err "npm not found. Reinstall Node.js 18+ with npm included, then re-run."
fi
ok "npm $(npm --version)"

# ─── ffmpeg ───────────────────────────────────────────────────────────────────
if ! command -v ffmpeg &>/dev/null; then
  info "Installing ffmpeg..."
  if [[ "$OS" == "mac" ]]; then brew install ffmpeg
  elif [[ "$OS" == "linux" ]]; then sudo apt-get update && sudo apt-get install -y ffmpeg
  else err "Install ffmpeg from https://ffmpeg.org/download.html and re-run"
  fi
fi
ok "ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"

# ─── npm install ─────────────────────────────────────────────────────────────
echo ""
info "Installing Node.js packages..."
cd "$JENNIFER_ROOT"
npm install --loglevel=error
ok "Node.js packages installed"

# ─── .env setup ──────────────────────────────────────────────────────────────
if [ ! -f "$JENNIFER_ROOT/.env" ]; then
  info "Creating .env from template..."
  cat > "$JENNIFER_ROOT/.env" <<'ENVEOF'
# 429 Inference API key — get yours at https://429inference.com
429-API-KEY=your_key_here

# TTS provider: system (macOS say) | coqui (voice cloning — run install.sh first)
TTS_PROVIDER=system

# OAuth (configure in /settings after starting)
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
ENVEOF
  ok ".env created — add your 429-API-KEY before starting"
else
  ok ".env already exists"
fi

if ! grep -q "^[[:space:]]*429-API-KEY[[:space:]]*=" "$JENNIFER_ROOT/.env"; then
  warn ".env is missing 429-API-KEY — add it before starting Jennifer"
fi

# ─── Python + Coqui TTS setup ────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────"
info "Voice Cloning Setup (Coqui XTTS v2)"
echo "─────────────────────────────────────────"
echo ""

PYTHON_CMD=""
for py in python3.11 python3.10 python3.9 python3 python; do
  if command -v "$py" &>/dev/null; then
    PY_VER=$($py --version 2>&1 | awk '{print $2}')
    if [[ "$PY_VER" =~ ^([0-9]+)\.([0-9]+) ]]; then
      PY_MAJOR="${BASH_REMATCH[1]}"
      PY_MINOR="${BASH_REMATCH[2]}"
    else
      continue
    fi

    if [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -ge 9 ] && [ "$PY_MINOR" -le 11 ]; then
      PYTHON_CMD="$py"
      ok "Python $PY_VER at $(command -v "$py")"
      break
    fi
  fi
done

if [ -z "$PYTHON_CMD" ]; then
  warn "Python 3.9–3.11 not found — voice cloning requires it"
  warn "Install via homebrew: brew install python@3.11"
  warn "Skipping voice cloning setup."
else
  prompt_reply "Set up voice cloning (Coqui XTTS v2)? Requires ~4GB disk. [y/N] " SETUP_TTS
  if no_reply "$SETUP_TTS"; then
    [ -f "$TTS_DIR/requirements.txt" ] || err "Missing $TTS_DIR/requirements.txt"
    [ -f "$TTS_DIR/server.py" ] || err "Missing $TTS_DIR/server.py"

    if [ ! -d "$VENV_DIR" ]; then
      info "Creating Python venv in tts/.venv..."
      "$PYTHON_CMD" -m venv "$VENV_DIR"
      ok "venv created"
    else
      ok "venv already exists at tts/.venv"
    fi

    info "Upgrading pip..."
    "$VENV_DIR/bin/pip" install --upgrade pip --quiet

    info "Installing TTS packages (torch, Coqui TTS, pydub, flask)..."
    "$VENV_DIR/bin/pip" install -r "$TTS_DIR/requirements.txt"
    ok "TTS packages installed"

    echo ""
    prompt_reply "Pre-download XTTS v2 model now? (~2GB, avoids delay on first start) [y/N] " DOWNLOAD_MODEL
    if no_reply "$DOWNLOAD_MODEL"; then
      info "Downloading XTTS v2 model (may take several minutes)..."
      "$VENV_DIR/bin/python" - <<'PYEOF'
import os
os.environ["COQUI_TOS_AGREED"] = "1"
from TTS.api import TTS
print("Fetching tts_models/multilingual/multi-dataset/xtts_v2 ...")
TTS("tts_models/multilingual/multi-dataset/xtts_v2")
print("Model ready.")
PYEOF
      ok "XTTS v2 model downloaded"
    else
      warn "Model downloads on first use (adds ~2-5 min to first startup)"
    fi

    info "Updating TTS_PROVIDER=coqui in .env..."
    set_env_value TTS_PROVIDER coqui
    ok ".env: TTS_PROVIDER=coqui"

    ok "Voice cloning ready — record a sample in /settings after starting Jennifer."
  else
    info "Skipping voice cloning. Run install.sh again to set it up later."
  fi
fi

# ─── Whisper model pre-download ───────────────────────────────────────────────
echo ""
prompt_reply "Pre-download Whisper STT model? (~150MB, speeds up first query) [y/N] " DL_WHISPER
if no_reply "$DL_WHISPER"; then
  info "Downloading Xenova/whisper-base.en..."
  node -e "
(async () => {
  const { pipeline } = await import('@xenova/transformers');
  await pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', { quantized: true });
  console.log('Whisper model ready');
})().catch(e => { console.error('Download failed:', e.message); process.exit(1); });
"
  ok "Whisper model ready"
fi

echo ""
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Jennifer installation complete!         ${NC}"
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo ""
echo "  Next steps:"
echo "  1. Ensure your 429-API-KEY is in .env"
echo "  2. Run: ./scripts/deploy-locally.sh"
echo ""
