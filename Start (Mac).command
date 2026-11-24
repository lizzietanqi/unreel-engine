#!/bin/bash
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is needed. Install it from https://www.python.org/downloads/ then run this again."
  read -p "Press Enter to close"; exit 1
fi
if [ ! -d ".venv" ]; then
  echo "First time setup, installing (takes a minute)..."
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip -q
  ./.venv/bin/pip install -r requirements.txt -q
fi
./.venv/bin/pip install -U yt-dlp -q
echo "Unreel Engine is running. Keep this window open. Close it to stop."
./.venv/bin/python app.py
