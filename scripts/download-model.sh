#!/usr/bin/env bash
# scripts/download-model.sh
# Downloads the ggml-base.en.bin Whisper model to models/
# Usage: bash scripts/download-model.sh [model-name]
# Default model: base.en (~150 MB)
# See Issue 06 and ADR-001 Section 4.

set -euo pipefail

MODELS_DIR="$(cd "$(dirname "$0")/.." && pwd)/models"
MODEL="${1:-base.en}"
FILENAME="ggml-${MODEL}.bin"
DEST="${MODELS_DIR}/${FILENAME}"

BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

mkdir -p "${MODELS_DIR}"

if [ -f "${DEST}" ]; then
  echo "Model already exists: ${DEST}"
  exit 0
fi

echo "Downloading ${FILENAME} to ${MODELS_DIR}..."
curl -L --progress-bar -o "${DEST}" "${BASE_URL}/${FILENAME}"
echo "Done: ${DEST}"
