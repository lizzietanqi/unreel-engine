"""Which AI runs the app, and the two ways the app talks to it.

Three choices, picked on the setup screen and saved as AI_ENGINE in .env:
- claude:     your Claude account, through Claude Code (installed and signed in). No key.
- claude_key: an Anthropic API key (ANTHROPIC_API_KEY). Pay per use.
- chatgpt:    your ChatGPT account, through Codex (installed and signed in). No key.

ask():   one question, one answer. Breakdowns, scripts, reading slides, labels. Can return JSON that fits a schema.
agent(): the chat and the weekly review. The AI runs in this folder and reads (and for the chat, edits) the files itself.
         Claude account and API key both use Claude Code here; with a key, Claude Code runs on the key.
"""
import base64
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading

BASE = os.path.dirname(os.path.abspath(__file__))
CLAUDE_MODEL = "claude-sonnet-5-5"
ENGINES = ("claude", "claude_key", "chatgpt")
RUNNING = {}  # chat id -> its process, so the page can stop it
_codex = {}


class NotSetUp(Exception):
    """Shown to the person as is: what to do so the AI works."""


def current():
    e = os.environ.get("AI_ENGINE", "").strip()
    if e in ENGINES:
        return e
    return "claude_key" if os.environ.get("ANTHROPIC_API_KEY") else ""


def name():
    return {"claude": "Claude", "claude_key": "Claude", "chatgpt": "ChatGPT"}.get(current(), "Claude")


# --- .env: the settings file next to the app ---

def env_set(key, value):
    """Sets one line in .env (adds it if it's not there) and in this running app."""
    p = os.path.join(BASE, ".env")
    lines = open(p, encoding="utf-8").read().splitlines() if os.path.exists(p) else []
    lines = [l for l in lines if not l.strip().startswith(key + "=")]
    if value:
        lines.append(f"{key}={value}")
        os.environ[key] = value
    else:
        os.environ.pop(key, None)
    with open(p, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    try:
        os.chmod(p, 0o600)  # only you can read it
    except OSError:
        pass


# --- Finding the apps ---

def claude_cli():
    return shutil.which("claude") or next(iter(sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/claude")), reverse=True)), None) \
        or next((p for p in (os.path.expanduser("~/.claude/local/claude"), os.path.expanduser("~/.local/bin/claude")) if os.path.exists(p)), None)


def codex_cli():
    """A Codex new enough for the app (it needs --output-schema). The one inside the ChatGPT app counts too."""
    if "path" in _codex:
        return _codex["path"]
    found = None
    for p in [shutil.which("codex"), "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
              os.path.expanduser("~/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex")]:
        if p and os.path.exists(p):
            try:
                h = subprocess.run([p, "exec", "--help"], capture_output=True, text=True, timeout=20).stdout
            except Exception:
                continue
            if "--output-schema" in h:
                found = p
                break
    _codex["path"] = found
    return found


def status():
    """For the setup screen: what's picked, and what's installed."""
    return dict(engine=current(), claude=bool(claude_cli()), codex=bool(codex_cli()),
                key=bool(os.environ.get("ANTHROPIC_API_KEY")))


def ready():
    e = current()
    return bool(e) and (e != "claude_key" or bool(os.environ.get("ANTHROPIC_API_KEY")))


def check():
    e = current()
    if not e:
        raise NotSetUp("Pick which AI to use first: click the gear at the bottom of the left bar.")
    if e == "claude_key" and not os.environ.get("ANTHROPIC_API_KEY"):
        raise NotSetUp("Add your Anthropic API key first: click the gear at the bottom of the left bar.")
    if e == "claude" and not claude_cli():
        raise NotSetUp("Claude Code isn't installed. Install it from claude.com/claude-code, sign in once, then try again.")
    if e == "chatgpt" and not codex_cli():
        raise NotSetUp("Codex isn't installed. Install it from developers.openai.com/codex, sign in with ChatGPT, then try again.")
    return e


# --- ask(): one question, one answer ---

def ask(system, messages, schema=None, effort="medium", max_tokens=16000):
    """messages: [{"role": "user", "content": text or [{"type": "text"|"image", ...}]}]. Returns the answer's text
    (with a schema, JSON text that fits it)."""
    e = check()
    if e == "claude_key":
        return _ask_api(system, messages, schema, effort, max_tokens)
    if e == "claude":
        return _ask_claude_code(system, messages, schema)
    return _ask_codex(system, messages, schema)


def _ask_api(system, messages, schema, effort, max_tokens):
    import anthropic
    config = {"effort": effort}
    if schema:
        config["format"] = {"type": "json_schema", "schema": schema}
    resp = anthropic.Anthropic().messages.create(model=CLAUDE_MODEL, max_tokens=max_tokens, system=system,
                                                 messages=messages, output_config=config)
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude declined this one. Try a different post.")
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("The answer got cut off. Try fewer posts at once.")
    return "".join(b.text for b in resp.content if b.type == "text").strip()


def _blocks(messages):
    """All the user content as one list of blocks."""
    out = []
    for m in messages:
        c = m["content"]
        out += [{"type": "text", "text": c}] if isinstance(c, str) else list(c)
    return out


def _kill(proc, hard=False):
    """Ends the process and everything it started."""
    try:
        if os.name == "nt":  # Windows has no process groups: end the whole tree
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        else:
            os.killpg(proc.pid, signal.SIGKILL if hard else signal.SIGTERM)
    except (ProcessLookupError, OSError):
        pass


def _run(cmd, stdin="", env=None, cwd=None, timeout=900, key=None):
    proc = subprocess.Popen(cmd, cwd=cwd or BASE, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                            start_new_session=os.name != "nt")  # its own group, so Stop ends all of it
    if key:
        RUNNING[key] = proc
    try:
        return proc.communicate(stdin, timeout=timeout) + (proc.returncode,)
    except subprocess.TimeoutExpired:
        _kill(proc, hard=True)
        out, err = proc.communicate()
        return out, err or "It took too long and was stopped.", -9
    finally:
        if key:
            RUNNING.pop(key, None)


def _claude_env():
    """Claude account: leave any API key out, so Claude Code uses the login. API key: Claude Code runs on the key."""
    if current() == "claude_key":
        return dict(os.environ)
    return {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}


def _ask_claude_code(system, messages, schema):
    cmd = [claude_cli(), "-p", "--model", CLAUDE_MODEL, "--input-format", "stream-json", "--output-format", "stream-json",
           "--verbose", "--system-prompt", system, "--tools", "", "--no-session-persistence", "--strict-mcp-config",
           "--setting-sources", ""]
    if schema:
        cmd += ["--json-schema", json.dumps(schema)]
    msg = {"type": "user", "message": {"role": "user", "content": _blocks(messages)}}
    with tempfile.TemporaryDirectory() as tmp:  # an empty folder: nothing to read
        out, err, _ = _run(cmd, json.dumps(msg) + "\n", env=_claude_env(), cwd=tmp)
    res = next((ev for ev in map(_json, out.splitlines()) if ev and ev.get("type") == "result"), None)
    if not res or res.get("is_error"):
        raise RuntimeError(_claude_problem((res or {}).get("result") or err))
    if schema and res.get("structured_output") is not None:
        return json.dumps(res["structured_output"])
    return (res.get("result") or "").strip()


def _claude_problem(text):
    t = (text or "").strip()
    if re.search(r"log ?in|not logged|authenticat|/login", t, re.I):
        return "Claude Code isn't signed in. Open Terminal, type claude, sign in, then try again."
    if re.search(r"usage limit|rate limit|limit reached", t, re.I):
        return "Your Claude plan hit its usage limit. Try again when it resets."
    return t[-300:] or "Claude Code stopped without an answer."


def _ask_codex(system, messages, schema):
    with tempfile.TemporaryDirectory() as tmp:
        text, images = [], []
        for b in _blocks(messages):
            if b["type"] == "text":
                text.append(b["text"])
            elif b["type"] == "image":
                ext = {"image/png": "png", "image/webp": "webp"}.get(b["source"]["media_type"], "jpg")
                p = os.path.join(tmp, f"image{len(images) + 1}.{ext}")
                with open(p, "wb") as f:
                    f.write(base64.b64decode(b["source"]["data"]))
                images.append(p)
                text.append(f"(image {len(images)} attached)")
        prompt = f"<instructions>\n{system}\n</instructions>\n\n" + "\n".join(text)
        last = os.path.join(tmp, "answer.txt")
        cmd = [codex_cli(), "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only",
               "--color", "never", "-C", tmp, "-o", last]
        if schema:
            sp = os.path.join(tmp, "schema.json")
            with open(sp, "w", encoding="utf-8") as f:
                json.dump(schema, f)
            cmd += ["--output-schema", sp]
        for p in images:
            cmd += ["-i", p]
        cmd.append("-")  # the prompt comes on stdin
        out, err, code = _run(cmd, prompt, cwd=tmp)
        answer = open(last, encoding="utf-8").read().strip() if os.path.exists(last) else ""
    if not answer:
        raise RuntimeError(_codex_problem(err or out))
    return answer


def _codex_problem(text):
    t = (text or "").strip()
    if re.search(r"log ?in|not logged|authenticat|401", t, re.I):
        return "Codex isn't signed in. Open Terminal, type codex, sign in with ChatGPT, then try again."
    if re.search(r"usage limit|rate limit|limit reached", t, re.I):
        return "Your ChatGPT plan hit its usage limit. Try again when it resets."
    return t[-300:] or "Codex stopped without an answer."


def _json(line):
    try:
        return json.loads(line)
    except ValueError:
        return None


# --- agent(): the chat and the weekly review ---

def agent(system, prompt, session="", edit=False, key=None, timeout=900):
    """Runs Claude Code or Codex in this folder. edit=True lets it change files (the chat), else it only reads.
    Returns dict(answer, session, changed: files it edited, stopped)."""
    e = check()
    if e in ("claude", "claude_key"):
        if not claude_cli():
            raise NotSetUp("The chat runs on Claude Code. Install it from claude.com/claude-code, then try again.")
        return _agent_claude(system, prompt, session, edit, key, timeout)
    return _agent_codex(system, prompt, session, edit, key, timeout)


def _agent_claude(system, prompt, session, edit, key, timeout):
    tools = ["Read", "Glob", "Grep"] + (["Edit", "Write", "WebSearch", "WebFetch"] if edit else [])
    cmd = [claude_cli(), "-p", "--model", CLAUDE_MODEL, "--output-format", "stream-json", "--verbose",
           "--append-system-prompt", system, "--permission-mode", "acceptEdits" if edit else "default",
           "--allowedTools", ",".join(tools), "--strict-mcp-config"]
    if re.fullmatch(r"[0-9a-f-]{36}", session or ""):
        cmd += ["--resume", session]
    out, err, _ = _run(cmd, prompt, env=_claude_env(), timeout=timeout, key=key)  # on stdin: a message starting with "-" would read as an option
    result, changed, started = None, [], session
    for ev in filter(None, map(_json, out.splitlines())):
        if ev.get("type") == "system" and ev.get("session_id"):
            started = ev["session_id"]
        elif ev.get("type") == "result":
            result = ev
        elif ev.get("type") == "assistant":
            for p in ev["message"].get("content") or []:
                if p.get("type") == "tool_use" and p.get("name") in ("Edit", "Write"):
                    changed.append(os.path.relpath(p["input"].get("file_path", ""), BASE))
    if "No conversation found" in ((result or {}).get("result") or "") + err and session:
        return _agent_claude(system, prompt, "", edit, key, timeout)  # the saved chat is gone: start a fresh one
    if not result or result.get("is_error"):
        return dict(answer="", session=started, changed=changed, error=_claude_problem((result or {}).get("result") or err))
    return dict(answer=result["result"].strip(), session=result.get("session_id", started), changed=changed)


def _agent_codex(system, prompt, session, edit, key, timeout):
    mode = "workspace-write" if edit else "read-only"
    if re.fullmatch(r"[0-9a-f-]{36}", session or ""):  # resume takes the sandbox as a setting, not a flag
        cmd = [codex_cli(), "exec", "resume", "--skip-git-repo-check", "--json", "-c", f'sandbox_mode="{mode}"', session, "-"]
        text = prompt
    else:
        cmd = [codex_cli(), "exec", "--skip-git-repo-check", "--json", "--color", "never", "--sandbox", mode, "-C", BASE, "-"]
        text = f"<instructions>\n{system}\n</instructions>\n\n{prompt}"
    out, err, _ = _run(cmd, text, timeout=timeout, key=key)
    answer, changed, started, problem = "", [], session, ""
    for ev in filter(None, map(_json, out.splitlines())):
        t = ev.get("type")
        if t == "thread.started":
            started = ev.get("thread_id") or started
        elif t == "item.completed":
            it = ev.get("item") or {}
            if it.get("type") == "agent_message":
                answer = it.get("text") or answer
            elif it.get("type") == "file_change":
                changed += [os.path.relpath(c.get("path", ""), BASE) for c in it.get("changes") or []]
        elif t in ("error", "turn.failed"):
            problem = (ev.get("message") or (ev.get("error") or {}).get("message") or "")
    if not answer:
        return dict(answer="", session=started, changed=changed, error=_codex_problem(problem or err))
    return dict(answer=answer.strip(), session=started, changed=changed)


def stop(key):
    proc = RUNNING.get(key)
    if proc:
        _kill(proc)
    return bool(proc)
