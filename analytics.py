"""Analytics: your own Instagram numbers, from Instagram's official API (Instagram API with Instagram login).

The key (IG_ACCESS_TOKEN in .env) comes from your Meta app; the Analytics page walks you through getting one. It lasts 60 days; the app refreshes it every week and
writes the new one back to .env, so it never runs out while the app gets opened now and then.
Every reel's numbers are saved in analytics/reels.json once a day, with a dated copy kept for reels under 60 days old,
so the chat (and you) can see how a reel grew. Words saved earlier are in analytics/words/; new reels aren't transcribed.
"""
import hashlib
import json
import os
import re
import signal
import statistics
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from flask import Blueprint, jsonify, abort, send_file, request

import contextdoc
import engine
import cleve
import studio

bp = Blueprint("analytics", __name__)
D = {}  # handed over by app.py: base, duration (path or url -> seconds)
API = "https://graph.instagram.com/v23.0"
SYNC_EVERY = 8 * 3600        # pull fresh numbers three times a day while the app is open
REFRESH_EVERY = 7 * 86400    # renew the 60-day key once a week
FRESH_DAYS = 30              # only posts newer than this get their numbers re-pulled each sync (keeps Instagram calls low)
HISTORY_DAYS = 60            # past this a reel's numbers barely move: keep only the latest
REEL_METRICS = "views,reach,saved,shares,likes,comments,total_interactions,ig_reels_avg_watch_time,reels_skip_rate"
POST_METRICS = "views,reach,saved,shares,likes,comments,total_interactions"
_sync_lock, _meta_lock, _review_lock, _catch_lock = threading.Lock(), threading.Lock(), threading.Lock(), threading.Lock()
STATE = {"syncing": False, "words": "", "reviewing": False}  # what the page shows while work runs
REVIEW_EVERY = 7 * 86400
WORDS_DAYS = 21               # your reels newer than this get their words
POSTS_DAYS = 30               # how far back the Posts tab in the tracker goes


def folder(*p):
    return os.path.join(D["base"], "analytics", *p)


def data_path():
    return folder("reels.json")


def load():
    try:
        return json.load(open(data_path(), encoding="utf-8"))
    except (OSError, ValueError):
        return {"posts": [], "followers": []}


def save(d):
    tmp = data_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, data_path())


def token():
    return os.environ.get("IG_ACCESS_TOKEN", "").strip()


class KeyProblem(Exception):
    pass


def ig(path, **params):
    params["access_token"] = token()
    url = (path if path.startswith("http") else f"{API}/{path}") + ("" if "?" in path else "?" + urllib.parse.urlencode(params))
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            err = json.load(e).get("error", {})
        except ValueError:
            err = {}
        if err.get("code") == 190 or e.code == 401:
            raise KeyProblem("Your Instagram key stopped working. Make a new one in your Meta app "
                             "(Instagram → API setup with Instagram login → Generate token) and paste it on the Analytics page.")
        raise RuntimeError(err.get("message") or f"Instagram said {e.code}")


def now():
    return datetime.now(timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(s):
    return datetime.strptime(s.replace("+0000", "Z").replace("Z", ""), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)


def refresh_key(d):
    """Swap the key for a fresh 60-day one and write it into .env. Quietly skipped if Instagram says no."""
    last = d.get("key_refreshed")
    if last and (now() - parse(last)).total_seconds() < REFRESH_EVERY:
        return
    try:
        new = ig("refresh_access_token", grant_type="ig_refresh_token").get("access_token")
    except Exception:
        return
    if not new:
        return
    engine.env_set("IG_ACCESS_TOKEN", new)
    d["key_refreshed"] = iso(now())


def insights(m):
    reel = m.get("media_product_type") == "REELS"
    try:
        got = ig(f"{m['id']}/insights", metric=REEL_METRICS if reel else POST_METRICS)
    except KeyProblem:
        raise
    except Exception:
        return {}
    v = {x["name"]: x["values"][0]["value"] for x in got.get("data", []) if x.get("values")}
    out = dict(views=v.get("views"), reach=v.get("reach"), likes=v.get("likes"), comments=v.get("comments"),
               saves=v.get("saved"), shares=v.get("shares"), interactions=v.get("total_interactions"))
    if reel:
        out["watch_s"] = round(v["ig_reels_avg_watch_time"] / 1000, 1) if v.get("ig_reels_avg_watch_time") is not None else None
        out["skip_rate"] = v.get("reels_skip_rate")
    return {k: x for k, x in out.items() if x is not None}


def save_thumb(m):
    p = folder("thumbs", m["id"] + ".jpg")
    src = m.get("thumbnail_url") or (m.get("media_url") if m.get("media_type") == "IMAGE" else "")
    if src and not os.path.exists(p):
        try:
            urllib.request.urlretrieve(src, p)
        except Exception:
            pass


def save_avatar(src):
    """Your profile picture, for the profile header on the Analytics page. Instagram's link expires, so keep a copy."""
    if not src:
        return
    p = folder("avatar.jpg")
    try:
        urllib.request.urlretrieve(src, p + ".tmp")
        os.replace(p + ".tmp", p)
    except Exception:
        pass


def sync():
    """Pull the account and every post's numbers. Returns the saved data."""
    if not token():
        raise KeyProblem("No Instagram key yet. Paste one on the Analytics page.")
    with _sync_lock:
        STATE["syncing"] = True
        try:
            d = load()
            refresh_key(d)
            me = ig("me", fields="username,name,followers_count,follows_count,media_count,profile_picture_url")
            save_avatar(me.get("profile_picture_url"))
            media, page = [], ig("me/media", fields="id,caption,media_type,media_product_type,permalink,shortcode,"
                                 "timestamp,thumbnail_url,media_url,like_count,comments_count", limit=100)
            while True:
                media += page.get("data", [])
                nxt = page.get("paging", {}).get("next")
                if not nxt or len(media) > 1000:
                    break
                page = ig(nxt)
            seen = {p["id"]: p for p in d.get("posts", [])}
            def wanted(m):  # older posts keep their saved numbers, unless we never got any
                return (now() - parse(m["timestamp"])).days < FRESH_DAYS or not seen.get(m["id"], {}).get("stats")
            with ThreadPoolExecutor(8) as pool:
                stats = list(pool.map(lambda m: insights(m) if wanted(m) else {}, media))
                list(pool.map(save_thumb, media))
            t, today = now(), now().strftime("%Y-%m-%d")
            old = {p["id"]: p for p in d.get("posts", [])}
            posts = []
            for m, s in zip(media, stats):
                p = old.get(m["id"], {})
                when = parse(m["timestamp"])
                age = (t - when).total_seconds() / 86400
                hist = [h for h in p.get("history", []) if h["at"][:10] != today] if age < HISTORY_DAYS else []
                if age < HISTORY_DAYS and s:
                    hist.append(dict(s, at=iso(t), age_days=round(age, 2)))
                posts.append(dict(
                    id=m["id"], code=m.get("shortcode", ""), link=m.get("permalink", ""), posted=iso(when),
                    kind="reel" if m.get("media_product_type") == "REELS" else "carousel" if m.get("media_type") == "CAROUSEL_ALBUM" else "post",
                    caption=(m.get("caption") or "").strip(), video=m.get("media_type") == "VIDEO",
                    stats=s or p.get("stats", {}), history=hist,
                    words=p.get("words", "")))
            posts.sort(key=lambda p: p["posted"], reverse=True)
            followers = [f for f in d.get("followers", []) if f["date"] != today] + [{"date": today, "n": me.get("followers_count", 0)}]
            d.update(account={k: me.get(k) for k in ("username", "name", "followers_count", "follows_count", "media_count")},
                     posts=posts, followers=followers[-400:], updated=iso(t), error="")
            save(d)
            return d
        except KeyProblem as e:
            d = load()
            d["error"] = str(e)
            save(d)
            raise
        finally:
            STATE["syncing"] = False


def words_path(pid):
    return folder("words", pid + ".txt")


def words_of(pid):
    try:
        return open(words_path(pid), encoding="utf-8").read().strip()
    except OSError:
        return ""


# --- What the app works out about each reel, kept apart from Instagram's numbers: analytics/meta.json ---
# {post id: {"length_s": seconds, "tags": {"topic" (the content pillar), "subtopic", "format", "hook", "cta"},
#            "aim": {"fit", "funnel", "awareness", "audience", "why", "v"}}}  aim: who the reel is for, see Content direction below

def meta_path():
    return folder("meta.json")


def load_meta():
    try:
        return json.load(open(meta_path(), encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def set_meta(pid, **kw):
    with _meta_lock:
        m = load_meta()
        m.setdefault(pid, {}).update(kw)
        tmp = meta_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(m, f, ensure_ascii=False, indent=1)
        os.replace(tmp, meta_path())


def fill_lengths():
    """How long each reel is, read straight from the video link (no download), so watch time becomes % watched."""
    meta = load_meta()
    for p in load().get("posts", []):
        if p["video"] and not meta.get(p["id"], {}).get("length_s"):
            try:
                url = ig(p["id"], fields="media_url").get("media_url")
                n = D["duration"](url) if url else 0
                if n:
                    set_meta(p["id"], length_s=round(n, 1))
            except KeyProblem:
                raise
            except Exception:
                pass


HOOK_TYPES = ["Question", "Bold claim", "Contrarian take", "Relatable problem", "Story", "How-to promise", "List",
              "Result or proof", "Curiosity gap", "Comparison"]
# Your content pillars (edited on the Context page, kept in pillars.json): the topic every reel is grouped under.
# The finer subject goes in subtopic. When they change, every reel is labelled again.


def settled(name, secs=120):
    """True once a file you edit on the Context page (saved as you type) has been left alone for a couple of minutes,
    so reels are never relabelled against a half-typed pillar or audience."""
    try:
        return time.time() - os.path.getmtime(os.path.join(D["base"], name)) > secs
    except OSError:
        return True


def pillars():
    return [p for p in contextdoc.load_pillars(D["base"]) if p["name"]]


def pillars_text(ps):
    return "\n".join(f"- {p['name']}" + (f": {p['about']}" if p["about"] else "") for p in ps)


def pillars_v(ps):
    return hashlib.sha1(json.dumps(sorted([p["name"], p["about"]] for p in ps)).encode("utf-8")).hexdigest()[:8]  # order doesn't matter


# Reels labelled before pillars were editable count as labelled with the default ones
DEFAULT_PV = pillars_v([dict(name=n, about="") for n in contextdoc.DEFAULT_PILLARS])
TAG_PROMPT = """You label a creator's own Instagram reels so their numbers can be compared fairly. For each reel you get its id, caption and spoken words. Give:
- topic: the content pillar the reel belongs to, one of the names in <topics>, word for word, so reels on the same subject group together. "Other" only when it truly fits none of them.
- subtopic: what the reel is about more exactly, in 2 to 4 plain words, like "AI file storage" or "Startup ideas". Reuse one from <subtopics> when it fits, word for word.
- format: the name of the format card it follows, from <formats>, word for word, or "Other" if none fits.
- hook: the kind of opening line, one of: HOOKS.
- cta: the call to action in a few words, like "Comment SORT" or "Follow for more", or "None".
Plain words, no em dashes."""


def fill_tags():
    """Label reels with no labels yet, or labelled before the pillars last changed: 25 at a time, one AI call each."""
    if not engine.ready():
        return
    posts = [p for p in load().get("posts", []) if p["video"]]
    ps = pillars()
    if not ps or not settled("pillars.json"):
        return
    pv = pillars_v(ps)
    while True:
        meta = load_meta()
        todo = [p for p in posts if (meta.get(p["id"], {}).get("tags") or {}).get("pv", DEFAULT_PV) != pv
                or not meta.get(p["id"], {}).get("tags")][:25]
        if not todo:
            return
        used = [m["tags"] for m in meta.values() if m.get("tags")]
        subtopics = sorted({t.get("subtopic") or t["topic"] for t in used})
        formats = [f["name"] for f in studio.FORMATS["formats"]]
        reels = "\n\n".join(f"<reel id=\"{p['id']}\">\nCaption: {p['caption'][:600]}\nWords: {words_of(p['id'])[:2500] or '(not transcribed)'}\n</reel>" for p in todo)
        schema = studio.obj(reels=studio.many(studio.obj(id=studio.TEXT, topic=studio.TEXT, subtopic=studio.TEXT, format=studio.TEXT, hook=studio.TEXT, cta=studio.TEXT)))
        STATE["words"] = f"Labelling your reels: {len(todo)} at a time"
        try:
            found = json.loads(studio.ask_claude(TAG_PROMPT.replace("HOOKS", ", ".join(HOOK_TYPES)), [{"role": "user", "content":
                f"<topics>\n{pillars_text(ps)}\n</topics>\n<subtopics>{', '.join(subtopics) or '(none yet)'}</subtopics>\n<formats>{', '.join(formats)}</formats>\n\n{reels}"}],
                schema=schema, effort="low"))
        finally:
            STATE["words"] = ""
        ids = {p["id"] for p in todo}
        got = [r for r in found["reels"] if r["id"] in ids]
        if not got:
            return  # don't loop forever on a batch Claude can't label
        for r in got:
            set_meta(r["id"], tags=dict({k: r[k].strip() for k in ("topic", "subtopic", "format", "hook", "cta")}, pv=pv))


# --- Content direction: whether each reel speaks to the audience in context.md (on point, at any funnel stage), plus its funnel stage and awareness level.
# So you can see at a glance whether daily posting is drifting away from your ideal viewer. Labels live in meta.json
# under "aim"; they're redone when the audience part of context.md changes.

FUNNEL = ["Top", "Middle", "Bottom"]
AWARENESS = ["Unaware", "Problem aware", "Solution aware", "Product aware", "Most aware"]
FIT = ["On point", "Off", "Unclear"]
DIRECTION_DAYS = 14          # Content direction always looks at the last 14 days, whatever range the page shows
AIM_PROMPT = """You check whether a creator's Instagram reels speak to the audience they want. Their ideal viewer is described in <audience>, and what they offer (a product, service, course, or just their content) in <offer>. For each reel you get its id, caption and spoken words. Give:
- fit: does the reel speak to their ideal viewer? Judge only who it's for and whether it would resonate with them: their goals, fears, wants and level. The funnel stage and awareness level don't matter: a broad top-of-funnel reel is on point if it's the kind of thing their ideal viewer feels seen by. One of:
  On point: their ideal viewer would feel it's made for them.
  Off: it's mainly made for, or would mainly resonate with, someone else, like insiders, other creators, or a general crowd chasing a trend.
  Unclear: only when there are no words and the caption alone doesn't show who it's for. Don't guess.
- funnel: where the reel sits for someone who might one day buy or use what they offer, one of:
  Top: wide appeal, about life, work or the topic in general. A stranger gets value with no interest in what they offer.
  Middle: teaches a method or setup the viewer could copy, building trust in the creator's way of doing things. What they offer may appear, but isn't the point.
  Bottom: what they offer is the point: the reel shows it, demos it, compares it, or leads straight to trying or buying it.
- awareness: which viewer the reel is written for, on the 5 levels of awareness, one of:
  Unaware: doesn't feel a problem yet. The reel speaks to their life, ambition or identity.
  Problem aware: feels the pain but not the fix.
  Solution aware: knows fixes exist and wants the best one or how to do it.
  Product aware: knows what the creator offers, or something like it, and is weighing it up.
  Most aware: ready to try or buy and just needs the offer or the push.
- audience: who the reel is really made for, in 2 to 5 plain words, like "busy first-time founders" or "anyone online".
- why: one short plain sentence on the fit, naming the angle or line that decides it.
Judge the reel as it was made, not what the creator meant. If <offer> is empty, judge the funnel by how much the reel sells the creator themselves. Plain words, no em dashes."""
def audience():
    """The ideal viewer: the "Who the reels are for" part of context.md (nothing if that part is empty or missing)."""
    try:
        text = open(os.path.join(D["base"], "context.md"), encoding="utf-8").read()
    except OSError:
        return ""
    m = re.search(r"^#[^\n]*who the reels are for[^\n]*\n(.*?)(?=^# |\Z)", text, re.M | re.S | re.I)
    return (m.group(1) if m else "").strip()


def audience_v(text):
    """Changes when the audience or the labelling rules change, so every reel gets checked again."""
    return hashlib.sha1((AIM_PROMPT + text).encode("utf-8")).hexdigest()[:8]


def fill_aim():
    """Label who each reel is for and its funnel stage: 25 at a time, one AI call each."""
    if not engine.ready():
        return
    aud = audience()
    if not aud or not settled("context.md"):
        return
    v = audience_v(aud)
    posts = [p for p in load().get("posts", []) if p["video"]]
    while True:
        meta = load_meta()
        todo = [p for p in posts if (meta.get(p["id"], {}).get("aim") or {}).get("v") != v][:25]
        if not todo:
            return
        reels = "\n\n".join(f"<reel id=\"{p['id']}\">\nCaption: {p['caption'][:600]}\nWords: {words_of(p['id'])[:2500] or '(not transcribed)'}\n</reel>" for p in todo)
        schema = studio.obj(reels=studio.many(studio.obj(id=studio.TEXT, fit=studio.TEXT, funnel=studio.TEXT, awareness=studio.TEXT, audience=studio.TEXT, why=studio.TEXT)))
        STATE["words"] = f"Checking who your reels are for: {len(todo)} at a time"
        try:
            found = json.loads(studio.ask_claude(AIM_PROMPT, [{"role": "user", "content": f"<audience>\n{aud}\n</audience>\n\n<offer>\n{context_part('offer') or '(not filled in)'}\n</offer>\n\n{reels}"}],
                                                 schema=schema, effort="low"))
        finally:
            STATE["words"] = ""
        ids = {p["id"] for p in todo}
        got = [r for r in found["reels"] if r["id"] in ids]
        if not got:
            return  # don't loop forever on a batch Claude can't label
        for r in got:
            funnel = next((f for f in FUNNEL if r["funnel"].strip().lower().startswith(f.lower())), "Middle")
            fit = next((f for f in FIT if r["fit"].strip().lower().startswith(f.lower()[:4])), "Unclear")
            aware = next((x for x in AWARENESS if r["awareness"].strip().lower().startswith(x.lower()[:4])), "Problem aware")
            set_meta(r["id"], aim=dict(fit=fit, funnel=funnel, awareness=aware, audience=r["audience"].strip(), why=r["why"].strip(), v=v))


def mix_targets():
    """The content mix you aim for, from the "Content mix" part of context.md: {"funnel": {"Top": 60, ...}, "awareness": {...}}.
    A stage left out is None."""
    try:
        text = open(os.path.join(D["base"], "context.md"), encoding="utf-8").read()
    except OSError:
        return None
    m = re.search(r"^#[^\n]*content mix[^\n]*\n(.*?)(?=^# |\Z)", text, re.M | re.S | re.I)
    if not m:
        return None
    def pct(name):
        x = re.search(r"^\s*[-*]?\s*" + re.escape(name) + r"\b[^:\n]*:\s*(\d{1,3})\s*%", m.group(1), re.M | re.I)
        return int(x.group(1)) if x else None
    return {"funnel": {f: pct(f) for f in FUNNEL}, "awareness": {a: pct(a) for a in AWARENESS}}


# --- Ideas for one stage, on demand: pick a funnel stage or awareness level under the chart and ask for reels there ---

STAGES = {
    "funnel": {
        "Top": "Top of funnel: wide appeal, about life, work or the topic in general. A stranger gets value with no interest in what the creator offers.",
        "Middle": "Middle of funnel: teaches a method or setup the viewer could copy, building trust in the creator's way of doing things. What they offer may appear, but isn't the point.",
        "Bottom": "Bottom of funnel: what the creator offers is the point. The reel shows it, demos it, compares it, or leads straight to trying or buying it.",
    },
    "awareness": {
        "Unaware": "Unaware: the viewer doesn't feel a problem yet. The reel speaks to their life, ambition or identity.",
        "Problem aware": "Problem aware: the viewer feels the pain but not the fix.",
        "Solution aware": "Solution aware: the viewer knows fixes exist and wants the best one or how to do it.",
        "Product aware": "Product aware: the viewer knows what the creator offers, or something like it, and is weighing it up.",
        "Most aware": "Most aware: the viewer is ready to try or buy and just needs the offer or the push.",
    },
}
STAGE_PROMPT = """You come up with reel ideas for a creator. You get what they offer (<offer>), their ideal viewer (<audience>), how they sound (<voice>), their content pillars (<pillars>), the one stage they want more reels for (<stage>), reels they already posted at that stage (<posted>), and ideas they already have (<skip>).
Give ideas: 5 reel ideas that sit squarely at that stage and speak to their ideal viewer's goals, fears or wants. Don't repeat anything in <posted> or <skip>. Spread them across their pillars. For each:
- hook: the first line they'd say, in their voice, under 15 words. Lead with the point or with what they did or found, like talking to one friend. No guru lines, no numbered signposts.
- angle: one plain sentence on what the reel says and the one useful thing the viewer walks away with.
- pillar: a name from <pillars>, word for word, or "Other" if there are none.
- funnel: Top, Middle or Bottom.
- awareness: Unaware, Problem aware, Solution aware, Product aware or Most aware.
Only say true things about what they offer (from <offer>). Plain words, no em dashes, no jargon."""


def context_part(name):
    """One "# ..." part of context.md whose heading contains name, or ""."""
    try:
        text = open(os.path.join(D["base"], "context.md"), encoding="utf-8").read()
    except OSError:
        return ""
    m = re.search(r"^#[^\n]*" + re.escape(name) + r"[^\n]*\n(.*?)(?=^# |\Z)", text, re.M | re.S | re.I)
    return m.group(1).strip() if m else ""


def stage_ideas(view, stage, skip=()):
    """5 fresh reel ideas for one funnel stage or awareness level, not repeating what was posted there or is already on the list."""
    if stage not in STAGES.get(view, {}):
        raise ValueError("Pick a stage first.")
    aud, ps = audience(), pillars()
    if not aud:
        raise ValueError("Fill in \"Who the reels are for\" on the Context page first (About you tab).")
    done = [p for p in summary(load())["posts"] if p["kind"] == "reel" and (p.get("aim") or {}).get(view) == stage][:20]
    posted = "\n".join("- " + re.split(r"(?<=[.!?])\s+|\n", (p["words"] or p["caption"] or "").strip())[0][:160] for p in done) or "(none yet)"
    skipped = "\n".join("- " + str(x)[:160] for x in list(skip)[:30]) or "(none)"
    schema = studio.obj(ideas=studio.many(studio.obj(hook=studio.TEXT, angle=studio.TEXT, pillar=studio.TEXT, funnel=studio.TEXT, awareness=studio.TEXT)))
    out = json.loads(studio.ask_claude(STAGE_PROMPT, [{"role": "user", "content":
        f"<offer>\n{context_part('offer') or '(not filled in)'}\n</offer>\n\n<audience>\n{aud}\n</audience>\n\n<voice>\n{context_part('voice')}\n</voice>\n\n"
        f"<pillars>\n{pillars_text(ps)}\n</pillars>\n\n<stage>\n{STAGES[view][stage]}\n</stage>\n\n<posted>\n{posted}\n</posted>\n\n<skip>\n{skipped}\n</skip>"}],
        schema=schema, effort="medium"))
    ideas = out["ideas"]
    for x in ideas:  # the stage asked for wins, whatever the AI put
        x[view] = stage
    return dict(ideas=ideas, at=iso(now()))


# --- The weekly review: the AI (engine.agent) reads everything; it's kept in analytics/reviews, and in Cleve if connected ---

REVIEW_PROMPT = """You write a creator's weekly content review. They make Instagram reels; context.md says who they are, their audience and their voice (it may be mostly empty). Write like a sharp content strategist talking to them: short sentences, plain words, no em dashes, no jargon.

Read, don't guess:
- analytics/reels.json: their posts, newest first, with stats (views, reach, likes, comments, saves, shares, watch_s: average seconds watched, skip_rate: percent who swiped away in the first seconds), "history" (dated copies of the stats), and "followers" by day.
- analytics/meta.json: per post id, length_s (the reel's length), tags (topic: their content pillar, subtopic, format, hook type, cta) and aim (fit: On point if it speaks to their ideal viewer in context.md, whatever the funnel stage, else Off, or Unclear with no words; funnel: Top, Middle or Bottom; awareness: one of the 5 levels of awareness; audience: who it's really for).
- analytics/words/<post id>.txt: what they say in a reel (only some reels have one).
- analytics/reviews/: earlier reviews, newest last. Read the latest one if there is one.
- formats.json: the format cards.

How to judge: their typical reel is the middle (median) views of their last 20 reels that are at least 3 days old. Judge each reel against that, never raw views. Reels under 3 days old are still growing: mention them, don't judge them. % watched = watch_s / length_s. Saves and shares per 1,000 views, % watched and swipe-away rate say more than likes. Several reels with the same words are trial versions: compare them to see what the caption or visuals changed. Only call something a pattern when it shows in 3 or more reels; otherwise call it a hunch. Back every claim with numbers and point to reels by their first words and date.

Write the review in this order, as markdown with ## headings:
## The week in one line
## Numbers (this week against their typical reel: reels posted, median views, % watched, swipe-away, saves and shares per 1,000, follower change)
## What worked (the top reels and why)
## What didn't (the bottom reels and why)
## Last week's tests (only if there is an earlier review: each test it set, and whether the numbers say it worked, didn't, or it's too early)
## Tests for next week (2 or 3, each one change to try, how many reels, and the number that will say if it worked)
## Next 3 reels (topic, hook, format card from formats.json, and why, from the numbers)

Reply with the review only. Don't change any files."""


def reviews():
    os.makedirs(folder("reviews"), exist_ok=True)
    return sorted(f for f in os.listdir(folder("reviews")) if f.endswith(".md"))


def write_review():
    """The AI reads the numbers and writes this week's review. Saved in analytics/reviews, and in Cleve if it's connected."""
    if not _review_lock.acquire(blocking=False):
        raise ValueError("A review is already being written.")
    STATE["reviewing"] = True
    try:
        day = now().strftime("%Y-%m-%d")
        res = engine.agent(REVIEW_PROMPT, "Write this week's review.", edit=False)
        if res.get("error") or not res["answer"]:
            raise RuntimeError(res.get("error") or "The review came back empty.")
        text, link = res["answer"].strip(), ""
        if cleve.connected():
            try:
                link = cleve.save("Reel review, week of " + f"{now().day} {now():%b %Y}", text)["link"]
            except Exception:
                pass  # it's still saved here
        with open(folder("reviews", day + ".md"), "w", encoding="utf-8") as f:
            f.write(f"<!-- {link} -->\n{text}\n")
        return day
    finally:
        STATE["reviewing"] = False
        _review_lock.release()


def read_review(name):
    raw = open(folder("reviews", name), encoding="utf-8").read()
    m = re.match(r"<!-- (\S*) -->\n", raw)
    return dict(date=name[:-3], link=m.group(1) if m else "", text=raw[m.end():].strip() if m else raw.strip())


def review_due():
    r = reviews()
    return not r or (now() - datetime.strptime(r[-1][:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)).total_seconds() >= REVIEW_EVERY


def fill_words():
    """Words of your reels from the last few weeks, so the labels and the review know what each one says."""
    d = load()
    todo = [p for p in d.get("posts", []) if p["video"] and p.get("link") and not os.path.exists(words_path(p["id"]))
            and (now() - parse(p["posted"])).days < WORDS_DAYS]
    for i, p in enumerate(todo, 1):
        STATE["words"] = f"Getting the words of your newest reels ({i} of {len(todo)})"
        try:
            text = D["transcribe"](p["link"]).strip() or "(no speech)"
        except Exception:
            text = "(couldn't transcribe)"  # words_of() callers treat "(" as no words; it isn't retried
        with open(words_path(p["id"]), "w", encoding="utf-8") as f:
            f.write(text)
    STATE["words"] = ""


def catch_up():
    """Everything the numbers need after a sync: lengths, words and labels."""
    if not _catch_lock.acquire(blocking=False):
        return  # already catching up
    try:
        fill_lengths()
        fill_words()
        fill_tags()
        _quiet(fill_aim)  # Content direction
    finally:
        _catch_lock.release()


def background():
    """Keeps the numbers fresh while the app runs: syncs when they're over 12 hours old, then catches up."""
    time.sleep(5)
    while True:
        try:
            if token():
                last = load().get("updated")
                if not last or (now() - parse(last)).total_seconds() > SYNC_EVERY:
                    sync()
                catch_up()
        except KeyProblem:
            pass  # sync() already saved the reason for the page to show
        except Exception as e:
            try:
                d = load()
                d["error"] = f"Last automatic update failed. {str(e)[:150]}"
                save(d)
            except Exception:
                pass
        time.sleep(600)


def summary(d):
    """What the page needs: each post with how it did against your typical reel."""
    posts = d.get("posts", [])
    t, meta = now(), load_meta()
    reels = [p for p in posts if p["kind"] == "reel" and p["stats"].get("views") and (t - parse(p["posted"])).days >= 3]
    recent = reels[:20]  # your typical reel = the middle of your last 20 that are at least 3 days old
    typical = statistics.median([p["stats"]["views"] for p in recent]) if recent else 0
    out = []
    for p in posts:
        s, age = p["stats"], (t - parse(p["posted"])).total_seconds() / 86400
        v = s.get("views") or 0
        w, m = words_of(p["id"]), meta.get(p["id"], {})
        ln = m.get("length_s")
        out.append(dict({k: p[k] for k in ("id", "code", "link", "posted", "kind", "caption")}, stats=s, age_days=round(age, 1),
                        length_s=ln, pct=min(100, round(100 * s["watch_s"] / ln)) if ln and s.get("watch_s") is not None else None,
                        tags=m.get("tags"), aim={k: v for k, v in m["aim"].items() if k != "v"} if m.get("aim") else None,
                        growing=age < 3, vs=round(v / typical, 2) if typical and v else None,
                        keep=round(1000 * ((s.get("saves") or 0) + (s.get("shares") or 0)) / v, 1) if v else None,
                        words=w if not w.startswith("(") else "", thumb=f"/analytics/thumb/{p['id']}"
                        if os.path.exists(folder("thumbs", p["id"] + ".jpg")) else ""))
    med = lambda k: round(statistics.median(x), 1) if (x := [p["stats"][k] for p in recent if p["stats"].get(k) is not None]) else None
    judged = [x for x in out if x["kind"] == "reel" and not x["growing"] and x["vs"] is not None]
    pcts = [x["pct"] for x in judged[:20] if x["pct"] is not None]
    r = reviews()
    av = folder("avatar.jpg")
    account = dict(d.get("account") or {}, avatar=f"/analytics/avatar?v={int(os.path.getmtime(av))}" if os.path.exists(av) else "")
    return dict(connected=bool(token()), account=account, updated=d.get("updated"), error=d.get("error", ""),
                followers=d.get("followers", []), posts=out, syncing=STATE["syncing"], words=STATE["words"],
                patterns={k: patterns(judged, k) for k in ("topic", "format", "hook")},
                review=dict(read_review(r[-1]), count=len(r)) if r else None, reviewing=STATE["reviewing"],
                mix=mix_targets(), direction_days=DIRECTION_DAYS, pillars=[p["name"] for p in pillars()],
                typical=dict(views=typical, watch_s=med("watch_s"), skip_rate=med("skip_rate"), sample=len(recent),
                             pct=round(statistics.median(pcts)) if pcts else None,
                             keep=round(statistics.median([x["keep"] for x in out if x["kind"] == "reel" and x["keep"] is not None
                                                           and x["age_days"] >= 3][:20]), 1) if recent else None))


def patterns(reels, key):
    """Judged reels grouped by one label, best first: how many, and the middle of their numbers."""
    groups = {}
    for x in reels:
        if x.get("tags") and x["tags"].get(key):
            groups.setdefault(x["tags"][key], []).append(x)
    mid = lambda xs: round(statistics.median(xs), 1) if xs else None
    rows = [dict(name=k, n=len(xs), vs=mid([x["vs"] for x in xs]), skip=mid([x["stats"]["skip_rate"] for x in xs if x["stats"].get("skip_rate") is not None]),
                 pct=mid([x["pct"] for x in xs if x["pct"] is not None]), keep=mid([x["keep"] for x in xs if x["keep"] is not None]))
            for k, xs in groups.items()]
    return sorted(rows, key=lambda r: (-(r["vs"] or 0)))


@bp.get("/analytics")
def analytics_get():
    return jsonify(summary(load()))


@bp.post("/analytics/refresh")
def analytics_refresh():
    try:
        d = sync()
    except KeyProblem as e:
        return jsonify(error=str(e)), 400
    except Exception as e:
        return jsonify(error=f"Couldn't reach Instagram. {str(e)[:200]}"), 502
    threading.Thread(target=lambda: _quiet(catch_up), daemon=True).start()  # new reels get their length and labels in the background
    return jsonify(summary(d))


def _quiet(fn):
    try:
        fn()
    except Exception:
        pass


@bp.post("/analytics/key")
def analytics_key():
    """Paste your Instagram key on the page: checked with Instagram, kept in .env, then your numbers are pulled."""
    k = str((request.get_json(silent=True) or {}).get("key") or "").strip()
    if not k:
        return jsonify(error="Paste the key first."), 400
    try:
        with urllib.request.urlopen(f"{API}/me?" + urllib.parse.urlencode(dict(fields="username", access_token=k)), timeout=30) as r:
            json.load(r)
    except urllib.error.HTTPError:
        return jsonify(error="Instagram didn't accept that key. Generate a new one and paste the whole thing."), 400
    except Exception as e:
        return jsonify(error=f"Couldn't reach Instagram. {str(e)[:200]}"), 502
    engine.env_set("IG_ACCESS_TOKEN", k)
    return analytics_refresh()


@bp.post("/analytics/direction/ideas")
def analytics_stage_ideas():
    """Reel ideas for one funnel stage or awareness level, on demand (Content direction, under the chart)."""
    b = request.get_json(silent=True) or {}
    try:
        return jsonify(stage_ideas(b.get("view", ""), b.get("stage", ""), b.get("skip") or []))
    except ValueError as e:
        return jsonify(error=str(e)), 400
    except Exception as e:
        return jsonify(error=f"Couldn't come up with ideas. {str(e)[:300]}"), 500


@bp.post("/analytics/review")
def analytics_review():
    """Write this week's review now, instead of waiting for the weekly one."""
    try:
        write_review()
    except ValueError as e:
        return jsonify(error=str(e)), 400
    except Exception as e:
        return jsonify(error=f"Couldn't write the review. {str(e)[:300]}"), 500
    return jsonify(summary(load()))


@bp.get("/analytics/thumb/<pid>")
def analytics_thumb(pid):
    p = folder("thumbs", re.sub(r"\D", "", pid) + ".jpg")
    if not os.path.exists(p):
        abort(404)
    return send_file(p, mimetype="image/jpeg")


@bp.get("/analytics/avatar")
def analytics_avatar():
    p = folder("avatar.jpg")
    if not os.path.exists(p):
        abort(404)
    return send_file(p, mimetype="image/jpeg")


def register(app, **deps):
    D.update(deps)
    for f in ("thumbs", "words", "reviews"):
        os.makedirs(folder(f), exist_ok=True)
    app.register_blueprint(bp)
    # With the reloader, only the process that serves the page runs the background job
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        threading.Thread(target=background, daemon=True).start()
