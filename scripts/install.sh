#!/usr/bin/env bash
# Jennifer — Dependency Installer
# Run this once before deploy-locally.sh

set -euo pipefail
JENNIFER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅  $*${NC}"; }
warn() { echo -e "${YELLOW}⚠   $*${NC}"; }
err()  { echo -e "${RED}❌  $*${NC}"; exit 1; }
info() { echo -e "${BLUE}ℹ   $*${NC}"; }

echo ""
echo "  ╔══════════════════════════════╗"
echo "  ║   Jennifer — Installer       ║"
echo "  ╚══════════════════════════════╝"
echo ""

OS=""
if [[ "$OSTYPE" == "darwin"* ]]; then OS="mac"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then OS="linux"
elif [[ "$OSTYPE" == "msys"* || "$OSTYPE" == "cygwin"* ]]; then OS="windows"
else warn "Unknown OS: $OSTYPE — proceeding anyway"; OS="unknown"; fi

info "Detected OS: $OS"
echo ""

# ─── Homebrew (macOS only) ────────────────────────────────────────────────────
if [[ "$OS" == "mac" ]]; then
  if ! command -v brew &>/dev/null; then
    info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    ok "Homebrew installed"
  else
    ok "Homebrew found: $(brew --version | head -1)"
  fi
fi

# ─── Node.js ──────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  info "Node.js not found. Installing..."
  if [[ "$OS" == "mac" ]]; then
    brew install node
  elif [[ "$OS" == "linux" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    err "Install Node.js 18+ from https://nodejs.org and re-run"
  fi
fi

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js v18+ required (found v$(node --version)). Update at https://nodejs.org"
fi
ok "Node.js $(node --version)"

# ─── npm ──────────────────────────────────────────────────────────────────────
ok "npm $(npm --version)"

# ─── ffmpeg ───────────────────────────────────────────────────────────────────
if ! command -v ffmpeg &>/dev/null; then
  info "Installing ffmpeg..."
  if [[ "$OS" == "mac" ]]; then
    brew install ffmpeg
  elif [[ "$OS" == "linux" ]]; then
    sudo apt-get update && sudo apt-get install -y ffmpeg
  else
    err "Install ffmpeg from https://ffmpeg.org/download.html and re-run"
  fi
fi
ok "ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"

# ─── Python (optional — for Coqui TTS / voice cloning) ───────────────────────
echo ""
info "Checking optional dependencies..."

PYTHON_OK=false
for py in python3 python; do
  if command -v "$py" &>/dev/null; then
    PY_VER=$($py --version 2>&1 | awk '{print $2}')
    PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
    PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
    if [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -ge 9 ] && [ "$PY_MINOR" -le 11 ]; then
      ok "Python $PY_VER (voice cloning compatible)"
      PYTHON_OK=true
      PYTHON_CMD="$py"
      break
    fi
  fi
done

if [ "$PYTHON_OK" = false ]; then
  warn "Python 3.9–3.11 not found. Voice cloning (Coqui XTTS v2) requires it."
  warn "Install from https://python.org or via pyenv"
fi

# ─── npm install ──────────────────────────────────────────────────────────────
echo ""
info "Installing Node.js dependencies..."
cd "$JENNIFER_ROOT"
npm install
ok "Node.js packages installed"

# ─── .env setup ───────────────────────────────────────────────────────────────
if [ ! -f "$JENNIFER_ROOT/.env" ]; then
  info "Creating .env from template..."
  cat > "$JENNIFER_ROOT/.env" <<'ENVEOF'
# 429 Inference API key — get yours at https://429inference.com
429-API-KEY=your_key_here

# TTS provider: system (default) | coqui (voice cloning)
TTS_PROVIDER=system

# Coqui XTTS v2 settings (only needed if TTS_PROVIDER=coqui)
# COQUI_URL=http://localhost:5123
# COQUI_SPEAKER_WAV=/path/to/your/voice_sample.wav

# SMTP for email tool (optional)
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=587
# SMTP_USER=you@gmail.com
# SMTP_PASS=your_app_password
# SMTP_FROM=you@gmail.com

# Server port (default: 3000)
# PORT=3000
ENVEOF
  ok ".env created — add your 429-API-KEY before starting"
else
  ok ".env already exists"
fi

# ─── Whisper model pre-download (optional) ────────────────────────────────────
echo ""
read -r -p "Pre-download Whisper model now? (~150MB, speeds up first query) [y/N] " DOWNLOAD_WHISPER
if [[ "${DOWNLOAD_WHISPER,,}" == "y" ]]; then
  info "Downloading Xenova/whisper-base.en model..."
  node -e "
(async () => {
  const { pipeline } = await import('@xenova/transformers');
  await pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', { quantized: true });
  console.log('Model downloaded successfully');
})().catch(e => { console.error('Download failed:', e.message); process.exit(1); });
"
  ok "Whisper model ready"
fi

# ─── Voice cloning setup (optional) ──────────────────────────────────────────
echo ""
if [ "$PYTHON_OK" = true ]; then
  read -r -p "Set up Coqui XTTS v2 voice cloning? (clones github.com/97115104/myvoice) [y/N] " SETUP_COQUI
  if [[ "${SETUP_COQUI,,}" == "y" ]]; then
    MYVOICE_DIR="$JENNIFER_ROOT/../myvoice"
    if [ -d "$MYVOICE_DIR" ]; then
      info "Found myvoice at $MYVOICE_DIR — running setup..."
      cd "$MYVOICE_DIR" && bash setup.sh
      ok "Coqui TTS ready. Set TTS_PROVIDER=coqui in .env to activate."
    else
      warn "myvoice not found at $MYVOICE_DIR"
      warn "Clone it: git clone https://github.com/97115104/myvoice $MYVOICE_DIR"
    fi
  fi
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Jennifer installation complete!         ${NC}"
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo ""
echo "  Next steps:"
echo "  1. Add your 429-API-KEY to .env"
echo "  2. Run: ./scripts/deploy-locally.sh"
echo ""
