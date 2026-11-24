"""Live (teacher-paced) games over WebSocket.

Phases: lobby -> question -> reveal -> question ... -> ended. The host moves the game on;
a question also closes by itself when its time is up or everyone connected has answered.

Host sends:    {t: "next"} | {t: "reveal"} | {t: "end"} | {t: "kick", name}
Player sends:  {t: "answer", qi, answer}
Server sends:  hello, lobby, question, progress, answered, reveal, ended, kicked, error
"""
import asyncio
import json
import time
from urllib.parse import urlparse

from fastapi import WebSocket, WebSocketDisconnect

import main as m

GRACE = 1.5  # seconds of network slack after the clock runs out
games = {}   # game id -> Live


class Live:
    def __init__(self, game):
        self.id = game["id"]
        self.code = game["code"]
        self.title = game["title"]
        self.questions = json.loads(game["questions"])
        state = json.loads(game["state"])
        self.qi = state.get("qi", -1)
        # A restart mid-question cannot resume the clock, so that question is closed.
        self.phase = "reveal" if game["status"] == "running" and self.qi >= 0 else "lobby"
        self.passages = json.loads(game["settings"]).get("passages", [])
        self.game = game
        self.started = 0.0
        self.timer = None
        self.hosts = set()
        self.players = {}  # player id -> set of sockets

    # ---- sending
    async def send(self, sockets, message):
        text = json.dumps(message, ensure_ascii=False)
        for ws in list(sockets):
            try:
                await ws.send_text(text)
            except Exception:
                pass  # the reader loop notices the closed socket and cleans up

    def everyone(self):
        return set(self.hosts).union(*self.players.values()) if self.players else set(self.hosts)

    def save(self, status):
        m.run("UPDATE games SET status = ?, state = ?, ended = ? WHERE id = ?", status,
              json.dumps({"qi": self.qi}), time.time() if status == "ended" else None, self.id)

    def names(self):
        return [p["name"] for p in m.rows("SELECT name FROM players WHERE game_id = ? AND kicked = 0 ORDER BY id", self.id)]

    def answered(self):
        return m.row("SELECT COUNT(*) c FROM answers a JOIN players p ON p.id = a.player_id "
                     "WHERE p.game_id = ? AND p.kicked = 0 AND a.qi = ? AND a.answered IS NOT NULL", self.id, self.qi)["c"]

    # ---- messages for the current phase
    def lobby_msg(self):
        names = self.names()
        return {"t": "lobby", "players": names, "count": len(names)}

    def question_msg(self):
        q = self.questions[self.qi]
        left = max(0, int((self.started + q["time"] - time.monotonic()) * 1000))
        return {"t": "question", "qi": self.qi, "total": len(self.questions), "q": m.public_question(q), "ms_left": left,
                "passage": m.passage_for(self.passages, self.questions, self.qi)[0]}

    def reading_msg(self):
        return {"t": "reading", "qi": self.qi + 1, "total": len(self.questions),
                "passage": m.passage_for(self.passages, self.questions, self.qi + 1)[0]}

    def progress_msg(self):
        return {"t": "progress", "answered": self.answered(), "players": len(self.names())}

    def reveal_msg(self, player_id=None):
        q = self.questions[self.qi]
        msg = {"t": "reveal", "qi": self.qi, "total": len(self.questions), "q": m.public_question(q),
               "answer": q.get("answer"), "explanation": q["explanation"], "last": self.qi + 1 >= len(self.questions),
               "passage": m.passage_for(self.passages, self.questions, self.qi)[0]}
        if player_id is None:  # host: how the class answered
            dist, correct, n = {}, 0, 0
            for a in m.rows("SELECT a.answer, a.correct FROM answers a JOIN players p ON p.id = a.player_id "
                            "WHERE p.game_id = ? AND p.kicked = 0 AND a.qi = ? AND a.answered IS NOT NULL", self.id, self.qi):
                n += 1
                correct += a["correct"] == 1
                value = json.loads(a["answer"])
                for key in (value if isinstance(value, list) else [value]):
                    key = m.fold(key) if isinstance(key, str) else json.dumps(key)
                    dist[key] = dist.get(key, 0) + 1
            msg.update(dist=dist, answered=n, correct=correct, **m.standing(self.id, top=5))
        else:
            mine = m.row("SELECT answer, correct, points FROM answers WHERE player_id = ? AND qi = ? AND answered IS NOT NULL",
                         player_id, self.qi)
            msg["you"] = {**m.standing(self.id, player_id, top=0).get("you", {}),
                          "answered": bool(mine), "correct": mine["correct"] if mine else 0,
                          "points": mine["points"] if mine else 0,
                          "answer": json.loads(mine["answer"]) if mine else None}
        return msg

    def ended_msg(self, player_id=None):
        return {"t": "ended", **m.standing(self.id, player_id)}

    def current_msg(self, player_id=None):
        if self.phase == "lobby":
            return self.lobby_msg()
        if self.phase == "reading":
            return self.reading_msg()
        if self.phase == "question":
            msg = self.question_msg()
            if player_id is not None:
                msg["done"] = bool(m.row("SELECT 1 FROM answers WHERE player_id = ? AND qi = ? AND answered IS NOT NULL",
                                         player_id, self.qi))
            return msg
        return self.reveal_msg(player_id)

    # ---- transitions
    async def next(self):
        if self.phase == "question":
            return
        if self.qi + 1 >= len(self.questions):
            return await self.finish()
        passage, first = m.passage_for(self.passages, self.questions, self.qi + 1)
        if passage and first and self.phase != "reading":  # show the passage; the host starts the questions
            self.phase = "reading"
            self.save("running")
            return await self.send(self.everyone(), self.reading_msg())
        self.qi += 1
        self.phase = "question"
        self.started = time.monotonic()
        self.save("running")
        await self.send(self.everyone(), self.question_msg())
        await self.send(self.hosts, self.progress_msg())
        self.timer = asyncio.create_task(self.timeout(self.qi, self.questions[self.qi]["time"]))

    async def timeout(self, qi, seconds):
        await asyncio.sleep(seconds + 0.3)
        if self.phase == "question" and self.qi == qi:
            self.timer = None
            await self.reveal()

    async def reveal(self):
        if self.phase != "question":
            return
        self.phase = "reveal"
        if self.timer:
            self.timer.cancel()
            self.timer = None
        await self.send(self.hosts, self.reveal_msg())
        for player_id, sockets in list(self.players.items()):
            await self.send(sockets, self.reveal_msg(player_id))

    async def finish(self):
        self.phase = "ended"
        if self.timer:
            self.timer.cancel()
        self.save("ended")
        m.run("UPDATE players SET finished = ? WHERE game_id = ? AND finished IS NULL", time.time(), self.id)
        await self.send(self.hosts, self.ended_msg())
        for player_id, sockets in list(self.players.items()):
            await self.send(sockets, self.ended_msg(player_id))
        games.pop(self.id, None)

    async def answer(self, player, msg):
        if self.phase != "question" or msg.get("qi") != self.qi:
            return
        q = self.questions[self.qi]
        a = msg.get("answer")
        ms = int((time.monotonic() - self.started) * 1000)
        if not m.valid_answer(q, a) or ms > (q["time"] + GRACE) * 1000:
            return
        if m.guard.is_locked(self.game, player):
            return  # locked out for leaving the page
        correct = m.grade(q, a)
        points = m.points_for(q, correct, ms)
        if m.guard.zeroed(self.game, player["id"], self.qi):
            points = 0
        done = m.run("INSERT OR IGNORE INTO answers(player_id,qi,served,answer,correct,points,ms,answered) "
                     "VALUES (?,?,?,?,?,?,?,?)", player["id"], self.qi, time.time(), json.dumps(a),
                     None if correct is None else int(correct), points, ms, time.time())
        if not done.rowcount:
            return  # second answer to the same question
        m.run("UPDATE players SET score = score + ? WHERE id = ?", points, player["id"])
        await self.send(self.players.get(player["id"], ()), {"t": "answered", "qi": self.qi})
        await self.send(self.hosts, self.progress_msg())
        waiting = [pid for pid in self.players if not m.row(
            "SELECT 1 FROM answers WHERE player_id = ? AND qi = ? AND answered IS NOT NULL", pid, self.qi)]
        if not waiting:
            await self.reveal()

    async def kick(self, name):
        player = m.row("SELECT id FROM players WHERE game_id = ? AND name = ? AND kicked = 0", self.id, str(name))
        if not player:
            return
        m.run("UPDATE players SET kicked = 1, name = name || ' #' || id WHERE id = ?", player["id"])
        for ws in list(self.players.pop(player["id"], ())):
            await self.send([ws], {"t": "kicked"})
            await ws.close()
        if self.phase == "lobby":
            await self.send(self.everyone(), self.lobby_msg())


def get(game):
    if game["id"] not in games:
        games[game["id"]] = Live(game)
    return games[game["id"]]


async def end(game):
    """End a game from the REST side (host pressed End, or deleted it)."""
    if game["mode"] == "live" and game["status"] != "ended":
        await get(game).finish()
    elif game["status"] != "ended":
        m.run("UPDATE games SET status = 'ended', ended = ? WHERE id = ?", time.time(), game["id"])


def same_origin(ws):
    origin = ws.headers.get("origin")
    return not origin or urlparse(origin).netloc == ws.headers.get("host")


async def serve(ws: WebSocket, code):
    game = m.row("SELECT * FROM games WHERE code = ? AND mode = 'live'", code)
    if not game or not same_origin(ws):
        return await ws.close(code=4404)
    player = None
    if ws.query_params.get("role") == "host":
        user = m.user_from_token(ws.cookies.get("qsid"))
        if not user or user["id"] != game["host_id"]:
            return await ws.close(code=4403)
    else:
        player = m.row("SELECT * FROM players WHERE game_id = ? AND token = ? AND kicked = 0",
                       game["id"], ws.query_params.get("player") or "")
        if not player:
            return await ws.close(code=4401)
    await ws.accept()
    hello = {"t": "hello", "code": code, "title": game["title"], "total": len(json.loads(game["questions"])),
             "name": player["name"] if player else None}
    if game["status"] == "ended":
        await ws.send_text(json.dumps(hello))
        await ws.send_text(json.dumps({"t": "ended", **m.standing(game["id"], player["id"] if player else None)}))
        return await ws.close()

    g = get(game)
    if player:
        g.players.setdefault(player["id"], set()).add(ws)
    else:
        g.hosts.add(ws)
    try:
        await g.send([ws], hello)
        await g.send([ws], g.current_msg(player["id"] if player else None))
        if g.phase == "lobby":
            await g.send(g.everyone() - {ws}, g.lobby_msg())
        elif not player and g.phase == "question":
            await g.send([ws], g.progress_msg())
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except ValueError:
                continue
            kind = msg.get("t") if isinstance(msg, dict) else None
            if player and kind == "answer":
                await g.answer(player, msg)
            elif not player and kind == "next":
                await g.next()
            elif not player and kind == "reveal":
                await g.reveal()
            elif not player and kind == "end":
                await g.finish()
            elif not player and kind == "kick":
                await g.kick(msg.get("name"))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        g.hosts.discard(ws)
        if player and player["id"] in g.players:
            g.players[player["id"]].discard(ws)
            if not g.players[player["id"]]:
                del g.players[player["id"]]
