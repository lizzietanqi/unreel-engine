"""Studio: reverse engineer posts that performed, and write your own versions of them.

A study is a saved set of posts (studies/<id>.json). The chat runs Claude Code or Codex in this folder (engine.py), so it can read and change the study's files itself.
The page keeps the chat's session id; a refresh or New chat starts a new session.
Each post's breakdown is made once and saved in breakdowns/<transcript>.json, so every study reuses it.
Claude refers to posts as P1, P2... in the study's current order; saved text stores [[file]] instead, so
renumbering never points at the wrong post.
"""
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import threading
import uuid
from datetime import datetime

from flask import Blueprint, current_app, jsonify, request

import angles
import engine

bp = Blueprint("studio", __name__)
D = {}  # handed over by app.py: base, out_dir, read_post, load_context, setup_error, model


def register(app, **deps):
    D.update(deps)
    for folder in ("studies", "breakdowns"):
        os.makedirs(os.path.join(D["base"], folder), exist_ok=True)
    app.register_blueprint(bp)


BD_VERSION = 6  # older breakdowns are redone the next time the post is opened
POINTS_V = 2  # older points are redone on their own (card and chunks stay) the next time the post is opened
FORMATS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "formats.json"), encoding="utf-8"))
FORMAT_NAMES = {f["name"]: f for f in FORMATS["formats"]}

# The 14 beats every card is built from (beats.json, on the Formats page's Beats tab). Older cards keep their own
# beat names; the app shows each as one of the 14 ("was" lists which).
BEATS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "beats.json"), encoding="utf-8"))["beats"]
BEAT_NAMES = {b["name"]: b for b in BEATS}
BEAT_OF = {n.lower(): b for b in BEATS for n in [b["name"]] + b["was"]}
BEAT_WORDS = (("cta", "CTA"), ("hook", "Hook"), ("step", "Steps"), ("proof", "Proof"), ("payoff", "Payoff"), ("example", "Example"),
              ("demo", "Example"), ("reframe", "Reframe"), ("why", "Why"), ("catch", "Catch"), ("setup", "Setup"), ("struggle", "Struggle"))


def beat_kind(name, i, last):
    """Which of the 14 a beat name is. A name the list doesn't know goes by its words, then by where it sits."""
    n = name.strip().lower()
    if n in BEAT_OF:
        return BEAT_OF[n]["name"]
    word = next((k for w, k in BEAT_WORDS if w in n), None)
    return word or ("Hook" if i == 0 else "CTA" if i == last else "Steps")


def std_beats(beats):
    """Beats named from the 14. A beat that comes up more than once in a card is numbered: Step 1, Step 2."""
    out = []
    for i, b in enumerate(beats):
        kind = b.get("kind") if b.get("kind") in BEAT_NAMES else beat_kind(b["name"], i, len(beats) - 1)
        was = b.get("was") or (b["name"] if b["name"] != kind else "")
        out.append(dict(b, name=kind, kind=kind, one=BEAT_NAMES[kind]["one"], **({"was": was} if was else {})))
    count = {}
    for b in out:
        count[b["kind"]] = count.get(b["kind"], 0) + 1
    seen = {}
    for b in out:
        if count[b["kind"]] > 1:
            seen[b["kind"]] = seen.get(b["kind"], 0) + 1
            b["name"] = f'{b["one"]} {seen[b["kind"]]}'
    return out


def std_card(c):
    return dict(c, beats=std_beats(c["beats"])) if c.get("beats") else c


def card_shape(c):
    """A card's beats as kinds, leaving out optional beats and repeats in a row. Two cards with the same shape are one card."""
    out = []
    for b in std_card(c).get("beats", []):
        if not b.get("optional") and (not out or out[-1] != b["kind"]):
            out.append(b["kind"])
    return tuple(out)


def same_card(a, b):
    """Two cards are one when their shapes match, or are one beat apart (added, dropped or swapped) and both have 4 or more."""
    x, y = card_shape(a), card_shape(b)
    if x == y:
        return True
    if min(len(x), len(y)) < 4 or abs(len(x) - len(y)) > 1:
        return False
    d = list(range(len(y) + 1))  # edit distance
    for i, p in enumerate(x, 1):
        prev, d[0] = d[0], i
        for j, q in enumerate(y, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (p != q))
    return d[-1] <= 1


# Cards the Studio made for posts that fit no card in the index yet: {format name: [card, ...]} in cards.json.
# Later posts of the same kind match them, so each new beat structure becomes a card once.
cards_lock = threading.Lock()


def cards_path():
    return os.path.join(D["base"], "cards.json")


def learned_cards():
    try:
        learned = json.load(open(cards_path(), encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {f: [std_card(c) for c in cards if c.get("beats")] for f, cards in learned.items()}  # older cards had no beats


def cards_of(fmt, learned=None):
    return [std_card(c) for c in fmt["cards"]] + (learned if learned is not None else learned_cards()).get(fmt["name"], [])


CARD_FIELDS = ("use_when", "needs", "length", "reframe", "beats", "flex")  # a card, the way formats.json writes it


def card_text(c):
    if not c.get("beats"):
        return f'use when {c["use_when"]} Needs {c["needs"]} (No beats written yet.)'
    return (f'use when {c["use_when"]} Needs {c["needs"]} Reframe goes in: {c["reframe"]} Beats: '
            + " ".join(f'{i}. {b["name"]}: {b["job"]}' for i, b in enumerate(c["beats"], 1)))


def formats_text():
    """The format list from formats.json plus the Studio's own cards, as Claude reads it."""
    out, learned = [], learned_cards()
    for cat in FORMATS["categories"]:
        out.append(f"{cat}:")
        for f in (f for f in FORMATS["formats"] if f["category"] == cat):
            out.append(f'- {f["name"]} (short name "{f["short"]}"). The idea has: {f["idea_has"]}. Cards:')
            out += [f'  - "{c["name"]}"' + (" (made by the Studio)" if c.get("first_post") else "") + f": {card_text(c)}"
                    for c in cards_of(f, learned)]
    return "\n".join(out + ["", "Close calls:"] + [f"- {c}" for c in FORMATS["close_calls"]])


def remember_card(c, file):
    """A post that fit no card becomes a new card under its format."""
    if not c["beats"]:
        return
    with cards_lock:
        learned = learned_cards()
        if any(k["name"].lower() == c["name"].lower() or (k.get("beats") and same_card(k, c)) for k in cards_of(FORMAT_NAMES[c["format"]], learned)):
            return
        learned.setdefault(c["format"], []).append(dict(name=c["name"], **{k: c[k] for k in CARD_FIELDS},
                                                        first_post=file, at=datetime.now().strftime("%Y-%m-%d %H:%M")))
        with open(cards_path(), "w", encoding="utf-8") as f:
            json.dump(learned, f, indent=1, ensure_ascii=False)


# Jobs and devices, from the "Formats, Beats, Jobs, Devices" doc
JOB_DEVICES = {
    "stop the scroll": "bold claim, call out the viewer, specific number, something that sounds wrong",
    "make them feel seen": "their exact words, confession, a moment they'll recognise",
    "name the problem": "name the hidden cause, put a cost on it, one plain sentence",
    "raise the stakes": "consequence, what it costs now, what happens if nothing changes",
    "create curiosity": "open loop, belief vs truth gap, tease the best part",
    "shift belief": "contrast, flip the cause, it's not X it's Y",
    "build trust": "real example, result with numbers, show the work, screen recording",
    "handle a doubt": "name the objection first, admit the limit",
    "teach": "steps, one rule, simple example, before and after",
    "deliver the payoff": "one-line takeaway, callback to the hook, result shown",
    "get the action": "one clear ask, reason to act now, comment keyword",
}

# What a post argues, not a retelling of it: a walkthrough's setup and steps are proof for a point, never points.
# Shared by the full breakdown and the points-only redo.
POINTS_RULES = """points: the argument the post makes, not a retelling of it. Ask: if a friend asked what this post is really saying, what would you tell them?
- First the main point, role "main": the one idea the post argues, as a takeaway the viewer could believe or act on. It comes first even when the post only gets to it at the end.
- Then 2 to 4 supporting points, role "support", most important first: the reasons that make the main point true. Often the problem it solves, why that problem happens, and what changes once you act on it.
- The swap test, for every point: would it still be true if you swapped out the specific tool, product, person or setup the post uses? If not, it is not a point but proof, and goes in the proof of the point it backs. The parts of a setup, the steps of a walkthrough, product names and features, a famous name for credibility, stories, demos and numbers are proof, never points. Steps only count as points when each one is a general rule that works anywhere.
- The call to action is never a point.
- A point the post clearly relies on but never says outright (like the problem a setup solves) still counts. Give it the lines that come closest to saying it.
- For each: from and to, the one to three lines where the point itself is said most directly, not where its proof is (never the whole post, even for the main point); summary, under 12 words, plain words about the idea itself, naming the actual thing, never quoting the post; kind, one of problem, cause, fix, claim, reframe, lesson, myth; proof, what in the post backs it up and where, under 15 words, like "the Notion founder's five-page setup (lines 5-9)", or "".
Like this, for a reel walking through a creator's four-tab budgeting spreadsheet:
  main: "Check your spending weekly, not monthly, and a budget actually sticks"
  support: "A monthly review comes too late to change anything" (proof: "her overspent March (lines 2-3)")
  support: "A weekly check takes minutes, so it becomes a habit" (proof: "the four-tab spreadsheet (lines 5-9)")
  support: "Seeing it early lets you fix the week instead of regretting the month" (proof: "cutting takeout mid-week (lines 10-11)")
Not "The first tab logs every purchase" or "The sheet has four tabs": those are the setup, so they are proof."""

BREAKDOWN_PROMPT = """You reverse engineer one Instagram post that performed well (a reel's transcript or a carousel's slide text), so a content strategist can see why it works and write their own version of it. The text comes as numbered lines.

How to think about it: a viewer decides every second whether to keep watching. They stay for one of two reasons: a question they want answered, or value they are getting right now. Find the one idea the post sells, the reusable shape it uses, and what keeps the viewer watching at each line.

spine:
- big_idea: the one thing the viewer should leave believing, one sentence under 20 words. The message, not the topic.
- before and after: what the viewer believed or felt before watching, and after. Short and in the viewer's own words, like "I'm not getting anywhere" and "I'm probably closer than I think".
- viewer: who it is written for, under 12 words, based on what the post says.
- format: the reusable shape with the topic taken out, 3 to 6 steps joined by " → ", like "riddle → hidden lesson → this is you → demo → comment for the link". Any topic should fit into it.
- hook_type: one of question, bold claim, negative, number, story, callout, demo, contrast, secret.
- hook_promise: what the opening makes the viewer expect to get, under 15 words.
- hook_paid: the line number where that promise is delivered, or 0 if it never is.
- ask: the call to action and what it trades on, under 15 words, or "" if there is none.
- why: 2 or 3 reasons this post holds attention and lands, each under 15 words and specific to this post, like "the riddle makes you guess before it teaches". Say how it works, don't praise it.

POINTS_RULES

card: the post's format card, so the creator can reuse its format on their own ideas. Every post belongs to one of the formats below, and each format has cards. Pick the category first (Educational teaches something; Storytelling tells something that happened to the creator), then the format, then the card.
- format: the format's name, copied exactly from the list.
- name: if one of the format's cards fits this post, that card's name, copied exactly. It fits when the post follows the card's beats in roughly that order (skipping optional beats, merging two, or a beat taking several chunks, is fine). Check every card of the format before deciding none fits: a card whose beats match is the right card even if its name sounds different. If none fits, a short name for this new kind of post, 2 to 4 words in sentence case, like the card names in the list ("Answer first", "Result first").
- For a listed card that has beats, leave use_when, needs, length and reframe as "", and beats and flex empty: the app fills them in. For a new card, or a listed card with no beats yet, write them in the same style as the cards in the list:
  - use_when: when to use it, like "there's a pain people know, and a fix I actually use."
  - needs: what the creator must have, then what to do without it, like "a real experience. Missing → don't use this format."
  - length: like "30 to 60 seconds, about 8 to 12 lines."
  - reframe: which beat the reframe goes in, and how, like "beat 3. Never line 1."
  - beats: 4 to 8, in order. name: one of the beats below, copied exactly. Use each beat once: several steps, struggles or examples in a row are one beat ("Steps"), and the chunks fill it once per step. job: what it does in this card, under 20 words, general enough for any topic, starting with "optional." when the card works without it. sources: 1 to 3 sections of an angle doc that feed it, each copied exactly from: ANGLE_SECTIONS.
    The beats:
BEAT_LIST
  - flex: 2 to 4 short notes on what can drop, merge or change, like "Beats 5 and 6 can merge."

said: for each beat of the card the post fills, the point the post makes there, paraphrased in your own words so it makes sense on its own to someone who hasn't seen the post. Never quote the post's lines: name the actual thing instead of "it" or "this". Under 12 words, about the post's own topic, not the beat's general job. Like "The fix is Claude's built-in advisor setting", not "It's called advisor" (a quote) or "names the fix" (the general job). beat: the beat's number. Leave out beats the post doesn't fill.

chunks: then split every line into chunks, in order, covering every line with no gaps or overlaps. A new chunk starts when the viewer's question changes, so one beat of the card can take several chunks (each step of a "Steps" beat is its own chunk). For each chunk:
- from and to: its lines.
- beat: the number of the card beat it fills, 1 for the first. 0 only for filler or a slide number.
- job: what the chunk achieves for the viewer, the thing that breaks if it's cut. One of: JOBS.
- device: how exactly it does that job, 1 to 5 words in lowercase. These work best for each job:
DEVICE_LIST
  Copy one of these word for word whenever it fits. Only when none does, name a new one in the same style, general enough to reuse on any topic ("numbered layers", not "second-order layer").
- opens: if the chunk raises a question the viewer has to wait to get answered, number it (1, 2 and so on), else 0. A hook usually opens one. closes: the number of the question this chunk answers, else 0.
- wonder: what the viewer is wondering right after this chunk, the thing that keeps them watching, as a short question in their words, like "wait, so what's the answer?". "" for the last chunk.

The formats:
FORMAT_LIST

Plain words, no em dashes."""

def ask_claude(system, messages, schema=None, effort="medium"):
    """One question to whichever AI is picked (engine.py). With a schema, the answer is JSON that fits it."""
    return engine.ask(system, messages, schema=schema, effort=effort)


# Kept simple on purpose: a schema with many lists of fixed choices is too big for Claude's structured output
TEXT, NUM = {"type": "string"}, {"type": "integer"}


def obj(**props):
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def many(item):
    return {"type": "array", "items": item}


# --- Breakdowns: one per post ---

def bd_path(file):
    return os.path.join(D["base"], "breakdowns", os.path.splitext(os.path.basename(file))[0] + ".json")


def post_lines(post):
    return [line.strip() for line in (post["transcript"] or "").split("\n") if line.strip()]


def load_breakdown(file):
    """The saved breakdown, or None if there isn't one in the current shape."""
    p = bd_path(file)
    if not os.path.exists(p):
        return None
    bd = json.load(open(p, encoding="utf-8"))
    if bd.get("v") != BD_VERSION:
        return None
    if bd.get("card"):
        bd["card"] = std_card(bd["card"])
    if bd.get("pv") != POINTS_V and bd.get("lines"):
        bd["points_old"] = True  # the page asks for it again, and only its points are redone
    return bd


SPAN = {"from": NUM, "to": NUM}
BREAKDOWN_SCHEMA = obj(
    spine=obj(big_idea=TEXT, before=TEXT, after=TEXT, viewer=TEXT, format=TEXT, hook_type=TEXT, hook_promise=TEXT,
              hook_paid=NUM, ask=TEXT, why=many(TEXT)),
    points=many(obj(**SPAN, summary=TEXT, role=TEXT, kind=TEXT, proof=TEXT)),
    card=obj(format=TEXT, name=TEXT, use_when=TEXT, needs=TEXT, length=TEXT, reframe=TEXT,
             beats=many(obj(name=TEXT, job=TEXT, sources=many(TEXT))), flex=many(TEXT)),
    said=many(obj(beat=NUM, said=TEXT)),
    chunks=many(obj(**SPAN, beat=NUM, job=TEXT, device=TEXT, opens=NUM, closes=NUM, wonder=TEXT)))


def beat_list():
    return "\n".join(f'    - {b["name"]}: {b["about"]}' for b in BEATS)


def breakdown_prompt():
    return (BREAKDOWN_PROMPT.replace("POINTS_RULES", POINTS_RULES).replace("FORMAT_LIST", formats_text())
            .replace("ANGLE_SECTIONS", "; ".join(FORMATS["angle_sections"]))
            .replace("BEAT_LIST", beat_list())
            .replace("JOBS", "; ".join(JOB_DEVICES))
            .replace("DEVICE_LIST", "\n".join(f"- {k}: {v}" for k, v in JOB_DEVICES.items())))


def make_breakdown(file):
    post = D["read_post"](file)
    lines = post_lines(post)
    bd = dict(v=BD_VERSION, pv=POINTS_V, file=file, lines=lines, spine=None, points=[], chunks=[])
    if lines:
        numbered = "\n".join(f"{i}: {line}" for i, line in enumerate(lines, 1))
        found = json.loads(ask_claude(breakdown_prompt(), [{"role": "user", "content":
                f"Type: {post['kind']}\n\n<lines>\n{numbered}\n</lines>"}], schema=BREAKDOWN_SCHEMA))
        bd.update(clean_breakdown(found, len(lines)))
        if bd["card"]["source"] == "new":
            remember_card(bd["card"], file)
    bd["at"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    with open(bd_path(file), "w", encoding="utf-8") as f:
        json.dump(bd, f, indent=1)
    return bd


def clean_breakdown(d, n):
    """Keep line numbers inside the post, chunks in order without overlaps, one main point, known beats."""
    def span(x):
        a = min(max(int(x["from"]), 1), n)
        return a, min(max(int(x["to"]), a), n)

    spine = d["spine"]
    spine["hook_paid"] = spine["hook_paid"] if 1 <= spine["hook_paid"] <= n else 0
    spine["why"] = [w for w in spine["why"] if w.strip()][:3]
    points = clean_points(d["points"], n)
    card = clean_card(d["card"])
    said = [""] * len(card["beats"])  # per card beat: what this post says there, "" where it doesn't fill it
    for x in d.get("said", []):
        if 1 <= x["beat"] <= len(said) and x["said"].strip():
            said[x["beat"] - 1] = x["said"].strip()
    return dict(spine=spine, points=points, chunks=clean_chunks(d["chunks"], n, len(card["beats"])), card=card, said=said)


def clean_points(raw, n):
    """Lines inside the post, one main point and it first, the rest in Claude's order (most important first)."""
    points = []
    for p in raw:
        if not p["summary"].strip():
            continue
        a = min(max(int(p["from"]), 1), n)
        points.append(dict(start=a, end=min(max(int(p["to"]), a), n, a + 2), summary=p["summary"].strip(),
                           main=p["role"] == "main" and not any(x["main"] for x in points), kind=p["kind"], proof=p["proof"].strip()))
    if points and not any(p["main"] for p in points):
        points[0]["main"] = True
    points.sort(key=lambda p: not p["main"])
    for i, p in enumerate(points, 1):
        p["n"] = i
    return points


POINTS_PROMPT = """You read one Instagram post that performed well (a reel's transcript or a carousel's slide text), so a content strategist can see what it is really arguing. The text comes as numbered lines.

""" + POINTS_RULES + "\n\nPlain words, no em dashes."
POINTS_SCHEMA = obj(points=many(obj(**SPAN, summary=TEXT, role=TEXT, kind=TEXT, proof=TEXT)))


def redo_points(file, bd):
    """Only the points, by the current rules. The card, chunks and spine stay as they are."""
    numbered = "\n".join(f"{i}: {line}" for i, line in enumerate(bd["lines"], 1))
    found = json.loads(ask_claude(POINTS_PROMPT, [{"role": "user", "content": f"<lines>\n{numbered}\n</lines>"}], schema=POINTS_SCHEMA))
    bd.pop("points_old", None)
    bd.update(points=clean_points(found["points"], len(bd["lines"])), pv=POINTS_V)
    saved = json.load(open(bd_path(file), encoding="utf-8"))
    saved.update(points=bd["points"], pv=POINTS_V)
    with open(bd_path(file), "w", encoding="utf-8") as f:
        json.dump(saved, f, indent=1)
    return bd


def clean_chunks(raw, n, beats):
    """Chunks in order inside the lines, without overlaps, each on a known beat (0 if not)."""
    def span(x):
        a = min(max(int(x["from"]), 1), n)
        return a, min(max(int(x["to"]), a), n)

    chunks, last, opened = [], 0, set()
    for c in sorted(raw, key=lambda c: span(c)[0]):
        a, b = span(c)
        if a <= last:
            continue
        opens = int(c["opens"] or 0)
        opened.add(opens)
        closes = int(c["closes"] or 0)
        chunks.append(dict(start=a, end=b, beat=c["beat"] if 1 <= c["beat"] <= beats else 0,
                           job=c["job"].strip().lower(), device=c["device"].strip().lower(), opens=opens,
                           closes=closes if closes in opened else 0, wonder=c["wonder"]))
        last = b
    return chunks


# --- Samples: sample scripts, broken down against their card (Formats page) ---

SAMPLE_V = 1
SAMPLE_PROMPT = """You break down a sample reel transcript, so a creator can see line by line how it fills its format card. You get the format's card or cards, then the transcript as numbered lines.

card: the number of the card the sample follows, 1 for the first. With one card, 1.
beats: only if that card says "(no beats yet)": its 4 to 8 beats, in order, as the sample uses them. name: one of the beats below, copied exactly. Use each beat once: several steps, struggles or examples in a row are one beat ("Steps"), and the chunks fill it once per step. job: what it does, under 20 words, general enough for any topic, starting with "optional." when the card works without it. Otherwise an empty list.
The beats:
BEAT_LIST

"""
SAMPLE_SCHEMA = obj(card=NUM, beats=many(obj(name=TEXT, job=TEXT)),
                    chunks=many(obj(**SPAN, beat=NUM, job=TEXT, device=TEXT, opens=NUM, closes=NUM, wonder=TEXT)))


def sample_prompt():
    rules = BREAKDOWN_PROMPT[BREAKDOWN_PROMPT.index("chunks: then split"):BREAKDOWN_PROMPT.index("\n\nThe formats:")]
    return (SAMPLE_PROMPT.replace("BEAT_LIST", beat_list()) + rules.replace("JOBS", "; ".join(JOB_DEVICES))
            .replace("DEVICE_LIST", "\n".join(f"- {k}: {v}" for k, v in JOB_DEVICES.items())) + "\n\nPlain words, no em dashes.")


def sample_breakdown(fmt, sample, cards):
    """How a sample transcript fills its card: {lines, card (index into cards), beats, chunks}. Saved after the first time."""
    key = re.sub(r"[^a-z0-9]+", "-", f'{sample.get("post") or sample.get("cleve", "")} {sample["title"]}'.lower()).strip("-")[:90]
    path = os.path.join(D["base"], "breakdowns", "samples", key + ".json")
    if os.path.exists(path):
        saved = json.load(open(path, encoding="utf-8"))
        if saved.get("v") == SAMPLE_V:
            return dict(saved, beats=std_beats(saved["beats"])) if saved.get("beats") else saved
    lines = [x for x in sample["lines"] if x.strip()]
    listed = "\n\n".join(f'Card {i}: {c["name"]}\nUse when {c["use_when"]}\n' + (
        "\n".join(f'{j}. {b["name"]}: {b["job"]}' for j, b in enumerate(std_beats(c["beats"]), 1)) if c.get("beats") else "(no beats yet)")
        for i, c in enumerate(cards, 1))
    numbered = "\n".join(f"{i}: {x}" for i, x in enumerate(lines, 1))
    found = json.loads(ask_claude(sample_prompt(), [{"role": "user", "content":
            f"Format: {fmt}\n\n{listed}\n\n<lines>\n{numbered}\n</lines>"}], schema=SAMPLE_SCHEMA, effort="low"))
    card = min(max(int(found["card"]), 1), len(cards)) - 1
    beats = cards[card].get("beats") or [dict(name=b["name"].strip(), job=b["job"].strip(), optional=b["job"].lower().startswith("optional"),
                                               sources=[]) for b in found["beats"] if b["name"].strip()]
    out = dict(v=SAMPLE_V, lines=lines, card=card, beats=None if cards[card].get("beats") else beats,
               chunks=clean_chunks(found["chunks"], len(lines), len(beats)), at=datetime.now().strftime("%Y-%m-%d %H:%M"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    return dict(out, beats=std_beats(out["beats"])) if out["beats"] else out


def clean_card(c):
    """Snap the card to the format list. A listed card is used exactly as written there."""
    fmt = FORMAT_NAMES.get(c["format"]) or next((f for f in FORMATS["formats"] if f["short"].lower() == c["format"].lower()),
                                                FORMATS["formats"][3])
    name = c["name"].strip().lower()
    if not any(k["name"].lower() == name for k in cards_of(fmt)):  # a listed card's name under the wrong format: go by the card
        learned = learned_cards()
        fmt = next((f for f in FORMATS["formats"] if any(k["name"].lower() == name and k.get("beats") for k in cards_of(f, learned))), fmt)
    c.update(format=fmt["name"], category=fmt["category"], short=fmt["short"], status=fmt["status"])
    cards = cards_of(fmt)
    match = next((k for k in cards if k["name"].lower() == c["name"].strip().lower()), None)
    if not match or not match.get("beats"):
        c["beats"] = std_beats([dict(name=b["name"].strip(), job=b["job"].strip(), optional=b["job"].lower().startswith("optional"),
                                     sources=[x for x in b["sources"] if x in FORMATS["angle_sections"]]) for b in c["beats"] if b["name"].strip()])
    if not match and c["beats"]:  # a "new" card with the same beats as a card the format has is that card
        match = next((k for k in cards if k.get("beats") and same_card(k, c)), None)
    c["source"] = "new" if not match else "studio" if match.get("first_post") else "index"
    if match:
        c["name"] = match["name"]
        if match.get("beats"):
            c.update({k: match[k] for k in CARD_FIELDS})
            return c
    c["flex"] = [f for f in c["flex"] if f.strip()][:4]
    return c


def breakdowns_for(files):
    return {f: load_breakdown(f) for f in files}


def drop_breakdown(file):
    """The post's text changed: its breakdown is made again the next time it's opened."""
    if os.path.exists(bd_path(file)):
        os.remove(bd_path(file))


def forget_post(file):
    """A transcript was deleted: drop its breakdown and take it out of every study."""
    if os.path.exists(bd_path(file)):
        os.remove(bd_path(file))
    for s in all_studies():
        if file in s["files"]:
            s["files"].remove(file)
            save_study(s)


# --- Studies ---

def study_path(sid):
    return os.path.join(D["base"], "studies", re.sub(r"[^0-9a-f]", "", sid) + ".json")


def load_study(sid):
    p = study_path(sid)
    if not sid or not os.path.exists(p):
        raise LookupError("That study doesn't exist.")
    return json.load(open(p, encoding="utf-8"))


def save_study(s):
    s["updated"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    with open(study_path(s["id"]), "w", encoding="utf-8") as f:
        json.dump(s, f, indent=1)


def all_studies():
    folder = os.path.join(D["base"], "studies")
    out = []
    for name in os.listdir(folder):
        if name.endswith(".json"):
            try:
                out.append(json.load(open(os.path.join(folder, name), encoding="utf-8")))
            except Exception:
                continue
    return sorted(out, key=lambda s: s.get("updated", ""), reverse=True)


def existing(files):
    return [f for f in dict.fromkeys(os.path.basename(f) for f in files or [])
            if f.endswith(".txt") and os.path.exists(os.path.join(D["out_dir"], f))]


def study_view(s):
    """A study as the page needs it: drop posts that left history, attach each post's breakdown."""
    files = existing(s["files"])
    if files != s["files"]:
        s["files"] = files
        save_study(s)
    return dict(study=s, breakdowns=breakdowns_for(files))


# --- Talking to Claude about a study: P labels in prompts, [[file]] in what we save ---

def to_files(value, files):
    """Swap the P labels in Claude's answer for [[file]], which survive reordering."""
    if isinstance(value, dict):
        return {k: to_files(v, files) for k, v in value.items()}
    if isinstance(value, list):
        return [to_files(v, files) for v in value]
    if isinstance(value, str):
        def swap(m):
            k = int(m.group(1))
            return f"[[{files[k - 1]}]]" if 1 <= k <= len(files) else m.group(0)
        value = re.sub(r"\[P(\d+)\]", swap, value)
        bare = re.fullmatch(r"\[?P(\d+)\]?", value.strip())
        if bare and 1 <= int(bare.group(1)) <= len(files):  # a field that is just a label
            return f"[[{files[int(bare.group(1)) - 1]}]]"
    return value


def to_labels(text, files):
    return re.sub(r"\[\[([^\]]+)\]\]", lambda m: f"[P{files.index(m.group(1)) + 1}]" if m.group(1) in files
                  else "[a post no longer in this study]", text)


def posts_text(files, bds):
    parts = []
    for i, f in enumerate(files, 1):
        post, bd = D["read_post"](f), bds.get(f) or {}
        lines = "\n".join(f"{n}: {line}" for n, line in enumerate(bd.get("lines") or post_lines(post), 1)) or "(no text)"
        sp = bd.get("spine")
        spine = (f"Big idea: {sp['big_idea']}\nBelief shift: \"{sp['before']}\" → \"{sp['after']}\"\nFor: {sp['viewer']}\n"
                 f"Format: {sp['format']}\nHook: {sp['hook_type']}, promises {sp['hook_promise']}"
                 + (f" (paid off on line {sp['hook_paid']})" if sp["hook_paid"] else " (never paid off)")
                 + f"\nAsk: {sp['ask'] or 'none'}\nWhy it works: {'; '.join(sp['why'])}") if sp else "(not broken down)"
        points = "\n".join(f"{p['n']}. ({'main' if p['main'] else 'support'}, {p['kind']}, lines {p['start']}-{p['end']}) "
                           f"{p['summary']}" + (f" Proof: {p['proof']}" if p["proof"] else "") for p in bd.get("points", []))
        cd = bd.get("card")
        names = [b["name"] for b in cd["beats"]] if cd else []
        chunks = "\n".join(f"lines {c['start']}-{c['end']}: " + (f"beat {c['beat']} ({names[c['beat'] - 1]})" if c["beat"] else "filler")
                           + f", job: {c['job']}, device: {c['device']}" + (f", opens question {c['opens']}" if c["opens"] else "")
                           + (f", answers question {c['closes']}" if c["closes"] else "")
                           + (f". Viewer wonders: {c['wonder']}" if c["wonder"] else "") for c in bd.get("chunks", []))
        card = (f"{cd['category']} › {cd['format']}, card \"{cd['name']}\""
                + {"index": " (from formats.json)", "studio": " (made by the Studio)", "new": " (new)"}[cd["source"]]
                + f"\nUse when: {cd['use_when']}\nNeeds: {cd['needs']}\nLength: {cd['length']}\nReframe goes in: {cd['reframe']}\nBeats:\n"
                + "\n".join(f"{i}. {b['name']}: {b['job']}" for i, b in enumerate(cd["beats"], 1))
                + (f"\nFlex: {'; '.join(cd['flex'])}" if cd["flex"] else "")) if cd else "(none)"
        nums = ", ".join(f"{v:,} {k}" for k, v in post["stats"].items()) or "not known"
        parts.append(f'<post label="P{i}">\nBy: {post["author"] or "unknown"}\nType: {post["kind"]}\nNumbers: {nums}\n\n'
                     f"Lines:\n{lines}\n\nFormat card:\n{card}\n\nSpine:\n{spine}\n\nPoints:\n{points or '(none)'}\n\nLine by line:\n{chunks or '(none)'}\n\n"
                     f"Caption:\n{post['caption'] or '(none)'}\n</post>")
    return "\n\n".join(parts)


# --- Chat: Claude Code or Codex, run in this folder (engine.agent) ---

CHAT_PROMPT = """You are the chat inside Unreel Engine, a local app (this folder) that reverse engineers Instagram posts that performed well so the creator using it can write their own. Talk to them like a sharp content strategist: short, plain words, no em dashes. Plain text only: no markdown, so no ** for bold, no # headings, no tables. Talk about the posts in plain words, never the names of fields in the files. When you mention a post, write its label in square brackets, like [P2]; the page turns it into a link.

What's on disk (read what you need, don't guess):
- context.md: who the creator is, what they offer, their audience, their voice and their call-to-action rules (the About you tab of the Context page). Read it before writing anything for them. Never invent numbers or events in their life; leave a fill-in in square brackets, like [the tool you used]. If it's still mostly empty, say once that filling in About you makes scripts sound like them.
- STUDY_FILE: this study. "files" is its posts in order (P1, P2...).
- transcripts/<post>: each post's transcript and caption. breakdowns/<post name>.json: its breakdown (lines, spine, points, its format card, and chunks: each run of lines with the number of the card beat it fills, its job and its device).
- formats.json: the formats and their cards. Don't change it unless they ask. cards.json: format cards the Studio made for posts that fit no card. beats.json: the 14 beats every card is built from, each with what it does; when you write or change a card, name its beats only from that list, and number a beat that repeats (Step 1, Step 2).
- hooks.json: opening lines of sample reels, by format ("lines" is the full script, "hook" its first line).
- The jobs and devices the breakdowns use are listed in studio.py (JOB_DEVICES).
- pillars.json: their content pillars, the themes they post about.
- angles.json: their Angles, each one angle to talk about their topic or product in. "focus" is the id of the one they're focusing on; it's also given to you below as <focus_angle> when there is one. Change it only if they ask.
- analytics/reels.json (only there if they connected Instagram): their OWN Instagram posts and how they did. "posts" is newest first: caption, posted date, stats (views, reach, likes, comments, saves, shares, watch_s: average seconds watched, skip_rate: percent who swiped away in the first seconds), and "history": dated copies of the stats for posts under 60 days old. "followers" is their follower count by day. analytics/words/<post id>.txt: what they say in a reel (only some reels). analytics/meta.json: per post id, length_s (so watch_s / length_s is % watched) and tags (topic: their content pillar, subtopic, format, hook type, cta). When they ask how their content is doing, what's working or what to make next, read these first. Judge a reel against their typical reel (the middle of their recent reels' views), not raw views, and treat reels under 3 days old as still growing. Saves and shares per 1,000 views, watch time and swipe-away rate say more than likes. Point to the reel by its first words or date, and back every claim with its numbers.
- The chat is on every page of the app (Studio, Formats, Analytics, Context), so they may be asking about what they have open there rather than this study.
- If they ask why a reel won't download or something in the app isn't working, read CLAUDE.md: it lists the usual problems and fixes.

You can change these files when they ask: fix a breakdown or a card, rename a card. The page reloads the study after every answer, so changes show up. Keep the JSON valid and its shape unchanged. Don't edit the app's code (.py, .js, .html files) from here: that restarts the app mid-answer. If they want the app changed, say so and suggest they ask Claude Code or Codex in this folder.

When they ask for a script:
- Build it beat by beat. Every line makes the viewer wonder something, or pays off what they were wondering. Cut any line that does neither.
- Open with a hook that makes a clear promise in the first line, and pay it off.
- If the format uses a device (a riddle, analogy, demo or list), make one that truly works and is true. A forced one is worse than none.
- Their voice and audience, from context.md. One sentence per line. 150 spoken words or fewer: count them.
- End with exactly one call to action, following the rules in context.md if there are any.
- Put every script between a line ===SCRIPT=== and a line ===END===, with only the lines they'll say inside. The page shows it as a script they can copy or save. Then one short line on what you kept from the post and what you changed.

The posts in this study:
POSTS
They have open: OPEN"""


STOPPED = set()  # study ids whose answer was stopped from the page


def run_chat(s, files, ask, session, open_file, shown=None, where=""):
    labels = "\n".join(f"- [P{i}] {f}, by {D['read_post'](f)['author'] or 'unknown'}" for i, f in enumerate(files, 1)) or "(none yet)"
    system = (CHAT_PROMPT.replace("STUDY_FILE", os.path.relpath(study_path(s["id"]), D["base"])).replace("POSTS", labels)
              .replace("OPEN", where if where else f"[P{files.index(open_file) + 1}]" if open_file in files else
                       "side by side: " + ", ".join(f"[P{files.index(f) + 1}]" for f in files if not shown or f in shown)))
    focus = angles.focus_block()
    if focus:
        system += "\n\n" + focus
    if s["id"] in engine.RUNNING:
        raise ValueError("The chat is still answering. Wait, or press Stop.")
    found = engine.agent(system, ask, session, edit=True, key=s["id"])
    if s["id"] in STOPPED:  # from the page
        STOPPED.discard(s["id"])
        return dict(answer="", stopped=True, session=found["session"], changed=list(dict.fromkeys(found["changed"])))
    if found.get("error"):
        raise RuntimeError(found["error"])
    return dict(answer=found["answer"], session=found["session"], changed=list(dict.fromkeys(found["changed"])))


def api(fn):
    """Same error handling for every Studio route; full errors go to the terminal so they can be looked at."""
    def wrapped(*a, **kw):
        try:
            return jsonify(fn(*a, **kw))
        except LookupError as e:
            return jsonify(error=str(e)), 404
        except (ValueError, D["setup_error"]) as e:
            return jsonify(error=str(e)), 400
        except Exception as e:
            current_app.logger.exception("Studio request failed")
            return jsonify(error=f"{type(e).__name__}: {str(e)[:300]}"), 500
    wrapped.__name__ = fn.__name__
    return wrapped


def body():
    return request.get_json(silent=True) or {}


@bp.get("/beats")
def beats_list():
    """The 14 beats, for the (i) on a card."""
    return jsonify(BEATS)


@bp.post("/breakdowns/<name>")
@api
def breakdown_make(name):
    """Breaks one post down (again, with redo), and returns it."""
    files = existing([name])
    if not files:
        raise LookupError("That post isn't in your history any more.")
    bd = not body().get("redo") and load_breakdown(files[0])
    if bd and bd.get("points_old"):
        return redo_points(files[0], bd)
    return bd or make_breakdown(files[0])


@bp.get("/studies")
@api
def studies_list():
    return [dict(id=s["id"], name=s["name"], count=len(existing(s["files"])), updated=s.get("updated", ""),
                 files=existing(s["files"])[:4]) for s in all_studies()]


@bp.post("/studies")
@api
def study_new():
    s = dict(id=uuid.uuid4().hex[:12], name=(body().get("name") or "").strip() or "Untitled study",
             files=existing(body().get("files")), created=datetime.now().strftime("%Y-%m-%d %H:%M"), drafts=[])
    save_study(s)
    return study_view(s)


@bp.get("/studies/<sid>")
@api
def study_get(sid):
    return study_view(load_study(sid))


@bp.patch("/studies/<sid>")
@api
def study_update(sid):
    s, b = load_study(sid), body()
    if "name" in b:
        s["name"] = b["name"].strip() or s["name"]
    if "files" in b:
        s["files"] = existing(b["files"])
    save_study(s)
    return study_view(s)


@bp.delete("/studies/<sid>")
@api
def study_delete(sid):
    load_study(sid)
    os.remove(study_path(sid))
    return dict(ok=True)


@bp.post("/studies/<sid>/ask")
@api
def study_ask(sid):
    s, b = load_study(sid), body()
    q = (b.get("question") or "").strip()
    if not q:
        raise ValueError("Type a question first.")
    files = existing(s["files"])
    shown = b.get("shown") if isinstance(b.get("shown"), list) else None
    found = run_chat(s, files, q, str(b.get("session") or ""), str(b.get("open") or ""), shown, str(b.get("where") or "")[:400])
    return dict(found, answer=to_files(found["answer"], files))


@bp.post("/studies/<sid>/ask/stop")
@api
def study_ask_stop(sid):
    if sid in engine.RUNNING:
        STOPPED.add(sid)
        engine.stop(sid)
    return dict(ok=True)
