"""Classroom quiz platform: quizzes, live games, assignments and spin-the-wheel.

FastAPI + SQLite, one process. Live games keep their turn state in memory (see live.py) and
every answer in the database, so a restart loses at most the question in progress.
"""
import asyncio
import contextvars
import csv
import hashlib
import hmac
import io
import json
import os
import random
import re
import secrets
import sqlite3
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

HERE = Path(__file__).parent
DATA = Path(os.environ.get("QUIZ_DATA", HERE.parent / "data"))
STATIC = HERE / "static"
SEED = Path(os.environ.get("QUIZ_SEED_DIR", HERE / "seed"))
SEED_ON = os.environ.get("QUIZ_SEED", "on") != "off"  # load the starter quizzes into the library
SECURE_COOKIE = os.environ.get("QUIZ_SECURE_COOKIE", "1") == "1"
ROLES = ("student", "teacher", "admin")
# Starting values of the settings an admin can change on the site.
DEFAULTS = {"registration": "open" if os.environ.get("QUIZ_REGISTRATION", "open") == "open" else "closed",
            "default_role": "teacher" if os.environ.get("QUIZ_DEFAULT_ROLE") == "teacher" else "student"}
SESSION_DAYS = 30
MAX_PLAYERS = 500
MAX_UPLOAD = 2 * 1024 * 1024
ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"  # no 0/o/1/l/i

LANG = contextvars.ContextVar("lang", default="id")
MSG = {
    "auth": ("Silakan masuk dulu.", "Please sign in first."),
    "forbidden": ("Anda tidak punya akses ke data ini.", "You don't have access to this."),
    "notfound": ("Tidak ditemukan.", "Not found."),
    "csrf": ("Permintaan ditolak.", "Request refused."),
    "email": ("Email tidak valid.", "That email address is not valid."),
    "pw": ("Kata sandi minimal 8 karakter.", "Password must be at least 8 characters."),
    "name": ("Nama wajib diisi (maks. 60 karakter).", "Name is required (60 characters at most)."),
    "exists": ("Email itu sudah terdaftar. Silakan masuk.", "That email is already registered. Sign in instead."),
    "badlogin": ("Email atau kata sandi salah.", "Wrong email or password."),
    "slow": ("Terlalu banyak percobaan. Coba lagi beberapa menit lagi.", "Too many attempts. Try again in a few minutes."),
    "closed": ("Pendaftaran sedang ditutup.", "Registration is closed."),
    "ended": ("Permainan ini sudah selesai.", "This game has ended."),
    "nick": ("Nama panggilan 1-30 karakter.", "Nickname must be 1-30 characters."),
    "taken": ("Nama itu sudah dipakai di permainan ini. Pilih nama lain.", "That name is taken in this game. Pick another."),
    "login_required": ("Guru mewajibkan masuk akun untuk permainan ini.", "The teacher requires an account for this game."),
    "player": ("Pemain tidak dikenal. Silakan gabung lagi.", "Unknown player. Please join again."),
    "order": ("Soal ini sudah dijawab atau belum waktunya.", "That question is already answered or not open yet."),
    "answer": ("Format jawaban tidak valid.", "That answer is not in a valid format."),
    "deadline": ("Batas waktu tugas sudah lewat.", "The assignment deadline has passed."),
    "image": ("Gambar harus PNG, JPG, GIF, atau WebP, maks. 2 MB.", "Images must be PNG, JPG, GIF or WebP, 2 MB at most."),
    "quota": ("Batas unggahan gambar tercapai.", "Image upload limit reached."),
    "full": ("Permainan penuh.", "The game is full."),
    "title": ("Judul wajib diisi (maks. 200 karakter).", "Title is required (200 characters at most)."),
    "noq": ("Kuis perlu 1-200 soal.", "A quiz needs 1-200 questions."),
    "passage": ("Bacaan {n}: isi teks bacaan (maks. 20.000 karakter, paling banyak 20 bacaan).", "Passage {n}: give the passage text (20,000 characters at most, up to 20 passages)."),
    "q_text": ("Soal {n}: teks soal wajib diisi.", "Question {n}: the question text is required."),
    "q_type": ("Soal {n}: tipe soal tidak dikenal.", "Question {n}: unknown question type."),
    "q_options": ("Soal {n}: isi 2-6 pilihan jawaban.", "Question {n}: give 2-6 answer options."),
    "q_answer": ("Soal {n}: tandai jawaban yang benar.", "Question {n}: mark the correct answer."),
    "q_image": ("Soal {n}: alamat gambar tidak valid.", "Question {n}: the image address is not valid."),
    "wheel": ("Roda perlu judul dan 2-200 isian.", "A wheel needs a title and 2-200 entries."),
    "mode": ("Mode permainan tidak dikenal.", "Unknown game mode."),
    "review_off": ("Guru tidak membuka kunci jawaban untuk permainan ini.", "The teacher has not opened the answer key for this game."),
    "review_early": ("Pembahasan terbuka setelah Anda menyelesaikan kuis.", "The review opens once you have finished the quiz."),
    "sheet": ("Berkas tidak bisa dibaca. Gunakan Excel (.xlsx) atau CSV, maks. 2 MB.", "That file could not be read. Use Excel (.xlsx) or CSV, 2 MB at most."),
    "sheet_empty": ("Tidak ada daftar di berkas itu. Isi kolom pertama dengan nomor dan kolom kedua dengan nama.", "No list was found in that file. Put numbers in the first column and names in the second."),
    "teacher": ("Fitur ini untuk akun guru. Minta admin situs untuk menaikkan akun Anda.", "This is for teacher accounts. Ask the site admin to upgrade yours."),
    "admin": ("Hanya admin yang bisa membuka ini.", "Only an admin can open this."),
}


def fail(status, key, **fmt):
    idn, en = MSG[key]
    raise HTTPException(status, (en if LANG.get() == "en" else idn).format(**fmt))


# --------------------------------------------------------------------------- database
DATA.mkdir(parents=True, exist_ok=True)
(DATA / "uploads").mkdir(exist_ok=True)
_db = sqlite3.connect(DATA / "quiz.db", isolation_level=None, check_same_thread=False)
_db.row_factory = sqlite3.Row
_db.executescript("""
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
  pw TEXT NOT NULL, created REAL NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS quizzes(
  id TEXT PRIMARY KEY, owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  public INTEGER NOT NULL DEFAULT 0, questions TEXT NOT NULL, created REAL NOT NULL,
  updated REAL NOT NULL, plays INTEGER NOT NULL DEFAULT 0, seed TEXT);
CREATE TABLE IF NOT EXISTS games(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, quiz_id TEXT,
  host_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL,
  mode TEXT NOT NULL, settings TEXT NOT NULL, questions TEXT NOT NULL, status TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}', created REAL NOT NULL, ended REAL);
CREATE TABLE IF NOT EXISTS players(
  id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE, user_id INTEGER, token TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0, kicked INTEGER NOT NULL DEFAULT 0, joined REAL NOT NULL,
  finished REAL, UNIQUE(game_id, name));
CREATE TABLE IF NOT EXISTS answers(
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE, qi INTEGER NOT NULL,
  served REAL, answer TEXT, correct INTEGER, points INTEGER NOT NULL DEFAULT 0, ms INTEGER,
  answered REAL, PRIMARY KEY(player_id, qi));
CREATE TABLE IF NOT EXISTS wheels(
  id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, items TEXT NOT NULL, updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS uploads(
  name TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS players_game ON players(game_id);
CREATE INDEX IF NOT EXISTS players_user ON players(user_id);
CREATE INDEX IF NOT EXISTS games_host ON games(host_id);
""")

if "passages" not in {c["name"] for c in _db.execute("PRAGMA table_info(quizzes)")}:
    _db.execute("ALTER TABLE quizzes ADD COLUMN passages TEXT NOT NULL DEFAULT '[]'")
if "role" not in {c["name"] for c in _db.execute("PRAGMA table_info(users)")}:
    _db.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'student'")


def rows(sql, *args):
    return _db.execute(sql, args).fetchall()


def row(sql, *args):
    return _db.execute(sql, args).fetchone()


def run(sql, *args):
    return _db.execute(sql, args)


# --------------------------------------------------------------------------- quiz content
def _text(value, limit):
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value or "")).strip()[:limit]


def _int(value, lo, hi, default):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def clean_question(q, n):
    """Validate one question into the stored form. `n` is its 1-based number for messages."""
    if not isinstance(q, dict):
        fail(400, "q_text", n=n)
    kind = q.get("type", "single")
    if kind not in ("single", "multi", "tf", "text", "poll"):
        fail(400, "q_type", n=n)
    text = _text(q.get("text") or q.get("question"), 2000)
    if not text:
        fail(400, "q_text", n=n)
    image = _text(q.get("image"), 500)
    if image and not (re.fullmatch(r"/uploads/[a-z0-9]{20}\.(png|jpg|gif|webp)", image)
                      or re.fullmatch(r"https://[^\s\"'<>]+", image)):
        fail(400, "q_image", n=n)
    out = {"type": kind, "text": text, "image": image,
           "time": _int(q.get("time"), 5, 600, 30),
           "points": 0 if kind == "poll" else _int(q.get("points"), 0, 2000, 1000),
           "explanation": _text(q.get("explanation"), 2000),
           "criterion": _text(q.get("criterion"), 120)}  # rubric criterion / learning outcome it assesses
    answer = q.get("answer")
    if kind in ("single", "multi", "poll"):
        options = q.get("options")
        if not isinstance(options, list):
            fail(400, "q_options", n=n)
        options = [_text(o, 300) for o in options]
        if not 2 <= len(options) <= 6 or not all(options):
            fail(400, "q_options", n=n)
        out["options"] = options
        if kind == "single":
            if type(answer) is not int or not 0 <= answer < len(options):
                fail(400, "q_answer", n=n)
            out["answer"] = answer
        elif kind == "multi":
            if (not isinstance(answer, list) or not answer
                    or any(type(a) is not int or not 0 <= a < len(options) for a in answer)):
                fail(400, "q_answer", n=n)
            out["answer"] = sorted(set(answer))
    elif kind == "tf":
        if type(answer) is not bool:
            fail(400, "q_answer", n=n)
        out["answer"] = answer
    else:  # text
        accepted = answer if isinstance(answer, list) else [answer]
        accepted = [a for a in (_text(a, 100) for a in accepted) if a][:10]
        if not accepted:
            fail(400, "q_answer", n=n)
        out["answer"] = accepted
    return out


def clean_quiz(body):
    if not isinstance(body, dict):
        fail(400, "title")
    title = _text(body.get("title"), 200)
    if not title:
        fail(400, "title")
    questions = body.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 200:
        fail(400, "noq")
    # Reading passages: shown before, and then beside, the questions that point at them.
    raw_passages = body.get("passages") or []
    if not isinstance(raw_passages, list) or len(raw_passages) > 20:
        fail(400, "passage", n=21)
    passages = []
    for i, p in enumerate(raw_passages):
        text = _text(p.get("text"), 20000) if isinstance(p, dict) else ""
        if not text:
            fail(400, "passage", n=i + 1)
        passages.append({"title": _text(p.get("title"), 200), "text": text})
    cleaned = []
    for i, q in enumerate(questions):
        c = clean_question(q, i + 1)
        at = q.get("passage")
        c["passage"] = at if type(at) is int and 0 <= at < len(passages) else None
        cleaned.append(c)
    return {"title": title,
            "subject": _text(body.get("subject") or body.get("course"), 100),
            "description": _text(body.get("description"), 1000),
            "public": 1 if body.get("public") else 0,
            "passages": passages,
            "questions": cleaned}


def fold(s):
    return re.sub(r"\s+", " ", str(s)).strip().casefold()


def valid_answer(q, a):
    kind = q["type"]
    if kind in ("single", "poll"):
        return type(a) is int and 0 <= a < len(q["options"])
    if kind == "multi":
        return (isinstance(a, list) and 0 < len(a) <= len(q["options"])
                and all(type(x) is int and 0 <= x < len(q["options"]) for x in a))
    if kind == "tf":
        return type(a) is bool
    return isinstance(a, str) and 0 < len(a.strip()) <= 200


def grade(q, a):
    """True/False, or None for a poll (no right answer). `a` is None when time ran out."""
    kind = q["type"]
    if kind == "poll":
        return None
    if a is None:
        return False
    if kind == "multi":
        return sorted(set(a)) == q["answer"]
    if kind == "text":
        return fold(a) in {fold(x) for x in q["answer"]}
    return a == q["answer"]


def points_for(q, correct, ms, timed=True):
    """Full points for an instant correct answer, sliding to half at the time limit."""
    if not correct or not q["points"]:
        return 0
    if not timed:
        return q["points"]
    used = min(max(ms, 0) / (q["time"] * 1000), 1)
    return round(q["points"] * (1 - 0.5 * used))


def public_question(q):
    return {k: q[k] for k in ("type", "text", "image", "time", "points", "options") if k in q}


def shuffled(questions, rng, shuffle_q, shuffle_o):
    """Reorder questions/options, remapping answers. Returns (questions, order) where
    order[k] is the stored index of the k-th question shown."""
    # Questions on the same passage stay together and in their own order.
    blocks = []
    for i, q in enumerate(questions):
        if blocks and q.get("passage") is not None and questions[blocks[-1][-1]].get("passage") == q.get("passage"):
            blocks[-1].append(i)
        else:
            blocks.append([i])
    if shuffle_q:
        rng.shuffle(blocks)
    order = [i for block in blocks for i in block]
    out = []
    for i in order:
        q = dict(questions[i])
        if shuffle_o and "options" in q:
            perm = list(range(len(q["options"])))
            rng.shuffle(perm)
            q["options"] = [q["options"][p] for p in perm]
            q["perm"] = perm  # shown position -> stored position
            if q["type"] == "single":
                q["answer"] = perm.index(q["answer"])
            elif q["type"] == "multi":
                q["answer"] = sorted(perm.index(a) for a in q["answer"])
        out.append(q)
    return out, order


def passage_for(passages, questions, k):
    """The passage of question k, and whether k is the first question on it (so it is shown first)."""
    at = questions[k].get("passage")
    if at is None or at >= len(passages):
        return None, False
    count = 1
    while k + count < len(questions) and questions[k + count].get("passage") == at:
        count += 1
    return {**passages[at], "count": count}, k == 0 or questions[k - 1].get("passage") != at


def stored_answer(q, a):
    """Translate an answer given against shuffled options back to stored option numbers."""
    perm = q.get("perm")
    if perm is None or a is None:
        return a
    if isinstance(a, list):
        return sorted(perm[x] for x in a)
    return perm[a]


# --------------------------------------------------------------------------- app + auth
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_attempts = {}


def throttle(key, limit, window):
    """Sliding-window counter. Returns False once `limit` hits landed inside `window` seconds."""
    now = time.time()
    hits = [t for t in _attempts.get(key, ()) if now - t < window]
    if len(hits) >= limit:
        _attempts[key] = hits
        return False
    hits.append(now)
    _attempts[key] = hits
    if len(_attempts) > 20000:
        for k in [k for k, v in _attempts.items() if not v or now - v[-1] > 3600]:
            del _attempts[k]
    return True


def client_ip(request):
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "?")


@app.middleware("http")
async def guard(request: Request, call_next):
    LANG.set("en" if request.headers.get("x-lang") == "en" else "id")
    path = request.url.path
    # A custom header cannot be sent cross-site without a CORS preflight, which we never grant.
    if path.startswith("/api/") and request.method not in ("GET", "HEAD") \
            and request.headers.get("x-quiz") != "1":
        idn, en = MSG["csrf"]
        return JSONResponse({"detail": en if LANG.get() == "en" else idn}, 403)
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; "
        "form-action 'self'")
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    elif path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"  # revalidate, so a deploy shows up at once
    return response


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def check_password(password, stored):
    try:
        _, salt, digest = stored.split("$")
        return hmac.compare_digest(hash_password(password, bytes.fromhex(salt)).split("$")[2], digest)
    except ValueError:
        return False


def _token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def user_from_token(token):
    if not token:
        return None
    return row("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
               "WHERE s.token = ? AND s.expires > ? AND u.disabled = 0", _token_hash(token), time.time())


def current_user(request):
    return user_from_token(request.cookies.get("qsid"))


def need_user(request):
    user = current_user(request)
    if not user:
        fail(401, "auth")
    return user


def start_session(response, user_id):
    token = secrets.token_urlsafe(32)
    run("DELETE FROM sessions WHERE expires < ?", time.time())
    run("INSERT INTO sessions VALUES (?,?,?)", _token_hash(token), user_id, time.time() + SESSION_DAYS * 86400)
    response.set_cookie("qsid", token, max_age=SESSION_DAYS * 86400, httponly=True,
                        secure=SECURE_COOKIE, samesite="lax", path="/")


def need_teacher(request):
    user = need_user(request)
    if user["role"] not in ("teacher", "admin"):
        fail(403, "teacher")
    return user


def need_admin(request):
    user = need_user(request)
    if user["role"] != "admin":
        fail(403, "admin")
    return user


def site_settings():
    saved = {r["key"]: r["value"] for r in rows("SELECT key, value FROM settings")}
    merged = {**DEFAULTS, **saved}
    return {"registration": merged["registration"] == "open", "default_role": merged["default_role"]}


def set_setting(key, value):
    run("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)


def valid_identity(body):
    email = _text(body.get("email"), 200).lower()
    name = _text(body.get("name"), 60)
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        fail(400, "email")
    if not name:
        fail(400, "name")
    return email, name


def user_json(user):
    return {"id": user["id"], "name": user["name"], "email": user["email"], "role": user["role"]}


async def body_of(request):
    try:
        body = await request.json()
    except Exception:
        body = None
    return body if isinstance(body, dict) else {}


@app.get("/healthz")
async def healthz():
    return PlainTextResponse("ok")


@app.post("/api/auth/register")
async def register(request: Request, response: Response):
    settings = site_settings()
    if not settings["registration"]:
        fail(403, "closed")
    if not throttle(("reg", client_ip(request)), 120, 3600):
        fail(429, "slow")
    body = await body_of(request)
    email, name = valid_identity(body)
    password = str(body.get("password") or "")
    if not 8 <= len(password) <= 200:
        fail(400, "pw")
    if row("SELECT 1 FROM users WHERE email = ?", email):
        fail(409, "exists")
    pw = await asyncio.to_thread(hash_password, password)
    try:
        uid = run("INSERT INTO users(email,name,pw,created,role) VALUES (?,?,?,?,?)",
                  email, name, pw, time.time(), settings["default_role"]).lastrowid
    except sqlite3.IntegrityError:
        fail(409, "exists")
    start_session(response, uid)
    return {"id": uid, "name": name, "email": email, "role": settings["default_role"]}


@app.post("/api/auth/login")
async def login(request: Request, response: Response):
    body = await body_of(request)
    email = _text(body.get("email"), 200).lower()
    password = str(body.get("password") or "")[:200]
    user = row("SELECT * FROM users WHERE email = ? AND disabled = 0", email)
    ok = await asyncio.to_thread(check_password, password, user["pw"] if user else hash_password("x"))
    if not (user and ok):
        # Only failures count, so a whole class signing in from one campus address is fine.
        if not (throttle(("login", email), 10, 900) and throttle(("login-ip", client_ip(request)), 200, 900)):
            fail(429, "slow")
        fail(401, "badlogin")
    start_session(response, user["id"])
    return user_json(user)


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get("qsid")
    if token:
        run("DELETE FROM sessions WHERE token = ?", _token_hash(token))
    response.delete_cookie("qsid", path="/")
    return {"ok": True}


@app.get("/api/me")
async def me(request: Request):
    user = current_user(request)
    return {"user": user_json(user) if user else None, "registration": site_settings()["registration"], "ai": ai.enabled(),
            "site": brand.site()}


# --------------------------------------------------------------------------- quizzes
def new_id(length=8):
    return "".join(secrets.choice(ID_ALPHABET) for _ in range(length))


def quiz_summary(r, user=None):
    return {"id": r["id"], "title": r["title"], "subject": r["subject"], "description": r["description"],
            "public": bool(r["public"]), "count": len(json.loads(r["questions"])), "plays": r["plays"],
            "updated": r["updated"], "mine": bool(user and r["owner_id"] == user["id"]),
            "author": r["author"] if "author" in r.keys() else None}


def get_quiz(quiz_id, user, write=False):
    r = row("SELECT q.*, COALESCE(u.name, ?) AS author FROM quizzes q "
            "LEFT JOIN users u ON u.id = q.owner_id WHERE q.id = ?", brand.site()["name"], quiz_id)
    if not r:
        fail(404, "notfound")
    mine = bool(user and r["owner_id"] == user["id"])
    if user and user["role"] == "admin":
        return r  # admins can open, edit and remove any quiz
    if not mine and (write or not r["public"]):
        fail(403, "forbidden")
    return r


def insert_quiz(owner_id, quiz, seed=None):
    now = time.time()
    while True:
        quiz_id = new_id()
        try:
            run("INSERT INTO quizzes(id,owner_id,title,subject,description,public,questions,created,updated,seed,passages) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)", quiz_id, owner_id, quiz["title"], quiz["subject"],
                quiz["description"], quiz["public"], json.dumps(quiz["questions"], ensure_ascii=False), now, now, seed,
                json.dumps(quiz.get("passages", []), ensure_ascii=False))
            return quiz_id
        except sqlite3.IntegrityError:
            continue


@app.get("/api/quizzes")
async def my_quizzes(request: Request):
    user = need_teacher(request)
    return [quiz_summary(r, user) for r in
            rows("SELECT * FROM quizzes WHERE owner_id = ? ORDER BY updated DESC", user["id"])]


@app.get("/api/explore")
async def explore(request: Request, q: str = ""):
    user = current_user(request)
    like = f"%{q.strip()[:60]}%"
    found = rows("SELECT q.*, COALESCE(u.name, ?) AS author FROM quizzes q "
                 "LEFT JOIN users u ON u.id = q.owner_id WHERE q.public = 1 AND "
                 "(q.title LIKE ? OR q.subject LIKE ? OR q.description LIKE ?) "
                 "ORDER BY q.plays DESC, q.updated DESC LIMIT 60", brand.site()["name"], like, like, like)
    return [quiz_summary(r, user) for r in found]


@app.post("/api/quizzes")
async def create_quiz(request: Request):
    user = need_teacher(request)
    quiz = clean_quiz(await body_of(request))
    return {"id": insert_quiz(user["id"], quiz)}


@app.get("/api/quizzes/{quiz_id}")
async def read_quiz(quiz_id: str, request: Request):
    user = need_teacher(request)
    r = get_quiz(quiz_id, user)
    return {**quiz_summary(r, user), "questions": json.loads(r["questions"]), "passages": json.loads(r["passages"])}


@app.put("/api/quizzes/{quiz_id}")
async def update_quiz(quiz_id: str, request: Request):
    user = need_teacher(request)
    get_quiz(quiz_id, user, write=True)
    quiz = clean_quiz(await body_of(request))
    run("UPDATE quizzes SET title=?, subject=?, description=?, public=?, questions=?, passages=?, updated=? WHERE id=?",
        quiz["title"], quiz["subject"], quiz["description"], quiz["public"],
        json.dumps(quiz["questions"], ensure_ascii=False), json.dumps(quiz["passages"], ensure_ascii=False), time.time(), quiz_id)
    return {"id": quiz_id}


@app.delete("/api/quizzes/{quiz_id}")
async def delete_quiz(quiz_id: str, request: Request):
    user = need_teacher(request)
    get_quiz(quiz_id, user, write=True)
    run("DELETE FROM quizzes WHERE id = ?", quiz_id)  # past games keep their own copy
    return {"ok": True}


@app.post("/api/quizzes/{quiz_id}/duplicate")
async def duplicate_quiz(quiz_id: str, request: Request):
    user = need_teacher(request)
    r = get_quiz(quiz_id, user)
    # The copy is private and independent: its own ID, games and reports. A name can be given
    # (e.g. the class it is for); otherwise it is told apart with "(2)".
    title = _text((await body_of(request)).get("title"), 200)
    if not title:
        title = r["title"] if r["owner_id"] != user["id"] else (r["title"] + " (2)")[:200]
    return {"id": insert_quiz(user["id"], {"title": title, "subject": r["subject"], "description": r["description"],
                                           "public": 0, "questions": json.loads(r["questions"]),
                                           "passages": json.loads(r["passages"])})}


IMAGE_MAGIC = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"), (b"GIF87a", "gif"), (b"GIF89a", "gif"))


@app.post("/api/uploads")
async def upload_image(request: Request):
    user = need_teacher(request)
    if int(request.headers.get("content-length") or 0) > MAX_UPLOAD:
        fail(413, "image")
    data = await request.body()
    ext = next((e for magic, e in IMAGE_MAGIC if data.startswith(magic)), None)
    if not ext and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        ext = "webp"
    if not ext or len(data) > MAX_UPLOAD:
        fail(400, "image")
    if row("SELECT COUNT(*) c FROM uploads WHERE owner_id = ?", user["id"])["c"] >= 500:
        fail(400, "quota")
    name = f"{new_id(20)}.{ext}"
    (DATA / "uploads" / name).write_bytes(data)
    run("INSERT INTO uploads VALUES (?,?,?)", name, user["id"], time.time())
    return {"url": f"/uploads/{name}"}


@app.get("/uploads/{name}")
async def uploaded(name: str):
    if not re.fullmatch(r"[a-z0-9]{20}\.(png|jpg|gif|webp)", name) or not (DATA / "uploads" / name).is_file():
        raise HTTPException(404)
    return FileResponse(DATA / "uploads" / name, headers={"Cache-Control": "public, max-age=31536000, immutable"})


# --------------------------------------------------------------------------- games
def settings_from(body, mode):
    deadline = body.get("deadline")
    return {"shuffle_questions": bool(body.get("shuffle_questions")),
            "shuffle_options": bool(body.get("shuffle_options")),
            "show_answers": body.get("show_answers", True) is not False,
            "require_login": bool(body.get("require_login")),
            "timer": True if mode == "live" else bool(body.get("timer")),
            "deadline": float(deadline) if mode == "async" and isinstance(deadline, (int, float)) and deadline > 0 else None,
            **guard.settings_from(body)}


def create_game(quiz_row, host_id, mode, settings):
    questions = json.loads(quiz_row["questions"])
    settings = {**settings, "passages": json.loads(quiz_row["passages"])}  # the game keeps its own copy
    if mode == "live":  # everyone sees the same order, so shuffle once now
        questions, _ = shuffled(questions, random.Random(), settings["shuffle_questions"], settings["shuffle_options"])
        for q in questions:
            q.pop("perm", None)
    while True:
        code = str(secrets.randbelow(900000) + 100000)
        try:
            run("INSERT INTO games(code,quiz_id,host_id,title,mode,settings,questions,status,created) VALUES (?,?,?,?,?,?,?,?,?)",
                code, quiz_row["id"], host_id, quiz_row["title"], mode, json.dumps(settings),
                json.dumps(questions, ensure_ascii=False), "lobby" if mode == "live" else "running", time.time())
            break
        except sqlite3.IntegrityError:
            continue
    run("UPDATE quizzes SET plays = plays + 1 WHERE id = ?", quiz_row["id"])
    return code


def get_game(code):
    game = row("SELECT * FROM games WHERE code = ?", code)
    if not game:
        fail(404, "notfound")
    return game


def host_game(code, request):
    user = need_teacher(request)
    game = get_game(code)
    if game["host_id"] != user["id"]:
        fail(403, "forbidden")
    return game


def game_open(game):
    if game["status"] == "ended":
        return False
    deadline = json.loads(game["settings"]).get("deadline")
    return not (deadline and time.time() > deadline)


def ranking(game_id):
    return rows("SELECT id, name, score, finished FROM players WHERE game_id = ? AND kicked = 0 "
                "ORDER BY score DESC, COALESCE(finished, joined), id", game_id)


def standing(game_id, player_id=None, top=10):
    ranked = ranking(game_id)
    out = {"top": [{"name": p["name"], "score": p["score"]} for p in ranked[:top]], "players": len(ranked)}
    for i, p in enumerate(ranked):
        if p["id"] == player_id:
            out["you"] = {"name": p["name"], "score": p["score"], "rank": i + 1}
    return out


@app.post("/api/quizzes/{quiz_id}/games")
async def start_game(quiz_id: str, request: Request):
    user = need_teacher(request)
    quiz = get_quiz(quiz_id, user)
    body = await body_of(request)
    mode = body.get("mode")
    if mode not in ("live", "async"):
        fail(400, "mode")
    return {"code": create_game(quiz, user["id"], mode, settings_from(body, mode))}


@app.post("/api/quizzes/{quiz_id}/practice")
async def practice(quiz_id: str, request: Request):
    """A private self-paced game with one player: the signed-in user."""
    user = need_user(request)
    quiz = get_quiz(quiz_id, user)
    settings = settings_from({"shuffle_questions": True, "shuffle_options": True}, "async")
    settings["practice"] = True
    code = create_game(quiz, user["id"], "async", settings)
    token = secrets.token_urlsafe(24)
    run("INSERT INTO players(game_id,name,user_id,token,joined) VALUES (?,?,?,?,?)",
        get_game(code)["id"], user["name"][:30], user["id"], token, time.time())
    return {"code": code, "token": token}


@app.get("/api/games")
async def my_games(request: Request):
    user = need_teacher(request)
    found = rows("SELECT g.*, (SELECT COUNT(*) FROM players p WHERE p.game_id = g.id AND p.kicked = 0) AS n "
                 "FROM games g WHERE g.host_id = ? AND g.settings NOT LIKE '%\"practice\": true%' "
                 "ORDER BY g.created DESC LIMIT 100", user["id"])
    return [{"code": g["code"], "title": g["title"], "mode": g["mode"], "created": g["created"],
             "status": g["status"] if game_open(g) else "ended", "players": g["n"]} for g in found]


@app.get("/api/games/{code}")
async def game_info(code: str, request: Request):
    game = get_game(code)
    user = current_user(request)
    settings = json.loads(game["settings"])
    return {"code": code, "title": game["title"], "mode": game["mode"],
            "status": game["status"] if game_open(game) else "ended",
            "count": len(json.loads(game["questions"])), "require_login": settings["require_login"],
            "deadline": settings["deadline"], "host": bool(user and user["id"] == game["host_id"])}


@app.post("/api/games/{code}/join")
async def join(code: str, request: Request):
    game = get_game(code)
    if not game_open(game):
        fail(410, "ended")
    user = current_user(request)
    settings = json.loads(game["settings"])
    if settings["require_login"] and not user:
        fail(401, "login_required")
    if user:
        mine = row("SELECT * FROM players WHERE game_id = ? AND user_id = ? AND kicked = 0", game["id"], user["id"])
        if mine:
            return {"token": mine["token"], "name": mine["name"]}
    body = await body_of(request)
    name = user["name"][:30] if settings["require_login"] else _text(body.get("name"), 30)
    if not name:
        fail(400, "nick")
    if row("SELECT COUNT(*) c FROM players WHERE game_id = ?", game["id"])["c"] >= MAX_PLAYERS:
        fail(409, "full")
    token = secrets.token_urlsafe(24)
    try:
        run("INSERT INTO players(game_id,name,user_id,token,joined) VALUES (?,?,?,?,?)",
            game["id"], name, user["id"] if user else None, token, time.time())
    except sqlite3.IntegrityError:
        fail(409, "taken")
    return {"token": token, "name": name}


def player_of(game, request):
    player = row("SELECT * FROM players WHERE game_id = ? AND token = ? AND kicked = 0",
                 game["id"], request.headers.get("x-player") or "")
    if not player:
        fail(401, "player")
    return player


def player_questions(game, player):
    """The game's questions in this player's own order (self-paced games shuffle per player)."""
    settings = json.loads(game["settings"])
    return shuffled(json.loads(game["questions"]), random.Random(f"{game['id']}:{player['id']}"),
                    settings["shuffle_questions"], settings["shuffle_options"])


@app.get("/api/play/{code}")
async def play_state(code: str, request: Request):
    """Self-paced play: the player's progress and their next question. Opening a question
    starts its clock, and reloading the page does not restart it."""
    game = get_game(code)
    player = player_of(game, request)
    settings = json.loads(game["settings"])
    out = {"title": game["title"], "mode": game["mode"], "name": player["name"], "score": player["score"],
           "timer": settings["timer"], "show_answers": settings["show_answers"], "deadline": settings["deadline"],
           "guard": guard.status(game, player)}
    # ?peek=1 asks who and what without opening a question (the anti-cheat notice is shown first).
    if game["mode"] != "async" or request.query_params.get("peek") or (out["guard"] and out["guard"]["locked"]):
        return out
    questions, order = player_questions(game, player)
    done = row("SELECT COUNT(*) c FROM answers WHERE player_id = ? AND answered IS NOT NULL", player["id"])["c"]
    out.update(total=len(questions), answered=done, finished=done >= len(questions) or not game_open(game))
    if out["finished"]:
        out["standing"] = standing(game["id"], player["id"])
        out["correct"] = row("SELECT COUNT(*) c FROM answers WHERE player_id = ? AND correct = 1", player["id"])["c"]
        return out
    q = questions[done]
    passage, first = passage_for(settings.get("passages", []), questions, done)
    opened = row("SELECT 1 FROM answers WHERE player_id = ? AND qi = ?", player["id"], order[done])
    if passage and first and not opened and request.query_params.get("start") != str(done):
        out["reading"] = {"k": done, **passage}  # read first; the question (and its clock) opens on ?start=k
        return out
    out["passage"] = passage
    run("INSERT OR IGNORE INTO answers(player_id, qi, served) VALUES (?,?,?)", player["id"], order[done], time.time())
    served = row("SELECT served FROM answers WHERE player_id = ? AND qi = ?", player["id"], order[done])["served"]
    out["question"] = {"k": done, **public_question(q)}
    out["ms_left"] = max(0, int((served + q["time"] - time.time()) * 1000)) if settings["timer"] else None
    return out


@app.post("/api/play/{code}/answer")
async def play_answer(code: str, request: Request):
    game = get_game(code)
    player = player_of(game, request)
    if game["mode"] != "async":
        fail(400, "mode")
    if not game_open(game):
        fail(410, "deadline")
    if guard.is_locked(game, player):
        fail(423, "locked")
    body = await body_of(request)
    settings = json.loads(game["settings"])
    questions, order = player_questions(game, player)
    done = row("SELECT COUNT(*) c FROM answers WHERE player_id = ? AND answered IS NOT NULL", player["id"])["c"]
    k, a = body.get("k"), body.get("answer")
    if k != done or done >= len(questions):
        fail(409, "order")
    q = questions[k]
    if a is not None and not valid_answer(q, a):
        fail(400, "answer")
    opened = row("SELECT served FROM answers WHERE player_id = ? AND qi = ?", player["id"], order[k])
    now = time.time()
    ms = int((now - (opened["served"] if opened else now)) * 1000)
    if settings["timer"] and ms > q["time"] * 1000 + 3000:
        a = None  # too late: recorded as unanswered
    correct = grade(q, a)
    points = points_for(q, correct, ms, settings["timer"])
    penalized = guard.zeroed(game, player["id"], order[k])  # left the page while this question was open
    if penalized:
        points = 0
    run("INSERT INTO answers(player_id,qi,served,answer,correct,points,ms,answered) VALUES (?,?,?,?,?,?,?,?) "
        "ON CONFLICT(player_id,qi) DO UPDATE SET answer=excluded.answer, correct=excluded.correct, "
        "points=excluded.points, ms=excluded.ms, answered=excluded.answered",
        player["id"], order[k], now, json.dumps(stored_answer(q, a)),
        None if correct is None else int(correct), points, ms, now)
    finished = done + 1 >= len(questions)
    run("UPDATE players SET score = score + ?, finished = ? WHERE id = ?", points, now if finished else None, player["id"])
    out = {"correct": correct, "points": points, "score": player["score"] + points, "finished": finished,
           "timed_out": a is None, "penalized": penalized}
    if settings["show_answers"]:
        out.update(answer=q.get("answer"), explanation=q["explanation"])
    return out


@app.get("/api/games/{code}/review")
async def review(code: str, request: Request):
    """A player's own answers next to the key, once they are done. Found by their player token, or by
    their account if they joined signed in (so it also opens later, from "My results")."""
    game = get_game(code)
    player = row("SELECT * FROM players WHERE game_id = ? AND token = ? AND kicked = 0", game["id"], request.headers.get("x-player") or "")
    user = current_user(request)
    if not player and user:
        player = row("SELECT * FROM players WHERE game_id = ? AND user_id = ? AND kicked = 0", game["id"], user["id"])
    if not player:
        fail(401, "player")
    settings = json.loads(game["settings"])
    if not settings["show_answers"]:
        fail(403, "review_off")
    if not player["finished"] and game_open(game):
        fail(409, "review_early")
    mine = {a["qi"]: a for a in rows("SELECT * FROM answers WHERE player_id = ? AND answered IS NOT NULL", player["id"])}
    out = []
    for i, q in enumerate(json.loads(game["questions"])):
        a = mine.get(i)
        out.append({**{k: v for k, v in q.items() if k not in ("perm", "criterion")}, "answered": bool(a),
                    "mine": json.loads(a["answer"]) if a and a["answer"] else None,
                    "correct": bool(a and a["correct"]), "points": a["points"] if a else 0})
    return {"title": game["title"], "name": player["name"], "score": player["score"],
            "passages": settings.get("passages", []), "questions": out}


@app.get("/api/games/{code}/leaderboard")
async def leaderboard(code: str, request: Request):
    game = get_game(code)
    player = row("SELECT id FROM players WHERE game_id = ? AND token = ?", game["id"], request.headers.get("x-player") or "")
    return standing(game["id"], player["id"] if player else None)


@app.post("/api/games/{code}/end")
async def end_game(code: str, request: Request):
    game = host_game(code, request)
    await live.end(game)
    return {"ok": True}


@app.delete("/api/games/{code}")
async def delete_game(code: str, request: Request):
    game = host_game(code, request)
    await live.end(game)
    run("DELETE FROM games WHERE id = ?", game["id"])
    return {"ok": True}


@app.get("/api/games/{code}/players")
async def game_players(code: str, request: Request):
    game = host_game(code, request)
    return [p["name"] for p in ranking(game["id"])]


def build_report(game):
    questions = json.loads(game["questions"])
    players = rows("SELECT p.*, u.name AS account, u.email FROM players p LEFT JOIN users u ON u.id = p.user_id "
                   "WHERE p.game_id = ? AND p.kicked = 0 ORDER BY p.score DESC, COALESCE(p.finished, p.joined), p.id", game["id"])
    stats = [{"answered": 0, "correct": 0, "ms": 0, "dist": {}} for _ in questions]
    per_player = {p["id"]: {"answered": 0, "correct": 0, "ms": 0, "marks": [None] * len(questions)} for p in players}
    for a in rows("SELECT a.* FROM answers a JOIN players p ON p.id = a.player_id "
                  "WHERE p.game_id = ? AND p.kicked = 0 AND a.answered IS NOT NULL", game["id"]):
        if a["qi"] >= len(questions):
            continue
        s, mine = stats[a["qi"]], per_player[a["player_id"]]
        value = json.loads(a["answer"]) if a["answer"] else None
        s["answered"] += 1
        mine["answered"] += 1
        s["ms"] += a["ms"] or 0
        mine["ms"] += a["ms"] or 0
        mine["marks"][a["qi"]] = a["correct"]
        if a["correct"]:
            s["correct"] += 1
            mine["correct"] += 1
        for key in (value if isinstance(value, list) else [value]):
            key = "-" if key is None else fold(key) if isinstance(key, str) else json.dumps(key)
            s["dist"][key] = s["dist"].get(key, 0) + 1
    flags = guard.report(game)
    return {"code": game["code"], "title": game["title"], "mode": game["mode"], "created": game["created"],
            "status": game["status"] if game_open(game) else "ended", "settings": json.loads(game["settings"]),
            "questions": [{**q, **stats[i]} for i, q in enumerate(questions)],
            "players": [{"name": p["name"], "account": p["account"], "email": p["email"], "score": p["score"],
                         "finished": p["finished"], "locked": bool(p["locked"]),
                         **{"exits": 0, "away": 0, "exit_questions": [], **flags.get(p["id"], {})},
                         **per_player[p["id"]]} for p in players]}


@app.get("/api/games/{code}/report")
async def report(code: str, request: Request):
    return build_report(host_game(code, request))


@app.get("/api/games/{code}/report.csv")
async def report_csv(code: str, request: Request):
    data = build_report(host_game(code, request))
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["rank", "name", "account", "email", "score", "correct", "answered", "questions", "finished",
                "left_page", "seconds_away"]
               + [f"Q{i + 1}" for i in range(len(data["questions"]))])
    for i, p in enumerate(data["players"]):
        # A leading =, +, - or @ would run as a formula when the sheet is opened.
        safe = [("'" + v) if isinstance(v, str) and v[:1] in "=+-@\t\r" else v
                for v in (p["name"], p["account"] or "", p["email"] or "")]
        w.writerow([i + 1, *safe, p["score"], p["correct"], p["answered"], len(data["questions"]),
                    time.strftime("%Y-%m-%d %H:%M", time.localtime(p["finished"])) if p["finished"] else "",
                    p["exits"], p["away"]]
                   + ["" if m is None else m for m in p["marks"]])
    return Response("﻿" + out.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="quiz-{code}.csv"'})


@app.get("/api/me/results")
async def my_results(request: Request):
    user = need_user(request)
    found = rows("SELECT p.id, p.score, p.finished, p.joined, g.id AS gid, g.code, g.title, g.mode, g.questions "
                 "FROM players p JOIN games g ON g.id = p.game_id WHERE p.user_id = ? AND p.kicked = 0 "
                 "ORDER BY p.joined DESC LIMIT 100", user["id"])
    out = []
    for r in found:
        tally = row("SELECT COUNT(*) n, COALESCE(SUM(correct = 1), 0) c FROM answers WHERE player_id = ? AND answered IS NOT NULL", r["id"])
        rank = next(i + 1 for i, p in enumerate(ranking(r["gid"])) if p["id"] == r["id"])
        out.append({"code": r["code"], "title": r["title"], "mode": r["mode"], "score": r["score"], "rank": rank,
                    "correct": tally["c"], "answered": tally["n"], "count": len(json.loads(r["questions"])),
                    "when": r["joined"]})
    return out


# --------------------------------------------------------------------------- wheels
def clean_wheel(body):
    title = _text(body.get("title"), 100)
    items = body.get("items")
    items = [x for x in (_text(i, 60) for i in items) if x] if isinstance(items, list) else []
    if not title or not 2 <= len(items) <= 200:
        fail(400, "wheel")
    return title, json.dumps(items, ensure_ascii=False)


def wheel_json(w):
    return {"id": w["id"], "title": w["title"], "items": json.loads(w["items"]), "updated": w["updated"]}


def _cell(value):
    text = _text(value, 60)
    return text[:-2] if re.fullmatch(r"-?\d+\.0", text) else text  # Excel stores 12 as 12.0


def sheet_rows(data):
    """First two columns of a CSV or .xlsx file, as rows of text. Raises ValueError if unreadable."""
    if data[:2] == b"PK":
        import zipfile
        from xml.etree import ElementTree as ET
        ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if sum(i.file_size for i in z.infolist()) > 30 * 1024 * 1024:
                raise ValueError("too large")
            sheets = sorted((n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)),
                            key=lambda n: int(re.findall(r"\d+", n)[-1]))
            if not sheets:
                raise ValueError("not a workbook")
            shared = []
            if "xl/sharedStrings.xml" in z.namelist():
                shared = ["".join(t.text or "" for t in si.iter(ns + "t"))
                          for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(ns + "si")]
            out = []
            for r in ET.fromstring(z.read(sheets[0])).iter(ns + "row"):
                cells = {}
                for c in r.iter(ns + "c"):
                    col = re.sub(r"\d", "", c.get("r") or "")
                    v = c.find(ns + "v")
                    if c.get("t") == "s" and v is not None:
                        value = shared[int(v.text)]
                    elif c.get("t") == "inlineStr":
                        value = "".join(t.text or "" for t in c.iter(ns + "t"))
                    else:
                        value = v.text if v is not None else ""
                    cells[col] = value
                if any(cells.values()):
                    out.append(cells)
            cols = sorted({c for row_ in out for c, v in row_.items() if v}, key=lambda c: (len(c), c))[:2]
            return [[_cell(row_.get(c)) for c in cols] for row_ in out]
    if b"\x00" in data[:2000]:
        raise ValueError("binary")  # e.g. the old .xls format
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", "replace")
    first = text.split("\n", 1)[0]
    delimiter = max(";\t,", key=first.count) if any(d in first for d in ";\t,") else ","
    return [[_cell(c) for c in r[:2]] for r in csv.reader(io.StringIO(text), delimiter=delimiter) if any(c.strip() for c in r)]


@app.post("/api/wheels/sheet")
async def wheel_sheet(request: Request):
    """Read a class list (column 1: number, column 2: name) for the wheel. No account needed;
    nothing is stored."""
    if not throttle(("sheet", client_ip(request)), 60, 600):
        fail(429, "slow")
    data = await request.body()
    if not data or len(data) > MAX_UPLOAD:
        fail(400, "sheet")
    try:
        found = await asyncio.to_thread(sheet_rows, data)
    except Exception:
        fail(400, "sheet")
    if found and len(found[0]) == 2 and (re.fullmatch(r"(no\.?|nomor|number|num|#|id|nim|absen|no\.? ?absen)", found[0][0], re.I)
                                         or re.match(r"(nama|name)\b", found[0][1], re.I)):
        found = found[1:]  # header row
    entries = []
    for r in found[:200]:
        if len(r) == 2 and r[0] and r[1]:
            entries.append({"number": r[0][:8], "name": r[1][:48]})
        elif any(r):
            entries.append({"number": "", "name": (r[1] if len(r) == 2 and r[1] else r[0])[:60]})
    if len(entries) < 2:
        fail(400, "sheet_empty")
    return {"entries": entries}


@app.get("/api/wheels")
async def wheels(request: Request):
    user = need_user(request)
    return [wheel_json(w) for w in rows("SELECT * FROM wheels WHERE owner_id = ? ORDER BY updated DESC", user["id"])]


@app.post("/api/wheels")
async def create_wheel(request: Request):
    user = need_user(request)
    title, items = clean_wheel(await body_of(request))
    if row("SELECT COUNT(*) c FROM wheels WHERE owner_id = ?", user["id"])["c"] >= 200:
        fail(400, "wheel")
    return {"id": run("INSERT INTO wheels(owner_id,title,items,updated) VALUES (?,?,?,?)",
                      user["id"], title, items, time.time()).lastrowid}


@app.put("/api/wheels/{wheel_id}")
async def update_wheel(wheel_id: int, request: Request):
    user = need_user(request)
    title, items = clean_wheel(await body_of(request))
    if not run("UPDATE wheels SET title=?, items=?, updated=? WHERE id=? AND owner_id=?",
               title, items, time.time(), wheel_id, user["id"]).rowcount:
        fail(404, "notfound")
    return {"id": wheel_id}


@app.delete("/api/wheels/{wheel_id}")
async def delete_wheel(wheel_id: int, request: Request):
    user = need_user(request)
    run("DELETE FROM wheels WHERE id = ? AND owner_id = ?", wheel_id, user["id"])
    return {"ok": True}


# --------------------------------------------------------------------------- live + pages
import brand  # noqa: E402
import admin  # noqa: E402,F401  (registers /api/admin/* and the password change)
import ai  # noqa: E402,F401  (registers /api/ai/*; needs the helpers above)
import live  # noqa: E402
import guard  # noqa: E402  (anti-cheat; needs live)


@app.websocket("/ws/{code}")
async def game_socket(ws: WebSocket, code: str):
    await live.serve(ws, code)


def import_seed():
    """Load the starter quizzes into the public library once (owner: nobody, read-only).
    QUIZ_SEED=off skips it; QUIZ_SEED_DIR points at a folder of a client's own quiz files."""
    if not SEED_ON or not SEED.is_dir():
        return
    for path in sorted(SEED.glob("*.json")):
        if row("SELECT 1 FROM quizzes WHERE seed = ?", path.stem):
            continue
        try:
            quiz = clean_quiz(json.loads(path.read_text(encoding="utf-8")))
        except (HTTPException, ValueError) as err:
            print(f"seed {path.name} skipped: {getattr(err, 'detail', err)}")
            continue
        quiz["public"] = 1
        insert_quiz(None, quiz, seed=path.stem)


import_seed()
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/{path:path}")
async def spa(path: str):
    if path.startswith(("api/", "ws/", "static/", "uploads/", "brand/")):
        raise HTTPException(404)
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
