# Unreel Engine: notes for AI helpers

You're helping someone who uses Unreel Engine. They're probably not technical. Talk in plain words, give one step at a time, and tell them exactly what to click or type. When they need to run a command, give the exact command.

## How the app works

- It's a small local web app. `app.py` runs a Flask server at http://127.0.0.1:5055 (or the `PORT` in `.env`). The page is `page.html`, and each page's code is in `static/<page>.js`.
- People start it with **Start (Mac).command** or **Start (Windows).bat**. That makes a `.venv` folder the first time, installs `requirements.txt`, updates yt-dlp, then runs `app.py`. The app reloads itself when a `.py` file changes.
- Downloading reels: yt-dlp, first without a login, then with `cookies.txt` (if there is one), then with the Instagram login from Chrome. Carousels and photo posts go through Instagram's web API with the same login.
- Transcribing: faster-whisper, on the computer. The model is `small` unless `WHISPER_MODEL` says otherwise in `.env`.
- AI: `engine.py`. `AI_ENGINE` in `.env` is `claude` (Claude Code with the person's Claude login), `claude_key` (Anthropic API key, `ANTHROPIC_API_KEY`) or `chatgpt` (Codex with the person's ChatGPT login). The gear at the bottom of the left bar changes it.
- Pages: Studio (`studio.py`, `static/studio.js`), Formats (`formats.json`, `cards.json`, `hooks.json`, `static/formats.js`), Analytics (`analytics.py`, `static/analytics.js`), Context (`contextdoc.py`, `angles.py`, `static/context.js`, `static/angles.js`). Save to Cleve is `cleve.py`.
- The first run copies the sample reels and a blank `context.md` from `starter/`, then writes an empty `.seeded` file so it doesn't do it again.

## Their files

`transcripts/`, `thumbs/`, `breakdowns/`, `studies/`, `analytics/`, `context.md`, `pillars.json`, `angles.json`, `cards.json` and `.env` are theirs. Don't delete or rewrite them unless they ask. Never show the keys in `.env` back to them in full.

## Fixes for common problems

### A reel won't download

Read the error on the page, or in the black window.

- **"Instagram wants you logged in"**: they need to be logged in to instagram.com in Google Chrome. After logging in, try again.
- **A Mac pop-up asks to use "Chrome Safe Storage"**: that's how the app reads the Instagram login from Chrome. Tell them to type their Mac password and click **Always Allow**.
- **"Instagram blocked it even with your login"**: Instagram limits how many downloads it allows. Wait a few minutes, or a day. Suggest a spare Instagram account so their main one never gets limited: log in to it in a separate Chrome profile, then add `IG_CHROME_PROFILE=Profile 2` (the folder name of that profile) to `.env`. To find the folder name, open `chrome://version` in that profile and look at "Profile Path".
- **Windows, and the login isn't picked up**: newer Chrome on Windows locks its cookies so other apps can't read them. Use a cookies.txt file instead: install a browser extension that exports cookies in "Netscape" format, export the cookies for instagram.com while logged in, and save the file as `cookies.txt` in the app's folder.
- **Errors like "Unsupported URL", "Unable to extract" or "HTTP Error 4xx" on reels that open fine in the browser**: the downloader needs an update. Closing the app and starting it again updates it. Or run this in the app's folder:
  - Mac: `.venv/bin/pip install -U yt-dlp`
  - Windows: `.venv\Scripts\pip install -U yt-dlp`
- **Private accounts**: only work if the logged-in account follows them.
- **"This post has no video"**: it's a photo or carousel. Being logged in to Instagram in Chrome lets the app read the slides.

### The app won't start

- **Mac says the start file can't be opened**: System Settings, Privacy & Security, scroll down, **Open Anyway**. Then double-click it again.
- **"Python is needed"**: install Python 3.9 or newer from python.org. On Windows, tick "Add python.exe to PATH" in the installer.
- **Install errors the first time**: delete the `.venv` folder and start again. If it still fails, check `python3 --version` (Mac) or `python --version` (Windows) is 3.9 or newer.
- **"Address already in use"**: something else is using port 5055. Add `PORT=5056` to `.env` and start again.
- **The page shows old buttons after an update**: refresh the page.

### The AI doesn't work

- **"Pick which AI to use first"**: click the gear at the bottom of the left bar.
- **"Claude Code isn't installed" or the chat says it needs Claude Code**: install it from claude.com/claude-code, then open Terminal (Mac) or PowerShell (Windows), type `claude`, press Enter and sign in once. If it's installed but the app can't find it, check `which claude` (Mac) or `where claude` (Windows) prints a path.
- **"Claude Code isn't signed in"**: run `claude` in Terminal and sign in.
- **"Your Claude plan hit its usage limit"** or the same for ChatGPT: wait for the plan to reset, or switch to the API key option with the gear.
- **"Anthropic didn't accept that key"**: make a new key at console.anthropic.com (API keys) and paste the whole thing. Check there's credit under Billing.
- **"Codex isn't installed"**: install Codex from developers.openai.com/codex, then run `codex` in Terminal and pick Sign in with ChatGPT. The app needs a recent Codex (one that has `codex exec --output-schema`). On a Mac, the one inside the ChatGPT desktop app works too. An old one can be updated with `npm install -g @openai/codex@latest` or `brew upgrade codex`, depending on how it was installed.

### Reading on-screen text fails

It needs ffmpeg.
- Mac: install Homebrew from brew.sh, then run `brew install ffmpeg`.
- Windows: run `winget install ffmpeg` in PowerShell.
Then close the app and start it again.

### Analytics

- **Connecting**: they need an Instagram professional account (Creator or Business) and a Meta developer app. The steps are on the Analytics page. The key goes in the box there, and the app saves it to `.env` as `IG_ACCESS_TOKEN`.
- **"Instagram didn't accept that key"**: generate a new token (developers.facebook.com, their app, Instagram use case, API setup with Instagram login, Generate token) and paste the whole thing.
- **Numbers like views or watch time are missing**: in the app's Instagram use case, check the permissions include `instagram_business_basic` and `instagram_business_manage_insights`, then generate a new token.
- **"Your Instagram key stopped working"**: tokens last 60 days. The app renews it every week while it's open, but if the app wasn't opened for a long time, it expires. Generate a new one.
- **Labels, Content direction and the Pillars chart stay empty**: they need an AI picked, and for Content direction, the "Who the reels are for" part of About you filled in.

### Save to Cleve

- **"Cleve didn't accept that key"**: make a new key in Cleve (Settings, Developer, API keys) and paste it again.
- If they're in several Cleve workspaces, a key only works in one of them, so scripts land in that one.
- To disconnect: the gear at the bottom of the left bar, then Disconnect.

### Other

- **Transcripts get words wrong**: add `WHISPER_MODEL=medium` to `.env` and start the app again. It's more accurate but slower, and downloads a bigger model the first time.
- **Bring the sample reels back**: delete the `.seeded` file and start the app again.
- **Start over completely**: close the app, then delete `transcripts`, `thumbs`, `breakdowns`, `studies`, `analytics`, `context.md`, `pillars.json`, `angles.json`, `cards.json`, `history.csv` and `.seeded`. Keep `.env` to keep their keys.

## If they want to change the app

Keep it simple: plain Python and plain JavaScript, no build step. After changing code, refresh the page. Test with a fresh copy of the folder (no `.env`, no data) to see what a new person sees.
