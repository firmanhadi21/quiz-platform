"""Anti-cheat mode: notice when a player leaves the quiz page, record it, and apply the teacher's penalty.

A web page cannot stop anyone switching tabs or apps, but it knows when it is hidden or loses
focus. The player's page reports "away" and "back"; the server keeps the record, so reloading
does not erase it. An absence shorter than GRACE seconds (a notification, a slip of the thumb)
is kept in the log but not counted.

Game settings:  anticheat  on/off
                penalty    "record"  only log and show the teacher
                           "zero"    no points for the question that was open
                           "lock"    after `lock_after` counted exits the player cannot answer
                                     until the teacher lets them back in
"""
import json
import time

from fastapi import Request

import live
import main as m

GRACE = 2.0
PENALTIES = ("record", "zero", "lock")

m._db.executescript("""
CREATE TABLE IF NOT EXISTS exits(
  id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  qi INTEGER, kind TEXT NOT NULL, at REAL NOT NULL, ms INTEGER);
CREATE INDEX IF NOT EXISTS exits_player ON exits(player_id);
""")
_columns = {c["name"] for c in m._db.execute("PRAGMA table_info(players)")}
if "locked" not in _columns:
    m._db.execute("ALTER TABLE players ADD COLUMN locked INTEGER NOT NULL DEFAULT 0")
if "exit_base" not in _columns:
    m._db.execute("ALTER TABLE players ADD COLUMN exit_base INTEGER NOT NULL DEFAULT 0")

m.MSG.update({
    "locked": ("Anda terkunci karena meninggalkan halaman kuis. Minta guru membuka kunci.",
               "You are locked out for leaving the quiz page. Ask the teacher to let you back in."),
})

# An exit counts once it lasted GRACE seconds, or is still going on after that long.
COUNTED = "(ms >= {g} OR (ms IS NULL AND at < {{now}} - {s}))".format(g=int(GRACE * 1000), s=GRACE)


def rules(game):
    settings = json.loads(game["settings"])
    return settings if settings.get("anticheat") else None


def settings_from(body):
    penalty = body.get("penalty") if body.get("penalty") in PENALTIES else "record"
    return {"anticheat": bool(body.get("anticheat")), "penalty": penalty,
            "lock_after": m._int(body.get("lock_after"), 1, 10, 3)}


def counted(player_id, qi=None):
    sql = "SELECT COUNT(*) c FROM exits WHERE player_id = ? AND " + COUNTED.format(now=time.time())
    return m.row(sql + (" AND qi = ?" if qi is not None else ""), *([player_id] if qi is None else [player_id, qi]))["c"]


def status(game, player):
    """Counted exits and whether the player is locked out (locking them if they just crossed the line)."""
    r = rules(game)
    if not r:
        return None
    n = counted(player["id"])
    player = m.row("SELECT * FROM players WHERE id = ?", player["id"])  # fresh: a live socket holds an old copy
    locked = bool(player["locked"])
    if r["penalty"] == "lock" and not locked and n - player["exit_base"] >= r["lock_after"]:
        m.run("UPDATE players SET locked = 1 WHERE id = ?", player["id"])
        locked = True
    return {"on": True, "penalty": r["penalty"], "lock_after": r["lock_after"], "exits": n, "locked": locked}


def is_locked(game, player):
    s = status(game, player)
    return bool(s and s["locked"])


def zeroed(game, player_id, qi):
    """True if this question earns nothing because the player left the page while it was open."""
    r = rules(game)
    return bool(r and r["penalty"] == "zero" and counted(player_id, qi))


def open_question(game, player):
    """The question the player has in front of them and has not answered, or None."""
    if game["mode"] == "async":
        q = m.row("SELECT qi FROM answers WHERE player_id = ? AND answered IS NULL", player["id"])
        return q["qi"] if q else None
    g = live.games.get(game["id"])
    if not g or g.phase != "question":
        return None
    done = m.row("SELECT 1 FROM answers WHERE player_id = ? AND qi = ? AND answered IS NOT NULL", player["id"], g.qi)
    return None if done else g.qi


def watching(game, player):
    """Exits only matter while the player is actually taking the quiz (not in the lobby, not after)."""
    if not rules(game) or not m.game_open(game) or player["finished"]:
        return False
    return game["mode"] == "async" or game["status"] == "running"


async def tell_host(game, player, away):
    if game["mode"] == "live" and game["id"] in live.games:
        s = status(game, player)
        await live.games[game["id"]].send(live.games[game["id"]].hosts, {
            "t": "flag", "name": player["name"], "exits": s["exits"], "locked": s["locked"], "away": away})


@m.app.post("/api/play/{code}/away")
async def away(code: str, request: Request):
    game = m.get_game(code)
    player = m.player_of(game, request)
    if not watching(game, player) or not m.throttle(("away", player["id"]), 200, 600):
        return {"ignored": True}
    if not m.row("SELECT 1 FROM exits WHERE player_id = ? AND ms IS NULL", player["id"]):
        body = await m.body_of(request)
        kind = body.get("kind") if body.get("kind") in ("hidden", "blur", "fullscreen") else "hidden"
        m.run("INSERT INTO exits(player_id, qi, kind, at) VALUES (?,?,?,?)", player["id"], open_question(game, player), kind, time.time())
        await tell_host(game, player, True)
    return {"ok": True}


@m.app.post("/api/play/{code}/back")
async def back(code: str, request: Request):
    game = m.get_game(code)
    player = m.player_of(game, request)
    if not rules(game):
        return {"ignored": True}
    body = await m.body_of(request)
    # The phone may only get the "away" request out once it is back in front; trust its own
    # stopwatch when that is longer than ours, never when it is shorter.
    claimed = m._int(body.get("ms"), 0, 6 * 3600 * 1000, 0)
    now = time.time()
    last = m.row("SELECT * FROM exits WHERE player_id = ? AND ms IS NULL ORDER BY id DESC", player["id"])
    if last:
        ms = max(int((now - last["at"]) * 1000), claimed)
        m.run("UPDATE exits SET ms = ?, at = ? WHERE id = ?", ms, now - ms / 1000, last["id"])
        qi = last["qi"]
    elif claimed and watching(game, player):
        ms, qi = claimed, open_question(game, player)
        m.run("INSERT INTO exits(player_id, qi, kind, at, ms) VALUES (?,?,?,?,?)", player["id"], qi, "hidden", now - ms / 1000, ms)
    else:
        return {"ignored": True}
    s = status(game, player)
    await tell_host(game, player, False)
    was_counted = ms >= GRACE * 1000
    return {**s, "counted": was_counted, "zeroed": was_counted and s["penalty"] == "zero" and qi is not None}


@m.app.post("/api/games/{code}/unlock")
async def unlock(code: str, request: Request):
    """Teacher lets a locked-out player back in; the count towards the next lock starts again."""
    game = m.host_game(code, request)
    body = await m.body_of(request)
    player = m.row("SELECT * FROM players WHERE game_id = ? AND name = ? AND kicked = 0", game["id"], str(body.get("name") or ""))
    if not player:
        m.fail(404, "notfound")
    m.run("UPDATE players SET locked = 0, exit_base = ? WHERE id = ?", counted(player["id"]), player["id"])
    return {"ok": True}


def report(game):
    """Per player id: counted exits, total seconds away, lock state, and which questions were open."""
    out = {}
    if not rules(game):
        return out
    found = m.rows("SELECT e.*, p.locked FROM exits e JOIN players p ON p.id = e.player_id WHERE p.game_id = ? AND "
                   + COUNTED.format(now=time.time()), game["id"])
    for e in found:
        mine = out.setdefault(e["player_id"], {"exits": 0, "away": 0, "exit_questions": []})
        mine["exits"] += 1
        mine["away"] += round((e["ms"] if e["ms"] is not None else (time.time() - e["at"]) * 1000) / 1000)
        if e["qi"] is not None and e["qi"] + 1 not in mine["exit_questions"]:
            mine["exit_questions"].append(e["qi"] + 1)
    return out
