"""Check a fresh install end to end through its HTTPS proxy: sign-in, branding, quiz, live game.

    python tests/install_check.py https://quiz.example.org admin@example.org PASSWORD [--insecure]

--insecure accepts a self-signed certificate (Caddy's local one for DOMAIN=localhost).
Leaves one quiz and one finished game behind, both named "Install check".
"""
import asyncio
import json
import ssl
import sys

import httpx
import websockets

BASE, EMAIL, PW = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
VERIFY = "--insecure" not in sys.argv
H = {"X-Quiz": "1", "X-Lang": "en"}


async def until(ws, kind):
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), 20))
        if msg["t"] == kind:
            return msg


async def main():
    async with httpx.AsyncClient(base_url=BASE, headers=H, verify=VERIFY, timeout=30) as c:
        r = await c.get("/")
        assert r.status_code == 200 and "<title>" in r.text, r.status_code
        print("page over HTTPS:", r.http_version, r.status_code)
        me = (await c.post("/api/auth/login", json={"email": EMAIL, "password": PW})).json()
        assert me["role"] == "admin", me
        site = (await c.get("/api/me")).json()
        print("signed in as admin; site:", site["site"]["name"], "| AI:", site["ai"], "| registration:", site["registration"])
        css = await c.get("/brand.css")
        assert "--teal:" in css.text
        quiz = {"title": "Install check", "questions": [{"type": "tf", "text": "Is the install working?", "answer": True}]}
        qid = (await c.post("/api/quizzes", json=quiz)).json()["id"]
        code = (await c.post(f"/api/quizzes/{qid}/games", json={"mode": "live"})).json()["code"]
        async with httpx.AsyncClient(base_url=BASE, headers=H, verify=VERIFY) as p:
            token = (await p.post(f"/api/games/{code}/join", json={"name": "Robot"})).json()["token"]
        ws_base = BASE.replace("https://", "wss://").replace("http://", "ws://")
        tls = None
        if ws_base.startswith("wss://"):
            tls = ssl.create_default_context()
            if not VERIFY:
                tls.check_hostname, tls.verify_mode = False, ssl.CERT_NONE
        cookie = "; ".join(f"{k}={v}" for k, v in c.cookies.items())
        async with websockets.connect(f"{ws_base}/ws/{code}?role=host", additional_headers={"Cookie": cookie}, ssl=tls) as host, \
                websockets.connect(f"{ws_base}/ws/{code}?player={token}", ssl=tls) as player:
            await until(host, "lobby")
            await host.send(json.dumps({"t": "next"}))
            await until(player, "question")
            await player.send(json.dumps({"t": "answer", "qi": 0, "answer": True}))
            reveal = await until(player, "reveal")
            await host.send(json.dumps({"t": "end"}))
            await until(player, "ended")
        assert reveal["you"]["correct"] == 1
        print(f"live game {code} over WebSocket through the proxy: answered and scored {reveal['you']['points']}")
    print("INSTALL CHECK PASS")


asyncio.run(main())
