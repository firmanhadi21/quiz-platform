"""Smoke test against a deployed site: real AI call, and a live game through the proxy.

    .venv/bin/python tests/live_smoke.py https://quiz.example.org

Creates the account smoke-<time>@example.org; remove it afterwards with
    docker compose exec quiz python manage.py delete smoke-...@example.org
"""
import asyncio
import json
import sys
import time

import httpx
import websockets

BASE = sys.argv[1].rstrip("/")
H = {"X-Quiz": "1", "X-Lang": "en"}
MATERIAL = """Penginderaan jauh adalah ilmu dan seni memperoleh informasi tentang objek, daerah, atau fenomena
melalui analisis data yang diperoleh dengan alat tanpa kontak langsung dengan objek tersebut. Sensor pasif
merekam energi matahari yang dipantulkan atau energi yang dipancarkan objek, sedangkan sensor aktif seperti
radar dan LiDAR memancarkan energinya sendiri sehingga dapat merekam pada malam hari. Resolusi spasial
menyatakan ukuran objek terkecil yang dapat dibedakan, resolusi spektral menyatakan jumlah dan lebar saluran
panjang gelombang, resolusi temporal menyatakan selang waktu perekaman ulang, dan resolusi radiometrik
menyatakan kepekaan sensor terhadap perbedaan kekuatan sinyal. Vegetasi sehat memantulkan kuat pada
inframerah dekat dan menyerap pada saluran merah; perbedaan ini menjadi dasar indeks NDVI, yang dihitung
sebagai (NIR - Red) / (NIR + Red) dan bernilai antara -1 dan 1. Landsat 8 memiliki resolusi spasial 30 meter
untuk saluran multispektral dan merekam ulang setiap 16 hari, sedangkan Sentinel-2 memiliki resolusi 10 meter
pada saluran tampak dan inframerah dekat dengan waktu kunjung ulang 5 hari untuk dua satelitnya."""

RUBRIC = """Rubrik penilaian kuis Penginderaan Jauh
Kriteria 1: Membedakan sensor aktif dan pasif (bobot 20%) - memahami
Kriteria 2: Menjelaskan empat jenis resolusi citra (bobot 40%) - memahami
Kriteria 3: Menghitung dan menafsirkan NDVI (bobot 20%) - menerapkan
Kriteria 4: Membandingkan Landsat 8 dan Sentinel-2 (bobot 20%) - menganalisis
Kriteria 5: Mempresentasikan hasil klasifikasi di depan kelas (dinilai lewat presentasi)"""


async def until(ws, kind):
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), 20))
        if msg["t"] == kind:
            return msg


async def main():
    email = f"smoke-{int(time.time())}@example.org"
    async with httpx.AsyncClient(base_url=BASE, headers=H, timeout=300) as c:
        r = await c.post("/api/auth/register", json={"email": email, "name": "Smoke Test", "password": "smoke-" + str(time.time())})
        r.raise_for_status()
        print("account", email, "| ai enabled:", (await c.get("/api/me")).json()["ai"])

        t0 = time.time()
        r = await c.post("/api/ai/generate", json={"material": MATERIAL, "count": 6, "level": "medium", "language": "id",
                                                    "types": ["single", "tf", "multi", "text"]})
        print(f"ai: HTTP {r.status_code} in {time.time() - t0:.0f}s")
        r.raise_for_status()
        ai = r.json()
        print(f"ai title: {ai['title']!r}; {len(ai['questions'])} questions, {ai['skipped']} skipped")
        for q in ai["questions"]:
            key = q["answer"] if "options" not in q else [q["options"][a] for a in (q["answer"] if isinstance(q["answer"], list) else [q["answer"]])]
            print(f"  [{q['type']}] {q['text']}  ->  {key}")
        assert len(ai["questions"]) >= 5

        r = await c.post("/api/ai/generate", json={"material": MATERIAL, "rubric": RUBRIC, "count": 10, "level": "medium",
                                                    "language": "id", "types": ["single", "tf"]})
        r.raise_for_status()
        with_rubric = r.json()
        tally = {}
        for q in with_rubric["questions"]:
            tally[q["criterion"]] = tally.get(q["criterion"], 0) + 1
        print(f"rubric: {len(with_rubric['questions'])} questions over {len(with_rubric['criteria'])} criteria")
        for name, n in tally.items():
            print(f"  {n} x {name!r}")
        assert all(q["criterion"] for q in with_rubric["questions"]) and len(with_rubric["criteria"]) >= 3

        quiz = (await c.post("/api/quizzes", json={"title": ai["title"] or "Smoke", "questions": ai["questions"][:2]})).json()["id"]
        code = (await c.post(f"/api/quizzes/{quiz}/games", json={"mode": "live"})).json()["code"]
        token = (await httpx.AsyncClient(base_url=BASE, headers=H).post(f"/api/games/{code}/join", json={"name": "Robot"})).json()["token"]
        wsbase = BASE.replace("http", "ws", 1)
        cookie = "; ".join(f"{k}={v}" for k, v in c.cookies.items())
        async with websockets.connect(f"{wsbase}/ws/{code}?role=host", additional_headers={"Cookie": cookie}) as host, \
                websockets.connect(f"{wsbase}/ws/{code}?player={token}") as player:
            assert (await until(host, "lobby"))["count"] == 1
            await host.send(json.dumps({"t": "next"}))
            q = await until(player, "question")
            assert "answer" not in q["q"]
            answer = {"single": 0, "multi": [0], "tf": True, "text": "x"}[q["q"]["type"]]
            await player.send(json.dumps({"t": "answer", "qi": 0, "answer": answer}))
            reveal = await until(player, "reveal")
            print("live: question -> answer -> reveal over wss ok; correct =", reveal["you"]["correct"])
            await host.send(json.dumps({"t": "end"}))
            assert (await until(player, "ended"))["you"]["name"] == "Robot"
        rep = (await c.get(f"/api/games/{code}/report")).json()
        assert rep["status"] == "ended" and rep["players"][0]["name"] == "Robot"
        print("report ok; game", code, "quiz", quiz)
        await c.delete(f"/api/games/{code}")
        await c.delete(f"/api/quizzes/{quiz}")
    print("SMOKE PASS", email)


asyncio.run(main())
