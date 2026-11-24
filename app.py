"""Unreel Engine: paste an Instagram reel link, get the transcript.

Runs locally on your computer. Opens at http://127.0.0.1:5055
The page is page.html (the shell and nav); each tool's code is in static/<tool>.js.
Studio's server side is in studio.py.
"""
import os
import re
import tempfile
import threading
import webbrowser
from datetime import datetime

from flask import Flask, jsonify, request, send_file, abort
import urllib.parse, urllib.request, urllib.error
import json, time
import yt_dlp
import studio
import analytics
import contextdoc
import angles
import cleve
import engine
from faster_whisper import WhisperModel

BASE = os.path.dirname(os.path.abspath(__file__))


def load_env():
    """Tiny .env reader so the keys live in a file next to the app, not in the code."""
    p = os.path.join(BASE, ".env")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                if v.strip():
                    os.environ[k.strip()] = v.strip().strip('"\'')


load_env()


def seed():
    """First run only: copy the starter files in (5 sample reels by Matt Bitter, broken down, in a sample study, plus a
    blank About you). Your own files are never overwritten, and deleting the samples later doesn't bring them back."""
    import shutil
    mark, src = os.path.join(BASE, ".seeded"), os.path.join(BASE, "starter")
    if os.path.exists(mark) or not os.path.isdir(src):
        return
    for root, _, files in os.walk(src):
        for f in files:
            if f.startswith("."):
                continue
            to = os.path.join(BASE, os.path.relpath(os.path.join(root, f), src))
            if not os.path.exists(to):
                os.makedirs(os.path.dirname(to), exist_ok=True)
                shutil.copy2(os.path.join(root, f), to)
    open(mark, "w").close()


seed()
OUT_DIR = os.path.join(BASE, "transcripts")
THUMB_DIR = os.path.join(BASE, "thumbs")  # tiny preview images only, no video is kept
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(THUMB_DIR, exist_ok=True)

# "small" is a good balance of speed and accuracy. Use "medium" for better accuracy.
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
_model = None
_lock = threading.Lock()


def get_model():
    global _model
    if _model is None:
        _model = WhisperModel(MODEL_SIZE, device="auto", compute_type="int8")
    return _model


COOKIES_FILE = os.path.join(BASE, "cookies.txt")
CHROME_DIR = next((d for d in (os.path.expanduser("~/Library/Application Support/Google/Chrome"),  # Mac
                               os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data"),  # Windows
                               os.path.expanduser("~/.config/google-chrome")) if os.path.isdir(d)), "")  # Linux
# Set IG_CHROME_PROFILE in .env (like "Profile 2") to use one Chrome profile only, say the one with a spare Instagram account.
# Otherwise the first profile that's logged in to Instagram is used.
CHROME_PROFILE = os.environ.get("IG_CHROME_PROFILE", "").strip()


class LoginNeeded(Exception):
    pass


def clean_url(url):
    m = re.search(r"instagram\.com/(?:[^/]+/)?(reel|reels|p|tv)/([A-Za-z0-9_-]+)", url)
    return f"https://www.instagram.com/{m.group(1)}/{m.group(2)}/" if m else url


def chrome_profile_with_instagram():
    """Find the Chrome profile that's logged in to Instagram, without unlocking anything."""
    import glob, shutil, sqlite3
    candidates = []
    if not CHROME_DIR:
        return None
    for db in glob.glob(os.path.join(CHROME_DIR, "*", "Cookies")) + \
              glob.glob(os.path.join(CHROME_DIR, "*", "Network", "Cookies")):
        profile_dir = db.split(CHROME_DIR + os.sep, 1)[1].split(os.sep)[0]
        if CHROME_PROFILE and profile_dir != CHROME_PROFILE:
            continue
        try:
            with tempfile.TemporaryDirectory() as t:
                copy = os.path.join(t, "c.db")
                shutil.copy(db, copy)
                con = sqlite3.connect(copy)
                n = con.execute("SELECT COUNT(*) FROM cookies WHERE host_key LIKE '%instagram.com' "
                                "AND name='sessionid'").fetchone()[0]
                con.close()
            if n:
                candidates.append(profile_dir)
        except Exception:
            pass
    return candidates[0] if candidates else None


def _try(url, opts):
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=True)


def download_reel(url, folder, video=False):
    url = clean_url(url)
    opts = {
        "format": "best[ext=mp4]/best" if video else "bestaudio/best",
        "outtmpl": os.path.join(folder, "%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "no_color": True,
    }
    attempts = [dict(opts)]
    if os.path.exists(COOKIES_FILE):
        attempts.append(dict(opts, cookiefile=COOKIES_FILE))
    profile = chrome_profile_with_instagram()
    if profile:
        attempts.append(dict(opts, cookiesfrombrowser=("chrome", profile)))

    info, last_err = None, None
    for o in attempts:
        try:
            info = _try(url, o)
            break
        except Exception as e:
            last_err = e
    if info is None:
        msg = re.sub(r"\x1b\[[0-9;]*m", "", str(last_err))
        if "No video formats" in msg or "no video in this post" in msg.lower():
            raise LoginNeeded("This post has no video. If it's a carousel, log in to instagram.com in Chrome "
                              "so the app can read the slides, then try again.")
        if "login required" in msg or "rate-limit" in msg or "not available" in msg:
            if not profile and not os.path.exists(COOKIES_FILE):
                raise LoginNeeded("Instagram wants you logged in. Log in to instagram.com in Chrome, then try again.")
            raise LoginNeeded("Instagram blocked it even with your login. If a password box popped up, click Allow. "
                              "Otherwise wait a few minutes and try again.")
        raise RuntimeError(msg[:200])

    downloads = info.get("requested_downloads") or []
    path = downloads[0]["filepath"] if downloads else None
    if not path or not os.path.exists(path):
        files = [os.path.join(folder, f) for f in os.listdir(folder)]
        if not files:
            raise RuntimeError("Download failed.")
        path = files[0]
    caption = (info.get("description") or "").strip()
    author = info.get("uploader") or info.get("channel") or ""
    stats = post_stats(info.get("like_count"), info.get("comment_count"), info.get("view_count"))
    return path, info.get("id", "reel"), caption, author, info.get("thumbnail"), stats


def post_stats(likes, comments, views):
    """Likes, comments and views Instagram reports, leaving out any it hides."""
    return {k: int(v) for k, v in (("likes", likes), ("comments", comments), ("views", views))
            if isinstance(v, (int, float)) and v > 0}


def transcribe(path):
    segments, info = get_model().transcribe(path, vad_filter=True)
    segments = list(segments)
    text = " ".join(seg.text.strip() for seg in segments)
    timed = "\n".join(f"[{seg.start:.1f}-{seg.end:.1f}s] {seg.text.strip()}" for seg in segments)
    return to_paragraphs(text), info.language, timed


IG_APP_ID = "936619743392459"  # the public app id instagram.com's own web page sends
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/141.0 Safari/537.36")
SHORTCODE_ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
OCR_PROMPT = """You read the text on Instagram carousel slides. For each slide, write out every word shown on it, \
exactly as written, in reading order (top to bottom, left to right). Keep line breaks between separate lines or \
blocks of text. Don't describe pictures, fix spelling, or add anything of your own. Skip small interface text like \
slide counters or "swipe" arrows. If a slide has no text, write (no text).
Answer with one <slide n="N">...</slide> per slide, in order, and nothing else."""


CLEAN_PROMPT = """You tidy up text that was read off Instagram carousel slides, so it reads the way a person would read it. \
It was read line by line off the image, so the design broke it up: words that belong together sit on separate lines, and \
tables or two-column layouts came out column by column.

For each slide:
- Join lines that belong to one heading, phrase or sentence ("Strategic" then "Thinking" becomes "Strategic Thinking").
- Put each label with its content: a heading with its description, a list item with its explanation, a table row read \
across. Where the layout listed the labels first and their details after, pair them back up in order, like \
"Vision & goals: Where do you want to go and why?".
- Turn decorative numbering into list numbers ("01" then "What it helps you do" becomes "1. What it helps you do").
- Drop text that repeats on every slide as branding, like the account's name or handle in a corner.
- One idea per line, with a blank line between separate parts of the slide.

Use only the words that are there, keeping their order within each phrase. Don't summarize, paraphrase, fix spelling, \
translate or add anything. If a slide has no text, write (no text).
Answer with one <slide n="N">...</slide> per slide, in order, and nothing else."""

SCREEN_PROMPT = """You read the on-screen text of an Instagram reel, from frames taken in order through the video, so a \
content strategist gets its script. You also get what speech recognition heard: it may be a voiceover, song lyrics, or nothing.

- screen: the reel's on-screen text in the order it appears, each piece once (text often stays on screen across frames, \
or builds up word by word). Tidy it so it reads naturally: join words that belong together, one idea per line. Skip \
captions that just repeat the speech word for word, the creator's handle, and app or interface text. Use only the words \
shown: don't summarize, paraphrase or add anything. "" if there's no on-screen text worth keeping.
- speech: "voice" if the audio is someone talking as part of the content, "music" if it's song lyrics or background \
audio, "none" if there's nothing."""


def clean_slides(read):
    """Slide number -> text read off it, tidied by Claude so broken-up designs read naturally. Same words, same order."""
    if not any(t.strip() and t.strip() != "(no text)" for t in read.values()):
        return read
    slides = "\n\n".join(f'<slide n="{n}">\n{t}\n</slide>' for n, t in sorted(read.items()))
    out = studio.ask_claude(CLEAN_PROMPT, [{"role": "user", "content": slides}], effort="low")
    clean = {int(n): t.strip() for n, t in re.findall(r'<slide n="(\d+)">(.*?)</slide>', out, re.S)}
    return {n: clean.get(n) or t for n, t in read.items()}  # a slide it skipped keeps its raw reading


def read_screen(path, spoken, tmp, audio=True):
    """A reel's on-screen text from its frames, and whether its audio is a voice, music or nothing.
    audio=False: the audio was never transcribed, so captions of what's said are kept too."""
    import base64
    frames_dir = os.path.join(tmp, "screen")
    os.makedirs(frames_dir, exist_ok=True)
    duration = video_duration(path)
    times = frame_times(duration, scene_cuts(path))[:40]
    frames = grab_frames(path, times, frames_dir, width=720)
    if not frames:
        return "", "voice"
    heard = (f"Speech recognition heard:\n{spoken or '(nothing)'}" if audio else
             "Speech recognition wasn't run on this reel, so keep captions of what's said: they're the only record of it. "
             "Answer speech as \"none\".")
    content = [{"type": "text", "text": heard + "\n\nFrames:"}]
    for t, f in frames:
        content.append({"type": "text", "text": f"{t:.1f}s"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                    "data": base64.b64encode(open(f, "rb").read()).decode()}})
    schema = studio.obj(screen=studio.TEXT, speech={"type": "string", "enum": ["voice", "music", "none"]})
    found = json.loads(studio.ask_claude(SCREEN_PROMPT, [{"role": "user", "content": content}], schema=schema, effort="low"))
    return found["screen"].strip(), found["speech"]


def with_screen(spoken, screen, speech):
    """The transcript, and where it came from, once the on-screen text is known."""
    if not screen:
        return spoken, ""
    if speech == "voice" and spoken.strip():
        return f"{spoken}\n\nOn screen:\n{screen}", "speech and on-screen text"
    return screen, "on-screen text"


def little_speech(text, path):
    """Too few words for the length of the reel: its message is probably on screen."""
    words, duration = len(text.split()), video_duration(path)
    return words < 12 or (duration > 0 and words / duration < 0.8)


def cookie_jars():
    """Logged-in Instagram cookies to try, same order as download_reel: cookies.txt, then Chrome."""
    import http.cookiejar
    if os.path.exists(COOKIES_FILE):
        jar = http.cookiejar.MozillaCookieJar(COOKIES_FILE)
        try:
            jar.load(ignore_discard=True, ignore_expires=True)
            yield jar
        except Exception:
            pass
    profile = chrome_profile_with_instagram()
    if profile:
        from yt_dlp.cookies import extract_cookies_from_browser
        try:
            yield extract_cookies_from_browser("chrome", profile)
        except Exception:
            pass


def fetch_post(url):
    """Post details from Instagram's web API, using your login. None if no login works."""
    m = re.search(r"/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)", url)
    if not m:
        return None
    pk = 0
    for c in m.group(1):
        pk = pk * 64 + SHORTCODE_ABC.index(c)
    req = urllib.request.Request(f"https://www.instagram.com/api/v1/media/{pk}/info/",
                                 headers={"X-IG-App-ID": IG_APP_ID, "User-Agent": BROWSER_UA})
    for jar in cookie_jars():
        try:
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
            return json.load(opener.open(req, timeout=20))["items"][0]
        except Exception:
            continue
    return None


def read_carousel(item, tmp):
    """Slide by slide text of an image post or carousel. Claude reads the images, Whisper the video slides."""
    import base64
    engine.check()
    slides = item.get("carousel_media") or [item]
    content, spoken = [], {}
    for i, s in enumerate(slides, 1):
        if s.get("video_versions"):
            p = os.path.join(tmp, f"slide{i}.mp4")
            urllib.request.urlretrieve(s["video_versions"][0]["url"], p)
            try:
                spoken[i] = transcribe(p)[0]
            except IndexError:  # a silent video slide has no audio track to read
                pass
        img = urllib.request.urlopen(s["image_versions2"]["candidates"][0]["url"], timeout=30).read()
        content.append({"type": "text", "text": f"Slide {i}" + (" (video, this is its cover)" if i in spoken else "")})
        kind = ("image/webp" if img[8:12] == b"WEBP" else "image/png" if img.startswith(b"\x89PNG")
                else "image/jpeg")
        content.append({"type": "image", "source": {"type": "base64", "media_type": kind,
                                                    "data": base64.b64encode(img).decode()}})
    out = engine.ask(OCR_PROMPT, [{"role": "user", "content": content}], effort="low", max_tokens=8000)
    read = {int(n): t.strip() for n, t in re.findall(r'<slide n="(\d+)">(.*?)</slide>', out, re.S)}
    read = {i: read.get(i) or "(no text)" for i in range(1, len(slides) + 1)}
    raw, text = slides_text(read, spoken), slides_text(clean_slides(read), spoken)
    thumb = slides[0]["image_versions2"]["candidates"][0]["url"]
    caption = (item.get("caption") or {}).get("text", "").strip()
    stats = post_stats(item.get("like_count"), item.get("comment_count"),
                       item.get("play_count") or item.get("ig_play_count") or item.get("view_count"))
    return text, item.get("code", "post"), caption, item["user"]["username"], thumb, stats, raw


def slides_text(read, spoken):
    return "\n\n".join(f"Slide {i}\n{t}" + (f"\n\nSpoken on slide {i}:\n{spoken[i]}" if spoken.get(i) else "")
                       for i, t in sorted(read.items()))


def parse_slides(text):
    """Back from a carousel transcript to slide number -> text read off it, and slide number -> speech."""
    read, spoken = {}, {}
    for n, body in re.findall(r"(?m)^Slide (\d+)\n(.*?)(?=^Slide \d+\n|\Z)", text, re.S):
        body, _, said = body.partition(f"\n\nSpoken on slide {n}:\n")
        read[int(n)] = body.strip()
        if said.strip():
            spoken[int(n)] = said.strip()
    return read, spoken


def raw_path(name):
    """The reading before clean-up, kept beside the transcript."""
    return os.path.join(OUT_DIR, name[:-4] + ".raw")


def save_raw(name, raw):
    if raw and not os.path.exists(raw_path(name)):
        with open(raw_path(name), "w", encoding="utf-8") as f:
            f.write(raw)


def rewrite_transcript(name, text, source):
    """New transcript text (and where it came from) in a saved file; the caption and your script stay."""
    path = os.path.join(OUT_DIR, name)
    raw = open(path, encoding="utf-8").read()
    head, body = raw.split("\n\nTRANSCRIPT\n", 1)
    head = "\n".join(l for l in head.splitlines() if not l.startswith("Source: ")) + (f"\nSource: {source}" if source else "")
    rest = body[body.index("\n\nCAPTION\n"):] if "\n\nCAPTION\n" in body else "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"{head}\n\nTRANSCRIPT\n{text}{rest}")
    studio.drop_breakdown(name)  # the Studio breaks it down again from the new text


def to_paragraphs(text):
    """One sentence per paragraph. Plain rule, no AI: split after . ! ? before a capital."""
    text = re.sub(r"\s+", " ", text).strip()
    parts = re.split(r"(?:(?<=[.!?])|(?<=[.!?][\"')]))\s+(?=[\"'(\[]?[A-Z0-9])", text)
    return "\n\n".join(p.strip() for p in parts if p.strip())


CLAUDE_MODEL = engine.CLAUDE_MODEL
SetupNeeded = engine.NotSetUp  # "pick an AI first" and the like: shown to you as is
CONTEXT_FILE = os.path.join(BASE, "context.md")
_ctx = {"at": 0, "text": ""}


def load_context():
    """context.md: who you are, your audience and your voice. The script writer and the chat read it."""
    if _ctx["text"] and time.time() - _ctx["at"] < 600:
        return _ctx["text"]
    text = open(CONTEXT_FILE, encoding="utf-8").read() if os.path.exists(CONTEXT_FILE) else ""
    _ctx.update(at=time.time(), text=text)
    return text


SYSTEM_PROMPT = """You write Instagram reel scripts for a creator. Everything you know about them, what they offer, their audience and their voice is in <context>. Treat it as the only source of facts.

The user gives you the transcript of someone else's reel that performed well. Your job is to reuse its structure, not its content: a mad-libs template filled with the creator's own topic.

Work in this order, silently:
1. Name the template. What kind of hook is it (a number promise, a question, a contrarian claim, a "what I did")? What are the beats, in order? How does it pay off? Roughly how long is each beat?
2. Choose the angle. Find the one real problem from the context that best fits this template, and what the creator knows or offers that solves it. If the user gave a topic or angle, use that; otherwise, if there is a <focus_angle>, use it. The script should be about that problem, not about the original reel's topic, unless the original topic genuinely fits the creator.
3. Fill the template beat by beat with the angle. Keep the original's hook shape, beat order, sentence rhythm and payoff type. Replace every specific.
4. End with exactly one call to action. Use the call-to-action rules in the context if there are any, else "follow for more".

Facts:
- Only say what the creator's product or service does if the context says it.
- Never invent numbers, results, customers, or events in the creator's life.
- When the script needs a personal moment, example or detail that is not in the context, write a short placeholder in square brackets for the creator to fill, like [your detail: what you were working on when this clicked]. Use at most 3 placeholders.
- If the context is empty or thin, write a script on the user's topic (or the original's) in plain, friendly words, with placeholders for anything personal.

Sound: follow the voice section of the context, if there is one. Explain anything technical with "this is like".
Length: aim for 120 to 150 spoken words. Count before you finish; if you are over 150, cut beats rather than squeezing sentences. Never more than 225.

Output only the script: one sentence per line, a blank line between lines, no headings, no notes.

When the user sends <current_script> and <requested_change>, apply only that change, keep the rest, and return the full revised script under the same rules."""


def write_script(transcript, topic, current=""):
    context = load_context()
    focus = angles.focus_block()
    user = (f"<context>\n{context or '(empty: the creator has not filled in About you yet)'}\n</context>\n\n"
            + (f"{focus}\n\n" if focus else "")
            + f"<reel_transcript>\n{transcript}\n</reel_transcript>\n\n"
            + (f"<current_script>\n{current}\n</current_script>\n\n<requested_change>{topic}</requested_change>\n\n"
               "Apply the requested change to the current script and return the full revised script."
               if current else
               (f"<topic_or_angle>{topic}</topic_or_angle>\n\n" if topic else "")
               + "Write the script."))
    script = engine.ask(SYSTEM_PROMPT, [{"role": "user", "content": user}], effort="medium", max_tokens=8000)
    if len(script.split()) > 165 and "word" not in topic.lower():
        # Over a 60-second reel: one tightening pass, unless the user asked about length themselves
        return write_script(transcript, f"It is {len(script.split())} words. Cut it to 150 words or fewer by dropping "
                            "the weakest beat or line, keeping the hook, the best beats and the call to action.", script)
    return script


MAX_FRAMES = 60


FFMPEG_MISSING = ("Reading on-screen text needs ffmpeg, a free video tool. Mac: install Homebrew from brew.sh, then run "
                  "brew install ffmpeg in Terminal. Windows: run winget install ffmpeg in PowerShell. Then restart the app.")


def run_cmd(args):
    import shutil, subprocess
    if not shutil.which(args[0]):
        raise SetupNeeded(FFMPEG_MISSING)
    return subprocess.run(args, capture_output=True, text=True)


def video_duration(path):
    """Seconds, or 0 if it can't tell (say ffmpeg isn't installed)."""
    try:
        r = run_cmd(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
        return float(r.stdout.strip() or 0)
    except (SetupNeeded, ValueError):
        return 0.0


def scene_cuts(path):
    """Times (s) where the picture changes hard, i.e. a cut."""
    r = run_cmd(["ffmpeg", "-hide_banner", "-i", path, "-filter:v", "select='gt(scene,0.3)',showinfo", "-f", "null", "-"])
    return [round(float(t), 2) for t in re.findall(r"pts_time:([\d.]+)", r.stderr)]


def frame_times(duration, cuts):
    """One frame a second (spread out on long reels), plus one just after every cut."""
    step = max(1.0, duration / 45)
    times = {round(i * step, 2) for i in range(int(duration / step) + 1)}
    times |= {round(min(c + 0.3, duration - 0.1), 2) for c in cuts}
    times = sorted(t for t in times if t < duration)
    if len(times) > MAX_FRAMES:
        times = [times[round(i * (len(times) - 1) / (MAX_FRAMES - 1))] for i in range(MAX_FRAMES)]
    return times


def grab_frames(path, times, folder, width=480):
    frames = []
    for i, t in enumerate(times, 1):
        out = os.path.join(folder, f"f_{i:03d}.jpg")
        run_cmd(["ffmpeg", "-v", "error", "-ss", str(t), "-i", path, "-frames:v", "1",
                 "-vf", f"scale={width}:-2", "-q:v", "4", "-y", out])
        if os.path.exists(out):
            frames.append((t, out))
    return frames


app = Flask(__name__)
HISTORY_CSV = os.path.join(BASE, "history.csv")


def thumb_path(name):
    return os.path.join(THUMB_DIR, os.path.splitext(name)[0] + ".jpg")


def thumb_url(name):
    return "/thumb/" + name if os.path.exists(thumb_path(name)) else ""


def save_thumb(url, name):
    try:
        if url:
            urllib.request.urlretrieve(url, thumb_path(name))
    except Exception:
        pass  # a missing preview image is not worth failing the transcript


def save_script(name, script):
    path = os.path.join(OUT_DIR, name)
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    raw = raw.split("\n\nMY SCRIPT\n", 1)[0].rstrip("\n")
    with open(path, "w", encoding="utf-8") as f:
        f.write(raw + "\n\nMY SCRIPT\n" + script + "\n")


def read_transcript_file(name):
    with open(os.path.join(OUT_DIR, name), encoding="utf-8") as f:
        raw = f.read()
    meta = {}
    for line in raw.split("\n\n", 1)[0].splitlines():
        if ": " in line:
            k, v = line.split(": ", 1)
            meta[k.strip().lower()] = v.strip()
    body = raw.split("TRANSCRIPT\n", 1)[1] if "TRANSCRIPT\n" in raw else ""
    script = ""
    if "\n\nMY SCRIPT\n" in body:
        body, script = body.rsplit("\n\nMY SCRIPT\n", 1)
    if "\n\nCAPTION\n" in body:
        transcript, caption = body.rsplit("\n\nCAPTION\n", 1)
    else:
        transcript, caption = body, ""
    m = re.match(r"(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})", name)
    when = f"{m.group(1)} {m.group(2)}:{m.group(3)}" if m else ""
    kind = meta.get("type", "reel")
    source = meta.get("source", "")
    transcript = transcript.strip() if kind == "carousel" or source else to_paragraphs(transcript)  # keep slide and screen lines
    stats = {k: int(meta[k]) for k in ("likes", "comments", "views") if meta.get(k, "").isdigit()}
    return dict(file=name, when=when, thumb=thumb_url(name), link=meta.get("link", ""), author=meta.get("author", ""),
                kind=kind, transcript=transcript, caption=caption.strip(), script=script.strip(), stats=stats, source=source)


studio.register(app, base=BASE, out_dir=OUT_DIR, read_post=read_transcript_file, load_context=load_context,
                setup_error=SetupNeeded, model=CLAUDE_MODEL)
def transcribe_link(url):
    """Words of one reel, for Analytics. The audio sits in a temporary folder that is deleted straight after."""
    with _lock:
        with tempfile.TemporaryDirectory() as tmp:
            return transcribe(download_reel(url, tmp)[0])[0]


analytics.register(app, base=BASE, duration=video_duration, transcribe=transcribe_link)
angles.register(app, base=BASE)
contextdoc.register(app, base=BASE, on_change=lambda: _ctx.update(at=0, text=""))  # the Context page: edits to context.md
cleve.register(app)  # Save to Cleve, for people who connect their own Cleve

PAGE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "page.html")


@app.get("/")
def home():
    """The page. Each script gets ?v=<when it last changed>, so after an update the browser never runs an old copy."""
    with open(PAGE_FILE, encoding="utf-8") as f:
        page = f.read()
    static = os.path.join(BASE, "static")
    return re.sub(r'src="/static/([\w.-]+\.js)"', lambda m: f'src="/static/{m.group(1)}?v='
                  f'{int(os.path.getmtime(os.path.join(static, m.group(1)))) if os.path.exists(os.path.join(static, m.group(1))) else 0}"', page)


@app.get("/setup")
def setup_get():
    """Which AI is picked, and which apps are installed, for the setup pop-up."""
    return jsonify(engine.status())


@app.post("/setup")
def setup_post():
    """Pick the AI: {engine: claude | claude_key | chatgpt, key (for claude_key)}. It's tried once before it's saved."""
    b = request.get_json(silent=True) or {}
    pick, key = b.get("engine"), str(b.get("key") or "").strip()
    if pick not in engine.ENGINES:
        return jsonify(error="Pick one of the three."), 400
    if pick == "claude_key" and not key and not os.environ.get("ANTHROPIC_API_KEY"):
        return jsonify(error="Paste your Anthropic API key first."), 400
    before = {k: os.environ.get(k) for k in ("AI_ENGINE", "ANTHROPIC_API_KEY")}
    os.environ["AI_ENGINE"] = pick
    if key:
        os.environ["ANTHROPIC_API_KEY"] = key
    try:
        engine.check()
        engine.ask("Reply with the word ok and nothing else.", [{"role": "user", "content": "ok?"}], effort="low", max_tokens=20)
    except Exception as e:
        for k, v in before.items():  # didn't work: back to how it was
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        msg = str(e)
        if pick == "claude_key" and re.search(r"401|authentication|invalid x-api-key", msg, re.I):
            msg = "Anthropic didn't accept that key. Copy it again from console.anthropic.com (API keys) and paste the whole thing."
        return jsonify(error=msg[:300]), 400
    engine.env_set("AI_ENGINE", pick)
    if key:
        engine.env_set("ANTHROPIC_API_KEY", key)
    return jsonify(engine.status())


@app.get("/history")
def history():
    items = []
    for name in sorted(os.listdir(OUT_DIR), reverse=True):
        if not name.endswith(".txt"):
            continue
        try:
            d = read_transcript_file(name)
        except Exception:
            continue
        items.append(dict(file=name, when=d["when"], thumb=d["thumb"], author=d["author"], kind=d["kind"],
                          link=d["link"], preview=d["transcript"].replace("\n", " ")[:140]))
    return jsonify(items)


@app.get("/thumb/<name>")
def thumb(name):
    p = thumb_path(os.path.basename(name))
    if not os.path.exists(p):
        abort(404)
    return send_file(p, mimetype="image/jpeg")


@app.get("/history/<name>")
def history_item(name):
    name = os.path.basename(name)
    if not name.endswith(".txt") or not os.path.exists(os.path.join(OUT_DIR, name)):
        return jsonify(error="Not found"), 404
    return jsonify(read_transcript_file(name))


@app.post("/history/<name>/reread")
def reread_item(name):
    """Carousels: clean up the slide text again. Reels: read the on-screen text (and keep the speech if it's a voice)."""
    name = os.path.basename(name)
    if not name.endswith(".txt") or not os.path.exists(os.path.join(OUT_DIR, name)):
        return jsonify(error="Not found"), 404
    d = read_transcript_file(name)
    with _lock:
        try:
            if d["kind"] == "carousel":
                raw = open(raw_path(name), encoding="utf-8").read() if os.path.exists(raw_path(name)) else d["transcript"]
                save_raw(name, raw)
                read, spoken = parse_slides(raw)
                rewrite_transcript(name, slides_text(clean_slides(read), spoken), "")
            else:
                with tempfile.TemporaryDirectory() as tmp:
                    path = download_reel(d["link"], tmp, video=True)[0]
                    spoken = transcribe(path)[0]
                    rewrite_transcript(name, *with_screen(spoken, *read_screen(path, spoken, tmp)))
        except SetupNeeded as e:
            return jsonify(error=str(e)), 400
        except LoginNeeded as e:
            return jsonify(error=str(e)), 401
        except Exception as e:
            return jsonify(error=f"Couldn't re-read it. {str(e)[:300]}"), 500
    return jsonify(read_transcript_file(name))


@app.delete("/history/<name>")
def delete_item(name):
    import csv
    name = os.path.basename(name)
    path = os.path.join(OUT_DIR, name)
    if not name.endswith(".txt") or not os.path.exists(path):
        return jsonify(error="Not found"), 404
    os.remove(path)
    for extra in (thumb_path(name), raw_path(name)):
        if os.path.exists(extra):
            os.remove(extra)
    studio.forget_post(name)
    if os.path.exists(HISTORY_CSV):
        with open(HISTORY_CSV, newline="", encoding="utf-8") as f:
            rows = list(csv.reader(f))
        rows = [r for i, r in enumerate(rows) if i == 0 or len(r) < 4 or r[3] != name]
        with open(HISTORY_CSV, "w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerows(rows)
    return jsonify(ok=True)


@app.post("/use-script")
def use_script():
    body = request.get_json(silent=True) or {}
    name = os.path.basename(body.get("file", ""))
    if not name.endswith(".txt") or not os.path.exists(os.path.join(OUT_DIR, name)):
        return jsonify(error="Transcript not found."), 404
    transcript = read_transcript_file(name)["transcript"]
    try:
        text = (body.get("topic") or "").strip()
        current = read_transcript_file(name)["script"] if text and not body.get("fresh") else ""
        script = to_paragraphs(write_script(transcript, text, current))
        save_script(name, script)
        return jsonify(script=script)
    except SetupNeeded as e:
        return jsonify(error=str(e)), 400
    except Exception as e:
        return jsonify(error=f"{type(e).__name__}: {str(e)[:300]}"), 500


HOOKS_FILE = os.path.join(BASE, "hooks.json")  # opening lines of the sample reels, by format


@app.get("/formats")
def formats_library():
    """Every format in Formats Index order, with its cards, the cards Studio made for it, and its hooks."""
    try:
        hooks = json.load(open(HOOKS_FILE, encoding="utf-8"))["formats"]
    except (OSError, ValueError, KeyError):
        hooks = {}
    learned = studio.learned_cards()
    out = []
    for f in studio.FORMATS["formats"]:
        mine = hooks.get(f["name"], [])
        out.append(dict(name=f["name"], short=f.get("short") or f["name"], category=f["category"], status=f["status"], idea_has=f.get("idea_has", ""),
                        cards=[studio.std_card(c) for c in f["cards"]], studio_cards=learned.get(f["name"], []), hooks=mine))
    return jsonify(categories=studio.FORMATS["categories"], formats=out, close_calls=studio.FORMATS.get("close_calls", []))


@app.post("/formats/sample")
def formats_sample():
    """One sample script, broken down against its card. Claude runs once per sample.
    (The sample reels that come with the app are already broken down in Studio: the page opens those as posts.)"""
    b = request.get_json(silent=True) or {}
    fmt = next((f for f in studio.FORMATS["formats"] if f["name"] == b.get("format")), None)
    try:
        sample = json.load(open(HOOKS_FILE, encoding="utf-8"))["formats"][fmt["name"]][int(b.get("hook"))]
    except (TypeError, OSError, ValueError, KeyError, IndexError):
        return jsonify(error="That sample isn't in hooks.json."), 404
    m = re.match(r"Card ([A-Z]):", sample.get("card", ""))
    cards = [fmt["cards"][ord(m.group(1)) - 65]] if m and ord(m.group(1)) - 65 < len(fmt["cards"]) else fmt["cards"]
    try:
        found = studio.sample_breakdown(fmt["name"], sample, cards)
    except SetupNeeded as e:
        return jsonify(error=str(e)), 400
    except Exception as e:
        return jsonify(error=f"Couldn't break it down. {str(e)[:300]}"), 500
    card = fmt["cards"].index(cards[found["card"]])  # back to the format's own card numbering
    return jsonify(dict(found, card=card))


@app.get("/formats/post/<name>")
def formats_post(name):
    """The post a Studio card was made from, with its saved breakdown if it still uses that card."""
    name = os.path.basename(name)
    if not name.endswith(".txt") or not os.path.exists(os.path.join(OUT_DIR, name)):
        return jsonify(error="That post isn't in your history any more."), 404
    d, bd = read_transcript_file(name), studio.load_breakdown(name)
    same = bd and (bd.get("card") or {}).get("name", "").lower() == request.args.get("card", "").lower()
    return jsonify(link=d["link"], kind=d["kind"], author=d["author"], title=d["author"],
                   lines=bd["lines"] if bd else studio.post_lines(d), chunks=bd["chunks"] if same else [])


def save_transcript(url, rid, caption, author, thumb, text, lang, kind="reel", stats=None, source=""):
    import csv
    now = datetime.now()
    name = f"{now.strftime('%Y-%m-%d_%H%M%S')}_{re.sub(r'[^A-Za-z0-9_-]', '', rid)}.txt"
    save_thumb(thumb, name)
    with open(os.path.join(OUT_DIR, name), "w", encoding="utf-8") as f:
        f.write(f"Link: {url}\nAuthor: {author}\nLanguage: {lang}\n" + (f"Type: {kind}\n" if kind != "reel" else "")
                + (f"Source: {source}\n" if source else "")
                + "".join(f"{k.capitalize()}: {v}\n" for k, v in (stats or {}).items()) + "\n")
        f.write(f"TRANSCRIPT\n{text}\n\nCAPTION\n{caption}\n")
    new = not os.path.exists(HISTORY_CSV)
    with open(HISTORY_CSV, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["Date", "Author", "Link", "File", "Transcript"])
        w.writerow([now.strftime("%Y-%m-%d %H:%M"), author, url, name, text.replace("\n\n", " ")])
    return name


@app.post("/process")
def process():
    """One link in, one transcript out.
    screen: the transcript is the reel's on-screen text only, read from the video. Its audio is never transcribed."""
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()
    if "instagram.com" not in url:
        return jsonify(error="That doesn't look like an Instagram link."), 400
    url = clean_url(url)
    want_screen = bool(body.get("screen"))
    with _lock:
        try:
            # /p/ links can be carousels or photos, which have no audio. Reels skip this and go straight to yt-dlp.
            item = fetch_post(url) if "/p/" in url else None
            if item and item.get("media_type") in (1, 8):
                with tempfile.TemporaryDirectory() as tmp:
                    text, rid, caption, author, thumb, stats, raw = read_carousel(item, tmp)
                name = save_transcript(url, rid, caption, author, thumb, text, "", kind="carousel", stats=stats)
                save_raw(name, raw)
                return jsonify(file=name, kind="carousel")
            # Video or audio and frames go into a temporary folder that is deleted as soon as this block ends
            with tempfile.TemporaryDirectory() as tmp:
                path, rid, caption, author, thumb, stats = download_reel(url, tmp, video=want_screen)
                text, lang, source = "", "", ""
                if want_screen:
                    text, source = read_screen(path, "", tmp, audio=False)[0], "on-screen text"
                else:
                    text, lang, _ = transcribe(path)
                    if little_speech(text, path):  # probably a text-on-screen reel: read its frames too
                        try:
                            video = download_reel(url, os.path.join(tmp, "video"), video=True)[0]
                            text, source = with_screen(text, *read_screen(video, text, tmp))
                        except SetupNeeded:
                            pass  # no ffmpeg (or no AI picked yet): keep what was said
                name = save_transcript(url, rid, caption, author, thumb, text, lang, stats=stats, source=source)  # every link joins the history
        except SetupNeeded as e:
            return jsonify(error=str(e)), 400
        except LoginNeeded as e:
            return jsonify(error=str(e)), 401
        except Exception as e:
            msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e))
            return jsonify(error=f"Couldn't process that reel. {msg[:300]}"), 500
    return jsonify(file=name, saved=name, kind="reel")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5055"))
    if not os.environ.get("WERKZEUG_RUN_MAIN"):  # the reloader runs this file twice; open the page once
        threading.Timer(1.5, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    # Reloads itself when the code changes, so edits show up without a restart
    app.run(host="127.0.0.1", port=port, use_reloader=True, extra_files=[os.path.join(BASE, "formats.json")])
