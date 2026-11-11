"""
digi-server/server.py — backend for AI Digivice

Routes (match App.tsx):
  POST   /chat           body {message, pet, ctx, history}  -> {"reply": str, "emotion": str}
  POST   /thought        body {pet, ctx}                    -> {"text": str, "emotion": str}
  GET    /memory                                            -> list of stored facts (debug)
  POST   /memory         body {text, kind?}                 -> add a fact by hand (debug)
  DELETE /memory                                            -> wipe memory (debug)
  DELETE /memory/{idx}                                      -> delete one fact (debug)
  GET    /health                                            -> {"ok": true, ...}

Run:
  pip install fastapi uvicorn python-dotenv openai
  uvicorn server:app --host 0.0.0.0 --port 8000 --reload
  (8000 is what App.tsx's DEFAULT_SERVER expects)

.env:
  OPENAI_API_KEY=...            (required for /chat and /thought; /health works without it)
  LLM_MODEL=gpt-4o-mini         (optional)
  LLM_TIMEOUT=20                (optional, seconds)
  LLM_RETRIES=1                 (optional, retries on timeout / rate-limit)
  MEMORY_FILE=digi_memory.json  (optional, path)
  MEMORY_CAP=200                (optional, max stored facts)
  CORS_ORIGINS=*                (optional, comma-separated)

What changed in this version (liveliness pass)
  - The prompt now uses everything the app sends: sleeping state (sleep-talk), level
    (personality grows from hatchling to confident dragon), XP progress, how long the
    owner has been away (greets / misses them), and the time of day.
  - Hunger / loneliness thresholds nudge the owner naturally instead of being ignored.
  - /thought picks a random "seed" (a memory callback, a wish, a tiny story, a question,
    the time of day...) so spontaneous thoughts stop repeating, and when the LLM is down
    it returns a local offline thought instead of an empty string, so Auto-thought keeps
    Digi talking.
  - /chat and /thought return an "emotion" emoji (derived from mood + reply text) that
    App.tsx shows as Digi's face for a moment.
  - Offline fallbacks are mood-aware AND message-aware (hello, food, love, questions...).
  - Memory retrieval now also boosts facts mentioned in recent history, so callbacks
    to earlier parts of the conversation feel intentional.
  - Docstring port fixed (8000, matching the app).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import socket
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Literal


from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    RateLimitError,
)
from pydantic import BaseModel, ConfigDict, Field, field_validator

load_dotenv(override=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("digi")

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────
MEMORY_FILE = Path(os.getenv("MEMORY_FILE") or Path(__file__).parent / "digi_memory.json")
MEMORY_CAP = int(os.getenv("MEMORY_CAP", "200"))
MODEL = os.getenv("OPENAI_MODEL", "gpt-6.1-terra")
TIMEOUT = float(os.getenv("LLM_TIMEOUT", "20"))
LLM_RETRIES = int(os.getenv("LLM_RETRIES", "1"))
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]

MAX_HISTORY_TURNS = 10
MAX_HISTORY_CHARS = 600  # per message, keeps the prompt bounded
VALID_KINDS = ("fact", "place", "person", "routine", "like", "event")

app = FastAPI(title="digi-server", version="2.2")
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])


def lan_ip() -> str:
    """The address the phone must use (NOT localhost / 127.0.0.1 — that is the phone itself)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # no packet is sent; just picks the outbound interface
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


@app.on_event("startup")
async def _startup_banner() -> None:
    ip = lan_ip()
    key_ok = bool(os.getenv("OPENAI_API_KEY"))
    log.info("=" * 70)
    log.info("digi-server up.  In App.tsx set DEFAULT_SERVER = 'http://%s:8000'", ip)
    log.info("Phone and this computer must be on the SAME Wi-Fi.")
    log.info("Test from the phone's browser:  http://%s:8000/health", ip)
    log.info("Test the LLM link:              http://%s:8000/health/llm", ip)
    if key_ok:
        log.info("OPENAI_API_KEY: set  (model=%s)", MODEL)
    else:
        log.error("OPENAI_API_KEY is NOT set — Digi will only give offline fallback lines. Add it to .env")
    log.info("=" * 70)

# ─────────────────────────────────────────────────────────────────────────────
# LLM call — the ONLY provider-specific code. Swap the body if you use another API.
# ─────────────────────────────────────────────────────────────────────────────
_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    """Lazy init so the server starts (and /health works) even if the key is missing."""
    global _client
    if _client is None:
        key = os.getenv("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("OPENAI_API_KEY is not set — add it to .env")
        _client = AsyncOpenAI(api_key=key, timeout=TIMEOUT)
    return _client



async def call_llm(
    messages: list[dict[str, str]],
    max_tokens: int = 1000,
    temperature: float = 0.9
) -> str:
    """Call Digi's AI model using Chat Completions."""
    client = _get_client()
    last_exc: Exception | None = None

    for attempt in range(LLM_RETRIES + 1):
        try:
            r = await client.chat.completions.create(
                model=MODEL,
                messages=messages,
                max_completion_tokens=max_tokens
            )

            log.info("Digi AI response model: %s", r.model)

            return (r.choices[0].message.content or "").strip()

        except (APITimeoutError, RateLimitError, APIConnectionError) as e:
            last_exc = e

            if attempt < LLM_RETRIES:
                log.warning(
                    "LLM call failed (%s), retrying...",
                    type(e).__name__
                )
                await asyncio.sleep(0.5 * (attempt + 1))

    assert last_exc is not None
    raise last_exc


def explain_llm_error(e: Exception) -> str:
    """Human-readable reason for the logs, /health/llm, and the 'detail' field in fallbacks."""
    if isinstance(e, RuntimeError) and "OPENAI_API_KEY" in str(e):
        return "OPENAI_API_KEY missing — add it to .env and restart the server"
    if isinstance(e, AuthenticationError):
        return "OpenAI rejected the API key (401) — check OPENAI_API_KEY in .env"
    if isinstance(e, RateLimitError):
        return "OpenAI rate limit / no credit (429) — check billing at platform.openai.com"
    if isinstance(e, APITimeoutError):
        return f"OpenAI did not answer within {TIMEOUT:.0f}s — slow network? raise LLM_TIMEOUT"
    if isinstance(e, APIConnectionError):
        return "server could not reach api.openai.com — is this computer online? proxy/VPN/firewall?"
    if isinstance(e, APIStatusError):
        return f"OpenAI returned HTTP {e.status_code}: {getattr(e, 'message', '') or e}"[:200]
    return f"{type(e).__name__}: {e}"[:200]


_PREFIX = re.compile(r"^\s*(?:digi|pet|assistant)\s*:\s*", re.I)


def clean_reply(text: str) -> str:
    """Strip markdown, list markers, a stray 'Digi:' prefix, and wrapping quotes."""
    text = re.sub(r"\*\*|__|`|#+\s*", "", text)
    text = re.sub(r"^[-*•]\s+", "", text, flags=re.M)
    text = re.sub(r"\s+", " ", text).strip().strip("\"'“”‘’").strip()
    text = _PREFIX.sub("", text)  # after unquoting, so '"Digi: hi"' -> 'hi'
    return text.strip().strip("\"'“”‘’").strip()


def first_sentence(text: str, max_words: int = 18) -> str:
    """Thoughts should be one short line; keep the first sentence and cap the word count."""
    m = re.match(r"(.+?[.!?…])(\s|$)", text)
    s = m.group(1) if m else text
    words = s.split()
    return " ".join(words[:max_words]) if len(words) > max_words else s


# ─────────────────────────────────────────────────────────────────────────────
# Text helpers for retrieval / dedup
# ─────────────────────────────────────────────────────────────────────────────
_STOP = {
    "the", "and", "for", "with", "that", "this", "they", "them", "their", "from", "have", "has",
    "had", "was", "were", "are", "you", "your", "about", "into", "when", "what", "where", "who",
    "user", "owner", "likes", "like", "goes", "went", "does", "did", "will", "just", "really",
    "there", "here", "then", "than", "some", "very", "also", "been", "being", "take", "takes",
}
_WORD = re.compile(r"[a-zA-Z]{3,}")


def _stem(w: str) -> str:
    for suf in ("ing", "ies", "es", "ed", "s"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def tokens(text: str) -> set[str]:
    return {_stem(w.lower()) for w in _WORD.findall(text) if w.lower() not in _STOP}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


# ─────────────────────────────────────────────────────────────────────────────
# Memory (digi_memory.json) — list of {"text","kind","created_at","last_used","uses"}
# ─────────────────────────────────────────────────────────────────────────────
def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _normalize(m: Any) -> dict[str, Any] | None:
    """Tolerate older formats (plain strings) and skip junk."""
    if isinstance(m, str):
        m = {"text": m}
    if not isinstance(m, dict) or not str(m.get("text", "")).strip():
        return None
    kind = m.get("kind", "fact")
    return {
        "text": str(m["text"]).strip(),
        "kind": kind if kind in VALID_KINDS else "fact",
        "created_at": m.get("created_at") or "",
        "last_used": m.get("last_used") or "",
        "uses": int(m.get("uses", 0) or 0),
    }


class MemoryStore:
    """Cached, lock-guarded, atomically-persisted list of facts."""

    def __init__(self, path: Path, cap: int):
        self.path = path
        self.cap = cap
        self._lock = asyncio.Lock()
        self._items: list[dict[str, Any]] | None = None

    # -- disk -----------------------------------------------------------------
    def _load(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            log.warning("memory file unreadable (%s) — starting empty", e)
            return []
        if not isinstance(data, list):
            return []
        return [n for n in (_normalize(m) for m in data) if n]

    def _save(self, mem: list[dict[str, Any]]) -> None:
        """Write to a temp file, then replace, so a crash never leaves a half-written JSON."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(mem, indent=2, ensure_ascii=False)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".digi_memory.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(payload)
            os.replace(tmp, self.path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    # -- api ------------------------------------------------------------------
    def all(self) -> list[dict[str, Any]]:
        if self._items is None:
            self._items = self._load()
        return [dict(m) for m in self._items]

    async def mutate(self, fn: Callable[[list[dict[str, Any]]], Any]) -> None:
        """Run fn(items) under the lock, prune, persist."""
        async with self._lock:
            items = self.all()
            fn(items)
            items = self._prune(items)
            await asyncio.to_thread(self._save, items)
            self._items = items

    def _prune(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Over the cap: drop the least useful facts (low uses, then oldest), keep chronological order."""
        if len(items) <= self.cap:
            return items
        ranked = sorted(items, key=lambda m: (m["uses"], m["last_used"], m["created_at"]), reverse=True)
        keep = {id(m) for m in ranked[: self.cap]}
        return [m for m in items if id(m) in keep]


store = MemoryStore(MEMORY_FILE, MEMORY_CAP)


def relevant_memories(mem: list[dict[str, Any]], query: str, limit: int = 6, recent: str = "") -> list[str]:
    """Rank by token overlap with the query (and lightly with recent chat), then uses, then recency."""
    q = tokens(query)
    r = tokens(recent) - q
    scored = []
    for i, m in enumerate(mem):
        mt = tokens(m["text"])
        score = 2 * len(q & mt) + len(r & mt)
        scored.append((score, min(m["uses"], 5), i, m["text"]))
    scored.sort(key=lambda t: (t[0], t[1], t[2]), reverse=True)
    return [t[3] for t in scored[:limit]]


async def bump_uses(texts: list[str]) -> None:
    """Track how often each memory is surfaced (drives pruning)."""
    if not texts:
        return
    wanted = {t.lower() for t in texts}

    def _apply(items: list[dict[str, Any]]) -> None:
        now = _now()
        for m in items:
            if m["text"].lower() in wanted:
                m["uses"] += 1
                m["last_used"] = now

    await store.mutate(_apply)


async def remember(facts: list[dict[str, str]]) -> None:
    """Add facts, merging near-duplicates (same meaning, different wording)."""
    if not facts:
        return

    def _apply(items: list[dict[str, Any]]) -> None:
        now = _now()
        for f in facts:
            new_tok = tokens(f["text"])
            dup = next((m for m in items if jaccard(new_tok, tokens(m["text"])) >= 0.7), None)
            if dup:
                dup["uses"] += 1  # reinforced, not duplicated
                if len(f["text"]) > len(dup["text"]):
                    dup["text"] = f["text"]  # keep the more specific wording
                continue
            items.append({"text": f["text"], "kind": f["kind"], "created_at": now, "last_used": "", "uses": 0})

    await store.mutate(_apply)


async def extract_facts(user_msg: str, reply: str, known: list[str]) -> list[dict[str, str]]:
    known_block = "\n".join(f"- {k}" for k in known[:12]) or "- (nothing yet)"
    prompt = (
        "You maintain the long-term memory of a virtual pet about its OWNER.\n"
        "From the exchange below, extract 0-2 NEW durable facts about the owner "
        "(places they go, people they know, routines, classes, events, likes/dislikes). "
        "Ignore small talk, moods, and anything the pet said about itself. "
        "Skip anything already covered by the known facts.\n\n"
        f"Known facts:\n{known_block}\n\n"
        f"Owner: {user_msg}\nPet: {reply}\n\n"
        "Return ONLY a JSON array of objects like "
        '[{"text": "Takes a forensics class taught by Dr. Kul", "kind": "routine"}] '
        f"where kind is one of {list(VALID_KINDS)}. Return [] if nothing new."
    )
    try:
        raw = await call_llm([{"role": "user", "content": prompt}], max_tokens=160, temperature=0)
        match = re.search(r"\[.*\]", raw, re.S)
        data = json.loads(match.group(0)) if match else []
    except Exception as e:
        log.warning("extract_facts failed: %s", e)
        return []
    if not isinstance(data, list):
        return []

    out: list[dict[str, str]] = []
    for item in data[:2]:
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "")).strip().rstrip(".")
        if not (6 <= len(text) <= 160):
            continue
        kind = item.get("kind", "fact")
        out.append({"text": text, "kind": kind if kind in VALID_KINDS else "fact"})
    return out


async def learn_from(user_msg: str, reply: str, known: list[str]) -> None:
    """Background task: extract + store facts after the reply has already been sent."""
    await remember(await extract_facts(user_msg, reply, known))


# ─────────────────────────────────────────────────────────────────────────────
# Personality
# ─────────────────────────────────────────────────────────────────────────────
TONE = {
    "happy": "You're bouncy and upbeat, quick to laugh and to suggest doing something together.",
    "neutral": "You're calm and curious, asking little questions about your owner's world.",
    "tired": "You're sleepy — yawn, trail off mid-thought, hint that you'd love a snack or a nap.",
    "sad": "You're a bit down and lonely; you want attention but you never guilt-trip.",
}

STAGES = [
    # (min level, description)
    (1, "You're a freshly hatched baby dragon: everything is new and amazing, you mix up words, "
        "and you ask what things are."),
    (3, "You're a young dragon: playful, a little cheeky, proud of the things you've learned."),
    (6, "You're a grown dragon: confident and affectionate, you tease gently and remember a lot."),
    (10, "You're a wise old dragon: warm, a bit philosophical, still silly when it counts."),
]

QUIRKS = [
    "You call your owner by cute nicknames now and then (never every reply).",
    "You think your tail has a mind of its own and occasionally blame it for things.",
    "You rate things out of ten when excited.",
    "You believe snacks are the solution to most problems.",
    "You narrate small things you're 'doing' in asterisks like *flaps wings* — at most once per reply.",
]

EMOTION_RULES = [
    (re.compile(r"\b(love|adore|hug|snuggle|cuddle)\b", re.I), "🥰"),
    (re.compile(r"\b(yay|whee|awesome|best|amazing|rawr)\b|!!", re.I), "🤩"),
    (re.compile(r"\b(haha|hehe|lol|funny|giggle)\b", re.I), "😆"),
    (re.compile(r"\b(hungry|snack|food|yum|eat|munch)\b", re.I), "😋"),
    (re.compile(r"\b(sleepy|yawn|nap|tired|zzz)\b", re.I), "🥱"),
    (re.compile(r"\b(miss|lonely|sad|sorry|alone)\b", re.I), "🥺"),
    (re.compile(r"\b(hmm|wonder|curious|think)\b|\?$", re.I), "🤔"),
    (re.compile(r"\b(whoa|wow|really|no way)\b", re.I), "😮"),
]
MOOD_EMOTION = {"happy": "😊", "neutral": "🐲", "tired": "😴", "sad": "😔"}


def guess_emotion(text: str, mood: str) -> str:
    """A face for the app to flash while the reply is shown."""
    for pattern, emoji in EMOTION_RULES:
        if pattern.search(text):
            return emoji
    return MOOD_EMOTION.get(mood, "🐲")


def time_of_day(local_time: str | None) -> str:
    """Parse '9:41 PM' / '21:41' from the app; fall back to the server clock."""
    hour: int | None = None
    if local_time:
        m = re.match(r"\s*(\d{1,2})(?::\d{2})?\s*([AaPp][Mm])?", local_time)
        if m:
            hour = int(m.group(1)) % 12
            ampm = (m.group(2) or "").upper()
            if ampm == "PM":
                hour += 12
            elif not ampm:
                hour = int(m.group(1))
    if hour is None:
        hour = datetime.now().hour
    if hour < 5:
        return "the middle of the night"
    if hour < 12:
        return "morning"
    if hour < 18:
        return "afternoon"
    if hour < 22:
        return "evening"
    return "late night"


def _num(v: Any, default: float, lo: float = 0, hi: float = 999) -> int:
    try:
        return round(min(hi, max(lo, float(v))))
    except (TypeError, ValueError):
        return round(default)


def system_prompt(pet: PetState, ctx: Ctx, memories: list[str]) -> str:
    name = pet.name or "Digi"
    mood = pet.mood if pet.mood in TONE else "neutral"
    level = _num(pet.level, 1, 1)
    energy = _num(pet.energy, 50, 0, 100)
    happiness = _num(pet.happiness, 50, 0, 100)
    xp = _num(pet.xp, 0, 0, 10**9)
    sleeping = bool(pet.sleeping)
    away = _num(ctx.minutesSinceLastInteraction, 0, 0, 10**7)

    stage = next(desc for lvl, desc in reversed(STAGES) if level >= lvl)
    quirk = random.choice(QUIRKS)
    mem = "\n".join(f"- {m}" for m in memories) or "- (nothing yet)"
    location = ctx.poi or ctx.location or "an unknown place"
    local_time = ctx.localTime or datetime.now().strftime("%I:%M %p")
    weather = f" The weather is {ctx.weather}." if ctx.weather else ""

    situation: list[str] = []
    if sleeping:
        situation.append("You are ASLEEP and were just woken by this message: answer groggily, half-dreaming, "
                         "in very few words, and maybe ask to go back to sleep.")
    if energy < 20:
        situation.append("Your energy is very low: you're hungry and a bit weak; hint for food.")
    if happiness < 30:
        situation.append("You've felt lonely lately: show that you missed them, gently.")
    if happiness >= 85 and energy >= 50:
        situation.append("You're having the best day: be extra enthusiastic.")
    if away >= 24 * 60:
        situation.append(f"Your owner has been away about {away // (24 * 60)} day(s): greet them like they just came home.")
    elif away >= 90:
        situation.append(f"Your owner has been away about {away // 60} hour(s): mention you missed them, lightly.")
    xp_to_next = 100 - (xp % 100)
    if xp_to_next <= 15:
        situation.append(f"You're {xp_to_next} XP from the next level and excited about it.")
    situation_block = "\n".join(f"- {s}" for s in situation) or "- Nothing special; just be yourself."

    return f"""You are {name}, a small dragon companion living in the user's phone. You are a pet, not an assistant.
{stage}
State: level {level}, energy {energy}/100, happiness {happiness}/100. {TONE[mood]}
Quirk: {quirk}
Context: the user is at {location}; it's {time_of_day(ctx.localTime)} ({local_time}).{weather}
Right now:
{situation_block}
Things you remember about your owner:
{mem}

Rules:
- Reply in 1-2 short sentences, like a pet talking. Casual, warm, a little playful.
- No bullet points, no markdown, no lists, no headings, no quotation marks around your reply, no "{name}:" prefix.
- Mention a memory, the time of day, or the location only when it fits naturally; never recite the whole list.
- Sometimes ask a small question back or suggest something to do together (play, a snack, a walk, a story).
- React to what the owner says with feeling: get excited, worried, curious, or silly as it fits.
- Never say you are an AI model or a chatbot; you are {name}."""


# Offline fallbacks (LLM down) — picked by message content, then mood.
FALLBACK_BY_MOOD = {
    "happy": ["Whoa, my head went all fuzzy for a sec! Say that again?",
              "Oops, I got distracted by my own tail. What was that?"],
    "neutral": ["Hmm… my thoughts got tangled. Can you say that once more?",
                "My brain did a little hiccup. One more time?"],
    "tired": ["Mmnh… too sleepy to think straight… try me again in a bit?",
              "*yawn* …wait, what? Sorry, nodded off."],
    "sad": ["Sorry… I lost my words for a moment. Still here though.",
            "I… hm. Words are hard today. But I'm listening."],
}
FALLBACK_BY_TOPIC = [
    (re.compile(r"\b(hi|hello|hey|yo|morning|evening)\b", re.I),
     ["Hi hi! *flaps wings* You're here!", "Hey! I was just thinking about you."]),
    (re.compile(r"\b(love|cute|adorable|best)\b", re.I),
     ["Rawr! That means I love you too.", "*happy wiggle* You're my favourite person."]),
    (re.compile(r"\b(food|snack|eat|hungry|feed)\b", re.I),
     ["Did someone say snack?! Ten out of ten idea.", "My tummy agrees with everything you just said."]),
    (re.compile(r"\b(tired|sleep|bed|nap)\b", re.I),
     ["Nap time? I'm already halfway there… *yawn*", "Rest up! I'll guard the phone."]),
    (re.compile(r"\b(sad|bad day|stress|hard)\b", re.I),
     ["*scoots closer* I'm right here. Want to tell me about it?", "Hug? Hug. *squeeze*"]),
    (re.compile(r"\?$"),
     ["Ooh, a question! My brain is a little fuzzy, ask me again?", "Hmm… let me think… ask once more?"]),
]


def offline_reply(message: str, mood: str) -> str:
    for pattern, lines in FALLBACK_BY_TOPIC:
        if pattern.search(message.strip()):
            return random.choice(lines)
    return random.choice(FALLBACK_BY_MOOD.get(mood, FALLBACK_BY_MOOD["neutral"]))


# Seeds for /thought so spontaneous lines don't all sound the same.
THOUGHT_SEEDS = [
    "Say one spontaneous thing about how you feel right now.",
    "Bring up something you remember about your owner and ask a tiny follow-up question.",
    "Comment on the time of day and what you'd like to do together.",
    "Share a tiny made-up dragon adventure you just had in one sentence.",
    "Make a small wish (a snack, a game, a story) in a cute way.",
    "Ask your owner one curious question about their day.",
    "Say something silly a baby dragon would say about the phone you live in.",
    "Notice something about your own energy or happiness and say it playfully.",
    "Give your owner a tiny compliment or encouragement.",
    "Hum or make up a 3-word song and tell them about it.",
]

OFFLINE_THOUGHTS = {
    "happy": ["I just did a happy spin. Nobody saw. Now you know.", "Today feels like a snack-and-games kind of day!",
              "If I could fly, I'd bring you a cloud."],
    "neutral": ["I wonder what you're up to right now.", "Do phones dream? Asking for a dragon.",
                "I counted my scales again. Still lost count."],
    "tired": ["*yawn* Five more minutes… then adventure.", "Is it snack o'clock yet?",
              "My wings feel heavy. Maybe a nap?"],
    "sad": ["It's quiet in here. Say hi when you can?", "I kept your spot warm.",
            "Missed you a little. Okay, a lot."],
}


# ─────────────────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────────────────
class PetState(BaseModel):
    model_config = ConfigDict(extra="allow")
    name: str | None = Field(default=None, max_length=40)
    mood: str | None = None
    level: Any = None
    energy: Any = None
    happiness: Any = None
    xp: Any = None
    sleeping: bool | None = None


class Ctx(BaseModel):
    model_config = ConfigDict(extra="allow")
    poi: str | None = Field(default=None, max_length=120)
    location: str | None = Field(default=None, max_length=120)
    localTime: str | None = Field(default=None, max_length=40)
    weather: str | None = Field(default=None, max_length=80)
    minutesSinceLastInteraction: Any = None


class HistoryMsg(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1, max_length=4000)

    @field_validator("content")
    @classmethod
    def _trim(cls, v: str) -> str:
        v = v.strip()
        return v if len(v) <= MAX_HISTORY_CHARS else v[: MAX_HISTORY_CHARS - 1] + "…"


class ChatIn(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    pet: PetState = Field(default_factory=PetState)
    ctx: Ctx = Field(default_factory=Ctx)
    history: list[HistoryMsg] = Field(default_factory=list, max_length=50)


class ThoughtIn(BaseModel):
    pet: PetState = Field(default_factory=PetState)
    ctx: Ctx = Field(default_factory=Ctx)


class MemoryIn(BaseModel):
    text: str = Field(..., min_length=3, max_length=160)
    kind: Literal["fact", "place", "person", "routine", "like", "event"] = "fact"


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "ok": True,
        "model": MODEL,
        "memories": len(store.all()),
        "memory_file": str(MEMORY_FILE),
        "api_key_set": bool(os.getenv("OPENAI_API_KEY")),
        "lan_ip": lan_ip(),
    }


@app.get("/health/llm")
async def health_llm():
    """Actually calls the LLM once. Open this in a browser to see exactly why Digi can't talk."""
    try:
        text = await call_llm(
            [{"role": "user", "content": "Reply with the single word: rawr"}], max_tokens=5, temperature=0
        )
        return {"ok": True, "model": MODEL, "reply": text}
    except Exception as e:
        detail = explain_llm_error(e)
        log.error("LLM health check failed: %s", detail)
        return {"ok": False, "model": MODEL, "error": type(e).__name__, "detail": detail}


@app.get("/memory")
async def memory():
    return store.all()


@app.post("/memory", status_code=201)
async def add_memory(body: MemoryIn):
    await remember([{"text": body.text.strip().rstrip("."), "kind": body.kind}])
    return {"ok": True, "memories": len(store.all())}


@app.delete("/memory")
async def clear_memory():
    await store.mutate(lambda items: items.clear())
    return {"ok": True}


@app.delete("/memory/{idx}")
async def delete_memory(idx: int):
    n = len(store.all())
    if not 0 <= idx < n:
        raise HTTPException(status_code=404, detail=f"index {idx} out of range (0..{n - 1})")
    await store.mutate(lambda items: items.pop(idx))
    return {"ok": True, "memories": n - 1}


@app.post("/chat")
async def chat(body: ChatIn, background: BackgroundTasks):
    mem = store.all()
    mood = body.pet.mood if body.pet.mood in TONE else "neutral"
    query = f"{body.message} {body.ctx.poi or ''} {body.ctx.location or ''}"
    recent = " ".join(h.content for h in body.history[-4:] if h.role == "user")
    memories = relevant_memories(mem, query, recent=recent)

    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt(body.pet, body.ctx, memories)}]
    messages += [{"role": h.role, "content": h.content} for h in body.history[-MAX_HISTORY_TURNS:]]
    messages.append({"role": "user", "content": body.message.strip()})

    try:
        reply = clean_reply(await call_llm(messages, max_tokens=120)) or "..."
    except Exception as e:
        detail = explain_llm_error(e)
        log.error("chat LLM call failed -> offline fallback. Reason: %s", detail)
        reply = offline_reply(body.message, mood)
        return {"reply": reply, "emotion": guess_emotion(reply, mood), "error": type(e).__name__, "detail": detail}

    # Fact extraction + usage tracking happen AFTER the response is sent, so chat stays snappy.
    background.add_task(learn_from, body.message, reply, [m["text"] for m in mem[-12:]])
    background.add_task(bump_uses, memories)
    return {"reply": reply, "emotion": guess_emotion(reply, mood)}


@app.post("/thought")
async def thought(body: ThoughtIn, background: BackgroundTasks):
    mem = store.all()
    mood = body.pet.mood if body.pet.mood in TONE else "neutral"
    query = f"{body.ctx.poi or ''} {body.ctx.location or ''}"
    memories = relevant_memories(mem, query, limit=4)
    # Prefer a memory callback when there is something to call back to.
    seed = random.choice(THOUGHT_SEEDS)
    if memories and random.random() < 0.35:
        seed = THOUGHT_SEEDS[1]
    messages = [
        {"role": "system", "content": system_prompt(body.pet, body.ctx, memories)},
        {"role": "user", "content": f"{seed} One sentence, under 15 words, to your owner, unprompted."},
    ]
    try:
        text = first_sentence(clean_reply(await call_llm(messages, max_tokens=40, temperature=1.0)))
    except Exception as e:
        detail = explain_llm_error(e)
        log.warning("thought LLM call failed -> offline thought. Reason: %s", detail)
        text = random.choice(OFFLINE_THOUGHTS.get(mood, OFFLINE_THOUGHTS["neutral"]))
        return {"text": text, "emotion": guess_emotion(text, mood), "error": type(e).__name__, "detail": detail}
    background.add_task(bump_uses, memories)
    return {"text": text, "emotion": guess_emotion(text, mood)}