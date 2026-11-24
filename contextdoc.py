"""Context: context.md, the file the AI reads before it writes for you: who you are, what you offer, your audience, your
voice, your example scripts and the content mix you aim for. The script writer, the chat and Content direction (analytics.py) all
read it. The Context page shows it section by section (one per "# " heading) and saves each edit straight back to the file.

A section is only saved if it still reads the way the page last saw it, so an edit made elsewhere at the same time
(by the chat, or by hand) is never overwritten without you seeing it.

Your content pillars live here too, in pillars.json: [{id, name, about}]. Analytics labels every reel with one of them, and
Content direction suggests reel ideas across them. They start empty.
"""
import os
import re
import json
import threading
import uuid

from flask import Blueprint, jsonify, request

bp = Blueprint("contextdoc", __name__)
D = {}  # handed over by app.py: base, on_change (forget any cached copy)
_lock = threading.Lock()
HEAD = re.compile(r"^# (.*)\n?", re.M)


def path():
    return os.path.join(D["base"], "context.md")


def read():
    try:
        return open(path(), encoding="utf-8").read()
    except OSError:
        return ""


def split(text):
    """The file as its text before the first heading, and [(heading, raw body)], so joining them gives the file back exactly."""
    parts = HEAD.split(text)
    return parts[0], [(parts[i], parts[i + 1]) for i in range(1, len(parts), 2)]


def view(text):
    intro, secs = split(text)
    return dict(intro=intro.strip(), sections=[dict(title=t.strip(), body=b.strip("\n")) for t, b in secs])


@bp.get("/context")
def context_get():
    return jsonify(view(read()))


@bp.put("/context")
def context_put():
    """Save one section: {title, old (the body the page started from), body}."""
    d = request.get_json(force=True) or {}
    title, old, body = (d.get("title") or "").strip(), (d.get("old") or "").strip("\n"), (d.get("body") or "").strip("\n")
    with _lock:
        text = read()
        intro, secs = split(text)
        i = next((i for i, (t, _) in enumerate(secs) if t.strip() == title), None)
        if i is None:
            return jsonify(dict(view(text), error="That section isn't in context.md any more.")), 409
        if secs[i][1].strip("\n") != old:
            return jsonify(dict(view(text), error="This section was changed outside the app, so the latest is shown.")), 409
        last = i == len(secs) - 1
        secs[i] = (secs[i][0], "\n" + body + ("\n" if last else "\n\n"))
        text = intro + "".join(f"# {t}\n{b}" for t, b in secs)
        tmp = path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path())
    if D.get("on_change"):
        D["on_change"]()
    return jsonify(view(text))


DEFAULT_PILLARS = []  # none until you add yours on the Context page


def pillars_path(base=None):
    return os.path.join(base or D["base"], "pillars.json")


def load_pillars(base=None):
    """Your pillars, in your order: [{id, name, about}]."""
    try:
        got = json.load(open(pillars_path(base), encoding="utf-8")).get("pillars")
        if isinstance(got, list):
            return got
    except (OSError, ValueError):
        pass
    return [dict(id=f"p{i}", name=n, about="") for i, n in enumerate(DEFAULT_PILLARS)]


@bp.get("/pillars")
def pillars_get():
    return jsonify(pillars=load_pillars())


@bp.put("/pillars")
def pillars_put():
    """Save the whole list: [{id?, name, about}]. Names stay unique; a new one gets an id."""
    got = (request.get_json(force=True) or {}).get("pillars")
    if not isinstance(got, list):
        return jsonify(error="Send the list of pillars."), 400
    out, seen = [], set()
    for p in got:
        name, about = str(p.get("name") or "").strip()[:80], str(p.get("about") or "").strip()[:1500]
        if name.lower() in seen:
            return jsonify(error=f'There are two pillars called "{name}".'), 400
        if name:
            seen.add(name.lower())
        out.append(dict(id=str(p.get("id") or uuid.uuid4().hex[:8]), name=name, about=about))
    with _lock:
        tmp = pillars_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"pillars": out}, f, ensure_ascii=False, indent=1)
        os.replace(tmp, pillars_path())
    return jsonify(pillars=out)


def register(app, **deps):
    D.update(deps)
    app.register_blueprint(bp)
