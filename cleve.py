"""Save to Cleve: puts a script (or the weekly review) into your own Cleve, in a folder called "Reel scripts".

Cleve is a second brain that plugs into Claude. This is optional: nothing else in the app needs it.
Connect it by pasting a Cleve API key (in Cleve: Settings → Developer → API keys). It's kept in .env as CLEVE_API_KEY.
Uses Cleve's public REST API: https://docs.cleve.ai/developers/api
"""
import json
import os
import urllib.error
import urllib.request

from flask import Blueprint, jsonify, request

import engine

API = "https://app.cleve.ai/api/v1"
FOLDER = "Reel scripts"
bp = Blueprint("cleve", __name__)


def key():
    return os.environ.get("CLEVE_API_KEY", "").strip()


def connected():
    return bool(key())


def call(method, path, body=None, api_key=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + (api_key or key()), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r).get("data")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise PermissionError("Cleve didn't accept that key. Make a new one in Cleve (Settings → Developer → API keys) and paste it again.")
        try:
            msg = json.load(e).get("error", "")
        except Exception:
            msg = ""
        raise RuntimeError(f"Cleve said {e.code}. {msg}".strip())


def folder_id():
    """The "Reel scripts" folder in your Cleve, made the first time."""
    for f in call("GET", "/folders") or []:
        if (f.get("name") or "").strip() == FOLDER and not f.get("parentId"):
            return f.get("_id") or f.get("id") or f.get("folderId")
    return call("POST", "/folders", {"name": FOLDER})["folderId"]


def save(title, content):
    note = call("POST", "/notes", {"title": title, "content": content, "folderId": folder_id()})["noteId"]
    return dict(id=note, link=f"https://app.cleve.ai/notes/{note}")


@bp.get("/cleve")
def cleve_status():
    return jsonify(connected=connected())


@bp.post("/cleve/key")
def cleve_key():
    """Check the key works, then keep it in .env. An empty key disconnects."""
    k = str((request.get_json(silent=True) or {}).get("key") or "").strip()
    if k:
        try:
            call("GET", "/folders", api_key=k)
        except PermissionError as e:
            return jsonify(error=str(e)), 400
        except Exception as e:
            return jsonify(error=f"Couldn't reach Cleve. {str(e)[:200]}"), 502
    engine.env_set("CLEVE_API_KEY", k)
    return jsonify(connected=bool(k))


@bp.post("/cleve/save")
def cleve_save():
    b = request.get_json(silent=True) or {}
    content = str(b.get("content") or "").strip()
    if not content:
        return jsonify(error="Nothing to save."), 400
    if not connected():
        return jsonify(error="Connect Cleve first.", need_key=True), 409
    title = str(b.get("title") or "").strip() or content.split("\n", 1)[0][:60]
    try:
        return jsonify(save(title, content))
    except PermissionError as e:
        return jsonify(error=str(e), need_key=True), 409
    except Exception as e:
        return jsonify(error=f"Couldn't save to Cleve. {str(e)[:200]}"), 502


def register(app):
    app.register_blueprint(bp)
