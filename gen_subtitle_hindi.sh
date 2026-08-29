#!/bin/bash

# Check argument
if [ -z "$1" ]; then
    echo "Usage: ./gen_subtitle.sh <video_file>"
    exit 1
fi

VIDEO="$1"
BASENAME=$(basename "$VIDEO")
NAME="${BASENAME%.*}"

WAV_FILE="/tmp/${NAME}.wav"
OUTPUT_FILE="${PWD}/${NAME}"

# Edit these two lines to match YOUR system (or set via env: WHISPER_MODEL, WHISPER_BIN)
MODEL="${WHISPER_MODEL:-/root/models/ggml-base.bin}"
WHISPER="${WHISPER_BIN:-/root/binary/whisper-cli}"

echo "Converting video to WAV..."
ffmpeg -loglevel error -i "$VIDEO" -ar 16000 -ac 1 -c:a pcm_s16le "$WAV_FILE"

if [ ! -f "$WAV_FILE" ]; then
    echo "WAV conversion failed"
    exit 1
fi

echo "Generating Hindi subtitles..."
# Added -l hi to force Hindi transcription
$WHISPER -t 1 -p 1 -m "$MODEL" -f "$WAV_FILE" -osrt -of "$OUTPUT_FILE" -l hi

if [ -f "${OUTPUT_FILE}.srt" ]; then
    echo "Subtitle created: ${OUTPUT_FILE}.srt"
else
    echo "Subtitle generation failed"
fi

echo "Cleaning temporary files..."
rm -f "$WAV_FILE"

echo "Done."
