#!/usr/bin/env bash
# claude-opencode-proxy installer.
#
#   curl -fsSL https://raw.githubusercontent.com/schiz0x00/claude-opencode-proxy/main/install.sh | bash
#
# Installs Docker (if missing), pulls the published container, runs it, and
# wires up a `claude-oc` shell function for bash and zsh.
#
# Everything is idempotent: re-running upgrades the image, recreates the
# container, and rewrites the managed block in your shell rc files.

set -euo pipefail

IMAGE="${COP_IMAGE:-ghcr.io/schiz0x00/claude-opencode-proxy:latest}"
CONTAINER="${COP_CONTAINER:-claude-opencode-proxy}"
PORT="${COP_PORT:-8787}"
MODEL="${COP_MODEL:-deepseek-v4-flash-free}"
CONTEXT="${COP_CONTEXT:-200000}"
HOME_DIR="${HOME}/.claude-opencode-proxy"
ENV_FILE="${HOME_DIR}/env.sh"
BEGIN_MARK="# >>> claude-opencode-proxy >>>"
END_MARK="# <<< claude-opencode-proxy <<<"

# Backend selection: a key implies a paid lane, otherwise the free lane.
BACKEND="${OPENCODE_BACKEND:-}"
ZEN_KEY="${OPENCODE_ZEN_API_KEY:-}"
GO_KEY="${OPENCODE_GO_API_KEY:-}"

ASSUME_YES=0
SKIP_DOCKER_INSTALL=0
DRY_RUN=0
UNINSTALL=0

# --- output ------------------------------------------------------------------

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; N=""
fi

say()  { printf '%s==>%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s warn%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%serror%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

usage() {
  cat <<EOF
${B}claude-opencode-proxy installer${N}

Usage: install.sh [options]

  --port <n>        Host port for the proxy (default: ${PORT})
  --model <id>      Default model for the shell function (default: ${MODEL})
  --backend <b>     zen | go | free (default: auto — key present means paid)
  --zen-key <k>     OpenCode Zen API key (implies --backend zen)
  --go-key <k>      OpenCode Go API key (implies --backend go)
  --image <ref>     Container image (default: ${IMAGE})
  --uninstall       Remove the container, the env file, and the rc blocks
  --skip-docker     Never try to install Docker; fail if it is missing
  --dry-run         Print what would happen, change nothing
  -y, --yes         Do not prompt (required for unattended Docker install)
  -h, --help        This message

Environment equivalents: COP_PORT, COP_MODEL, COP_IMAGE, COP_CONTAINER,
COP_CONTEXT, OPENCODE_BACKEND, OPENCODE_ZEN_API_KEY, OPENCODE_GO_API_KEY.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)      PORT="${2:?--port needs a value}"; shift 2 ;;
    --model)     MODEL="${2:?--model needs a value}"; shift 2 ;;
    --backend)   BACKEND="${2:?--backend needs a value}"; shift 2 ;;
    --zen-key)   ZEN_KEY="${2:?--zen-key needs a value}"; BACKEND="${BACKEND:-zen}"; shift 2 ;;
    --go-key)    GO_KEY="${2:?--go-key needs a value}"; BACKEND="${BACKEND:-go}"; shift 2 ;;
    --image)     IMAGE="${2:?--image needs a value}"; shift 2 ;;
    --container) CONTAINER="${2:?--container needs a value}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --skip-docker) SKIP_DOCKER_INSTALL=1; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -y|--yes)    ASSUME_YES=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "unknown option: $1 (try --help)" ;;
  esac
done

if [ -z "$BACKEND" ]; then
  if [ -n "$GO_KEY" ]; then BACKEND="go"
  elif [ -n "$ZEN_KEY" ]; then BACKEND="zen"
  else BACKEND="free"; fi
fi

# Piped into bash (`curl ... | bash`) there is no stdin to prompt on, so read
# answers from the terminal directly when one exists.
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  local reply=""
  if [ -r /dev/tty ]; then
    printf '%s [y/N] ' "$1" > /dev/tty
    read -r reply < /dev/tty || reply=""
  else
    return 1
  fi
  case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# --- docker ------------------------------------------------------------------

SUDO=""
need_sudo() {
  if [ "$(id -u)" = 0 ]; then SUDO=""; return 0; fi
  command -v sudo >/dev/null 2>&1 || die "need root or sudo for this step"
  SUDO="sudo"
}

install_docker_linux() {
  say "installing Docker via the official convenience script (get.docker.com)"
  need_sudo
  local tmp
  tmp="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$tmp" || die "could not download the Docker install script"
  run $SUDO sh "$tmp"
  rm -f "$tmp"
  # systemd hosts need the daemon enabled; containers/WSL without systemd do not.
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    run $SUDO systemctl enable --now docker || warn "could not enable the docker service"
  fi
  if [ "$(id -u)" != 0 ]; then
    run $SUDO usermod -aG docker "$USER" || warn "could not add $USER to the docker group"
    warn "added $USER to the 'docker' group — log out and back in for it to apply"
    warn "this run will keep using sudo for docker commands"
  fi
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    say "Docker found: $(docker --version 2>/dev/null || echo unknown)"
  else
    [ "$SKIP_DOCKER_INSTALL" = 1 ] && die "Docker is not installed (--skip-docker was given)"
    case "$(uname -s)" in
      Linux)
        confirm "Docker is not installed. Install it now (runs get.docker.com with sudo)?" \
          || die "Docker is required — install it and re-run"
        install_docker_linux
        ;;
      Darwin)
        die "Docker is not installed. On macOS install Docker Desktop first:
  brew install --cask docker    (then launch Docker.app)
Re-run this installer afterwards."
        ;;
      *)
        die "unsupported platform $(uname -s) — install Docker manually and re-run"
        ;;
    esac
  fi

  # The daemon must actually answer, and we may need sudo to reach its socket.
  if ! docker info >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
      SUDO="sudo"
      warn "using sudo for docker (your user is not in the 'docker' group yet)"
    elif [ "$DRY_RUN" = 1 ]; then
      warn "docker daemon not reachable (ignored for --dry-run)"
    else
      die "the Docker daemon is not reachable. Start it (e.g. 'sudo systemctl start docker'),
or if you were just added to the 'docker' group, log out and back in."
    fi
  fi
}

DOCKER() { run $SUDO docker "$@"; }

# --- container ---------------------------------------------------------------

start_container() {
  say "pulling ${IMAGE}"
  DOCKER pull "$IMAGE" || die "could not pull ${IMAGE}"

  # Only ever touch a container with our own name.
  if [ "$DRY_RUN" != 1 ] && $SUDO docker inspect "$CONTAINER" >/dev/null 2>&1; then
    say "replacing the existing '${CONTAINER}' container"
    DOCKER rm -f "$CONTAINER" >/dev/null
  fi

  local args=(
    run -d
    --name "$CONTAINER"
    --restart unless-stopped
    -p "127.0.0.1:${PORT}:8787"
    -e "OPENCODE_BACKEND=${BACKEND}"
  )
  [ -n "$ZEN_KEY" ] && args+=(-e "OPENCODE_ZEN_API_KEY=${ZEN_KEY}")
  [ -n "$GO_KEY" ] && args+=(-e "OPENCODE_GO_API_KEY=${GO_KEY}")
  args+=("$IMAGE")

  say "starting '${CONTAINER}' on 127.0.0.1:${PORT} (backend: ${BACKEND})"
  DOCKER "${args[@]}" >/dev/null || die "could not start the container"

  [ "$DRY_RUN" = 1 ] && return 0

  # Wait for the model registry to come up rather than declaring success early.
  local _attempt
  for _attempt in $(seq 1 30); do
    if curl -fsS -m 2 "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
      local count
      count="$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/v1/models" \
        | tr ',' '\n' | grep -c '"object":"model"' || true)"
      say "proxy is up — ${count:-?} models available"
      return 0
    fi
    sleep 1
  done
  warn "the container started but did not answer on port ${PORT} within 30s"
  warn "check it with: docker logs ${CONTAINER}"
}

# --- shell integration -------------------------------------------------------

write_env_file() {
  say "writing ${ENV_FILE}"
  [ "$DRY_RUN" = 1 ] && return 0
  mkdir -p "$HOME_DIR"
  cat > "$ENV_FILE" <<EOF
# claude-opencode-proxy shell integration — managed by install.sh, edits will
# be overwritten. Works in both bash and zsh.

export CLAUDE_OC_PORT="\${CLAUDE_OC_PORT:-${PORT}}"
export CLAUDE_OC_MODEL="\${CLAUDE_OC_MODEL:-${MODEL}}"
export CLAUDE_OC_CONTEXT="\${CLAUDE_OC_CONTEXT:-${CONTEXT}}"

# zsh expands an alias of the same name while parsing a function definition,
# which is a parse error. Drop any stale alias first.
unalias claude-oc 2>/dev/null || true

# Run Claude Code against the local proxy.
#   claude-oc                       interactive
#   claude-oc -p "hi"               one-shot
#   CLAUDE_OC_MODEL=glm-5-free claude-oc
claude-oc() {
  local model="\${CLAUDE_OC_MODEL}"
  # ANTHROPIC_AUTH_TOKEN must be set even on the free lane: without a
  # credential Claude Code uses its own login and skips gateway discovery.
  # The DEFAULT_*/SMALL_FAST vars keep background calls (titles, summaries)
  # on a model the proxy serves — otherwise they go out as claude-sonnet-*
  # or claude-3-5-haiku and 404.
  ANTHROPIC_BASE_URL="http://127.0.0.1:\${CLAUDE_OC_PORT}" \\
  ANTHROPIC_AUTH_TOKEN="\${OPENCODE_ZEN_API_KEY:-\${OPENCODE_GO_API_KEY:-opencode-free}}" \\
  ANTHROPIC_MODEL="\$model" \\
  ANTHROPIC_SMALL_FAST_MODEL="\$model" \\
  ANTHROPIC_DEFAULT_HAIKU_MODEL="\$model" \\
  ANTHROPIC_DEFAULT_SONNET_MODEL="\$model" \\
  ANTHROPIC_DEFAULT_OPUS_MODEL="\$model" \\
  ANTHROPIC_DEFAULT_FABLE_MODEL="\$model" \\
  CLAUDE_CODE_MAX_CONTEXT_TOKENS="\${CLAUDE_OC_CONTEXT}" \\
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \\
  claude "\$@"
}

# List the models the proxy is serving.
claude-oc-models() {
  curl -fsS "http://127.0.0.1:\${CLAUDE_OC_PORT}/v1/models" \\
    | tr '{' '\\n' | sed -n 's/.*"id":"\\([^"]*\\)".*"display_name":"\\([^"]*\\)".*/\\2\\t\\1/p'
}

# Container controls.
claude-oc-logs()    { docker logs -f ${CONTAINER}; }
claude-oc-restart() { docker restart ${CONTAINER}; }
claude-oc-stop()    { docker stop ${CONTAINER}; }
claude-oc-start()   { docker start ${CONTAINER}; }
claude-oc-update()  {
  docker pull ${IMAGE} && docker rm -f ${CONTAINER} >/dev/null 2>&1
  docker run -d --name ${CONTAINER} --restart unless-stopped \\
    -p 127.0.0.1:\${CLAUDE_OC_PORT}:8787 -e OPENCODE_BACKEND=${BACKEND} ${IMAGE}
}
EOF
  chmod 600 "$ENV_FILE"
}

# Replace the managed block in an rc file, or append it if absent. Never
# touches anything outside the markers.
wire_rc() {
  local rc="$1"
  [ -e "$rc" ] || { [ "$DRY_RUN" = 1 ] && return 0; touch "$rc"; }

  if [ "$DRY_RUN" = 1 ]; then
    say "would wire ${rc}"
    return 0
  fi

  if grep -qF "$BEGIN_MARK" "$rc" 2>/dev/null; then
    local tmp
    tmp="$(mktemp)"
    # Drop the old managed block, keep everything else byte-for-byte.
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
      index($0, b) { skip = 1 }
      !skip        { print }
      index($0, e) { skip = 0 }
    ' "$rc" > "$tmp"
    cat "$tmp" > "$rc"
    rm -f "$tmp"
  fi

  {
    printf '%s\n' "$BEGIN_MARK"
    printf '[ -f "%s" ] && . "%s"\n' "$ENV_FILE" "$ENV_FILE"
    printf '%s\n' "$END_MARK"
  } >> "$rc"
  say "wired ${rc}"
}

wire_shells() {
  local wired=0
  # bash reads .bash_profile (login) or .bashrc (interactive); on macOS the
  # login file is the one that matters, so wire whichever already exist.
  for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc"; do
    if [ -e "$rc" ]; then wire_rc "$rc"; wired=1; fi
  done
  if [ "$wired" = 0 ]; then
    # No rc file at all: create the one matching the login shell.
    case "${SHELL:-}" in
      *zsh)  wire_rc "$HOME/.zshrc" ;;
      *)     wire_rc "$HOME/.bashrc" ;;
    esac
  fi
}

# --- main --------------------------------------------------------------------

printf '%s\n' "${B}claude-opencode-proxy installer${N}"
[ "$DRY_RUN" = 1 ] && warn "dry run — nothing will be changed"

if [ "$UNINSTALL" = 1 ]; then
  if command -v docker >/dev/null 2>&1; then
    docker info >/dev/null 2>&1 || SUDO="sudo"
    if $SUDO docker inspect "$CONTAINER" >/dev/null 2>&1; then
      say "removing container ${CONTAINER}"
      DOCKER rm -f "$CONTAINER" >/dev/null
    fi
  fi
  for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc"; do
    [ -e "$rc" ] || continue
    grep -qF "$BEGIN_MARK" "$rc" 2>/dev/null || continue
    if [ "$DRY_RUN" = 1 ]; then say "would unwire ${rc}"; continue; fi
    tmp="$(mktemp)"
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
      index($0, b) { skip = 1 }
      !skip        { print }
      index($0, e) { skip = 0 }
    ' "$rc" > "$tmp"
    cat "$tmp" > "$rc"
    rm -f "$tmp"
    say "unwired ${rc}"
  done
  run rm -f "$ENV_FILE"
  say "done — the image and ~/.claude-opencode-proxy/models.json were left in place"
  exit 0
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
ensure_docker
start_container
write_env_file
wire_shells

cat <<EOF

${G}Done.${N}

  Proxy:     http://127.0.0.1:${PORT}   (backend: ${BACKEND})
  Container: ${CONTAINER}  (restarts with Docker)
  Model:     ${MODEL}

Start a new shell (or: ${B}. ${ENV_FILE}${N}), then:

  ${B}claude-oc${N}                 Claude Code through the proxy
  ${B}claude-oc-models${N}          list available models
  ${B}claude-oc-logs${N}            follow container logs
  ${B}claude-oc-update${N}          pull the latest image and recreate

Pick a model inside Claude Code with ${B}/model${N} — proxy models appear
under "From gateway".
EOF
