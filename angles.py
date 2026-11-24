"""Angles: your context packets, each one angle to talk about your topic or product in ("budgeting is a weekly habit").

One of them can be the focus. The chat (studio.py) and the script writer (app.py) add the focus to what they're
told on every message, so anything they write takes that angle. Kept in angles.json.
"""
import json
import os
import threading
import time
import uuid

from flask import Blueprint, jsonify, request

bp = Blueprint("angles", __name__)
D = {}  # handed over by app.py: base
_lock = threading.Lock()


def path():
    return os.path.join(D["base"], "angles.json")


def load():
    try:
        with open(path(), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    data.setdefault("focus", None)
    data.setdefault("packets", [])
    if data["focus"] and not any(p["id"] == data["focus"] for p in data["packets"]):
        data["focus"] = None
    return data


def save(data):
    tmp = path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path())


def focus():
    """The packet in focus, or None."""
    data = load()
    return next((p for p in data["packets"] if p["id"] == data["focus"]), None)


def focus_block():
    """What the chat and script writer are told about the focus angle; empty if there is none."""
    p = focus()
    if not p:
        return ""
    return (f'<focus_angle name="{p["name"]}">\n{p["body"].strip()}\n</focus_angle>\n'
            "This is the angle the creator is focusing on right now. Frame what you write through this angle: its "
            "problem, its audience and its promise. Facts about them and what they offer still come only from "
            "context.md; the angle picks which of them to lead with. If they ask for a different angle, use theirs.")


def clean(b):
    name, body = str(b.get("name") or "").strip()[:120], str(b.get("body") or "").strip()[:20000]
    if not name:
        raise ValueError("Give the angle a name.")
    return name, body


def everything():
    data = load()
    return jsonify(focus=data["focus"], packets=data["packets"])


@bp.get("/angles")
def list_angles():
    return everything()


@bp.post("/angles")
def add_angle():
    try:
        name, body = clean(request.get_json(force=True) or {})
    except ValueError as e:
        return jsonify(error=str(e)), 400
    with _lock:
        data = load()
        p = dict(id=uuid.uuid4().hex[:10], name=name, body=body, updated=time.strftime("%Y-%m-%dT%H:%M:%S"))
        data["packets"].append(p)
        if not data["focus"]:
            data["focus"] = p["id"]  # the first one is the focus straight away
        save(data)
    return everything()


@bp.put("/angles/<pid>")
def edit_angle(pid):
    try:
        name, body = clean(request.get_json(force=True) or {})
    except ValueError as e:
        return jsonify(error=str(e)), 400
    with _lock:
        data = load()
        p = next((p for p in data["packets"] if p["id"] == pid), None)
        if not p:
            return jsonify(error="That angle is gone. Refresh the page."), 404
        p.update(name=name, body=body, updated=time.strftime("%Y-%m-%dT%H:%M:%S"))
        save(data)
    return everything()


@bp.delete("/angles/<pid>")
def delete_angle(pid):
    with _lock:
        data = load()
        data["packets"] = [p for p in data["packets"] if p["id"] != pid]
        if data["focus"] == pid:
            data["focus"] = None
        save(data)
    return everything()


@bp.post("/angles/focus")
def set_focus():
    pid = (request.get_json(force=True) or {}).get("id") or None
    with _lock:
        data = load()
        if pid and not any(p["id"] == pid for p in data["packets"]):
            return jsonify(error="That angle is gone. Refresh the page."), 404
        data["focus"] = pid
        save(data)
    return everything()


def register(app, **deps):
    D.update(deps)
    app.register_blueprint(bp)
