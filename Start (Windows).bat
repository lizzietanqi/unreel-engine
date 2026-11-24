@echo off
cd /d "%~dp0"
where python >nul 2>nul || (echo Python is needed. Install it from https://www.python.org/downloads/ and tick "Add to PATH". & pause & exit /b)
if not exist ".venv" (
  echo First time setup, installing...
  python -m venv .venv
  .venv\Scripts\pip install --upgrade pip -q
  .venv\Scripts\pip install -r requirements.txt -q
)
.venv\Scripts\pip install -U yt-dlp -q
echo Unreel Engine is running. Keep this window open.
.venv\Scripts\python app.py
