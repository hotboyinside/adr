#!/usr/bin/env bash
# scripts/download-model.sh
# Downloads all runtime dependencies that are too large or platform-specific
# to be committed to git:
#   1. ggml-base.en.bin  — Whisper model         (~150 MB, models/)
#   2. silero_vad.onnx   — Silero VAD model       (~1 MB,  models/)
#   3. ONNX Runtime      — prebuilt C++ runtime   (~10 MB, sidecar/vendor/onnxruntime/)
#
# Usage:
#   bash scripts/download-model.sh              # whisper model = base.en (default)
#   bash scripts/download-model.sh small.en     # alternative whisper model
#
# See Issues 06, 07 and ADR-001.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS_DIR="${REPO_ROOT}/models"
ORT_VENDOR="${REPO_ROOT}/sidecar/vendor/onnxruntime"

# ── 1. Whisper model ─────────────────────────────────────────────────────────

WHISPER_MODEL="${1:-base.en}"
WHISPER_FILE="ggml-${WHISPER_MODEL}.bin"
WHISPER_DEST="${MODELS_DIR}/${WHISPER_FILE}"
WHISPER_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_FILE}"

mkdir -p "${MODELS_DIR}"

if [ -f "${WHISPER_DEST}" ]; then
  echo "[whisper] Already present: ${WHISPER_DEST}"
else
  echo "[whisper] Downloading ${WHISPER_FILE}..."
  curl -L --progress-bar -o "${WHISPER_DEST}" "${WHISPER_URL}"
  echo "[whisper] Done: ${WHISPER_DEST}"
fi

# ── 2. Silero VAD model ──────────────────────────────────────────────────────

VAD_DEST="${MODELS_DIR}/silero_vad.onnx"
# Pinned to v4.0 release for a stable interface matching SileroVAD.cpp
VAD_URL="https://github.com/snakers4/silero-vad/raw/v4.0/files/silero_vad.onnx"

if [ -f "${VAD_DEST}" ]; then
  echo "[silero-vad] Already present: ${VAD_DEST}"
else
  echo "[silero-vad] Downloading silero_vad.onnx..."
  curl -L --progress-bar -o "${VAD_DEST}" "${VAD_URL}"
  echo "[silero-vad] Done: ${VAD_DEST}"
fi

# ── 3. ONNX Runtime prebuilt binaries ────────────────────────────────────────

ORT_VERSION="1.20.1"

# Detect host platform and architecture
OS="$(uname -s)"
ARCH="$(uname -m)"

if [ "${OS}" = "Darwin" ]; then
  # On macOS: download native-arch prebuilt (universal binary via lipo is deferred)
  if [ "${ARCH}" = "arm64" ]; then
    ORT_ARTIFACT="onnxruntime-osx-arm64-${ORT_VERSION}"
  else
    ORT_ARTIFACT="onnxruntime-osx-x86_64-${ORT_VERSION}"
  fi
  ORT_EXT="tgz"
  ORT_LIB_FILE="libonnxruntime.${ORT_VERSION}.dylib"
  ORT_LIB_LINK="libonnxruntime.dylib"
elif [ "${OS}" = "Linux" ]; then
  # Linux CI runner (Issue 04) — used for the VAD build step only
  ORT_ARTIFACT="onnxruntime-linux-x64-${ORT_VERSION}"
  ORT_EXT="tgz"
  ORT_LIB_FILE="libonnxruntime.so.${ORT_VERSION}"
  ORT_LIB_LINK="libonnxruntime.so"
else
  # Assume Windows (MINGW/MSYS/Git Bash)
  ORT_ARTIFACT="onnxruntime-win-x64-${ORT_VERSION}"
  ORT_EXT="zip"
  ORT_LIB_FILE="onnxruntime.dll"
  ORT_LIB_LINK=""
fi

ORT_URL="https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/${ORT_ARTIFACT}.${ORT_EXT}"

if [ -f "${ORT_VENDOR}/include/onnxruntime_cxx_api.h" ]; then
  echo "[onnxruntime] Already present: ${ORT_VENDOR}"
else
  echo "[onnxruntime] Downloading ONNX Runtime v${ORT_VERSION} (${ORT_ARTIFACT})..."
  TMP_DIR="$(mktemp -d)"
  ARCHIVE="${TMP_DIR}/${ORT_ARTIFACT}.${ORT_EXT}"

  curl -L --progress-bar -o "${ARCHIVE}" "${ORT_URL}"

  echo "[onnxruntime] Extracting..."
  mkdir -p "${ORT_VENDOR}"

  if [ "${ORT_EXT}" = "tgz" ]; then
    tar -xzf "${ARCHIVE}" -C "${TMP_DIR}"
    EXTRACTED="${TMP_DIR}/${ORT_ARTIFACT}"
    cp -r "${EXTRACTED}/include" "${ORT_VENDOR}/"
    mkdir -p "${ORT_VENDOR}/lib"
    cp "${EXTRACTED}/lib/${ORT_LIB_FILE}" "${ORT_VENDOR}/lib/"
    if [ -n "${ORT_LIB_LINK}" ] && [ "${ORT_LIB_FILE}" != "${ORT_LIB_LINK}" ]; then
      ln -sf "${ORT_LIB_FILE}" "${ORT_VENDOR}/lib/${ORT_LIB_LINK}"
    fi
  else
    # zip (Windows)
    unzip -q "${ARCHIVE}" -d "${TMP_DIR}"
    EXTRACTED="${TMP_DIR}/${ORT_ARTIFACT}"
    cp -r "${EXTRACTED}/include" "${ORT_VENDOR}/"
    mkdir -p "${ORT_VENDOR}/lib"
    cp "${EXTRACTED}/lib/onnxruntime.dll"  "${ORT_VENDOR}/lib/"
    cp "${EXTRACTED}/lib/onnxruntime.lib"  "${ORT_VENDOR}/lib/"
  fi

  rm -rf "${TMP_DIR}"
  echo "[onnxruntime] Done: ${ORT_VENDOR}"
fi

echo ""
echo "All dependencies are ready."
echo "  Whisper model : ${WHISPER_DEST}"
echo "  Silero VAD    : ${VAD_DEST}"
echo "  ONNX Runtime  : ${ORT_VENDOR}"
