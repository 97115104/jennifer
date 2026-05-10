#!/usr/bin/env bash
# Jennifer — Dependency Installer
# Run once before deploy-locally.sh

set -euo pipefail
JENNIFER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

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

# Install one or more packages using the distro's package manager.
# Usage: pkg_install <pkg> [<pkg> ...]
pkg_install() {
  case "$DISTRO" in
    arch)    sudo pacman -S --noconfirm --needed "$@" ;;
    debian)  sudo apt-get install -y "$@" ;;
    *)       warn "Cannot auto-install packages on $DISTRO — install manually: $*" ;;
  esac
}

echo ""
echo "  ╔══════════════════════════════╗"
echo "  ║   Jennifer — Installer       ║"
echo "  ╚══════════════════════════════╝"
echo ""

# ─── OS / distro detection ───────────────────────────────────────────────────
OS=""
DISTRO=""
if [[ "$OSTYPE" == "darwin"* ]]; then
  OS="mac"
  DISTRO="mac"
elif [[ "$OSTYPE" == "linux-gnu"* || "$OSTYPE" == "linux-musl"* ]]; then
  OS="linux"
  if [ -f /etc/os-release ]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    case "${ID:-}" in
      arch|manjaro|endeavouros|garuda) DISTRO="arch" ;;
      ubuntu|debian|linuxmint|pop|raspbian|kali) DISTRO="debian" ;;
      *)
        case "${ID_LIKE:-}" in
          *arch*)            DISTRO="arch" ;;
          *debian*|*ubuntu*) DISTRO="debian" ;;
          *)                 DISTRO="unknown" ;;
        esac
        ;;
    esac
  else
    DISTRO="unknown"
  fi
else
  warn "Unknown OS: $OSTYPE — proceeding anyway"
  OS="unknown"
  DISTRO="unknown"
fi

DISTRO_LABEL="$DISTRO"
[[ "$DISTRO" == "debian" && -f /etc/os-release ]] && {
  # shellcheck source=/dev/null
  . /etc/os-release 2>/dev/null || true
  DISTRO_LABEL="${PRETTY_NAME:-debian}"
}

info "Detected OS: $OS  |  Distro: $DISTRO_LABEL"
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
  if [[ "$OS" == "mac" ]]; then
    brew install node
  elif [[ "$DISTRO" == "arch" ]]; then
    pkg_install nodejs npm
  elif [[ "$DISTRO" == "debian" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    err "Install Node.js 22.5+ from https://nodejs.org and re-run"
  fi
fi
NODE_VERSION=$(node -e "process.stdout.write(process.versions.node)")
NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
NODE_MINOR=$(node -e "process.stdout.write(process.versions.node.split('.')[1])")
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  err "Node.js v22.5+ required (found v${NODE_VERSION}). Install with: nvm install 22 && nvm use 22"
fi
ok "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
  err "npm not found. Reinstall Node.js 22.5+ with npm included, then re-run."
fi
ok "npm $(npm --version)"

# ─── ffmpeg ──────────────────────────────────────────────────────────────────
if ! command -v ffmpeg &>/dev/null; then
  info "Installing ffmpeg..."
  if [[ "$OS" == "mac" ]]; then
    brew install ffmpeg
  elif [[ "$DISTRO" == "arch" ]]; then
    pkg_install ffmpeg
  elif [[ "$DISTRO" == "debian" ]]; then
    sudo apt-get update && sudo apt-get install -y ffmpeg
  else
    err "Install ffmpeg from https://ffmpeg.org/download.html and re-run"
  fi
fi
ok "ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"

# ─── espeak-ng (Linux system TTS) ────────────────────────────────────────────
if [[ "$OS" == "linux" ]]; then
  if ! command -v espeak-ng &>/dev/null && ! command -v espeak &>/dev/null; then
    info "Installing espeak-ng (system TTS for Linux)..."
    pkg_install espeak-ng
    ok "espeak-ng $(espeak-ng --version 2>&1 | head -1)"
  else
    ok "System TTS: $(command -v espeak-ng 2>/dev/null || command -v espeak)"
  fi
fi

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
# TTS provider: system (macOS say / Linux espeak-ng) | 429 (429 Inference voice)
TTS_PROVIDER=system

# Optional 429 Inference voice key. If omitted, the app can reuse 429-API-KEY.
# 429-VOICE-API-KEY=

# OAuth credentials (configure in /settings after starting)
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
ENVEOF
  ok ".env created"
else
  ok ".env already exists"
fi

info "AI and voice provider API keys are configured in the Settings UI (/settings)."
info "The local database (data/jennifer.db) is created automatically on first start."

info "Local voice server setup is no longer required. Use system voice or 429 Inference voice in /settings."

# ─── Whisper model pre-download ──────────────────────────────────────────────
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
echo "  1. Run: ./scripts/deploy-locally.sh"
echo "  2. Open /settings to configure your AI provider and API keys"
echo ""
