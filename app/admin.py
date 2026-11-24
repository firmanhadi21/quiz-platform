"""Accounts and privileges.

Roles:  student  joins games, practises public quizzes, sees their own results
        teacher  + writes quizzes, hosts games, uses the AI writer, reads reports
        admin    + manages accounts (role, disable, reset password, delete) and site settings

New accounts get the role in the `default_role` setting (student unless an admin changes it).
The first admin is made on the server:  docker exec -it quiz-app python manage.py create ...
"""
import asyncio
import secrets
import time

from fastapi import Request

import main as m

m.MSG.update({
    "role": ("Peran tidak dikenal.", "Unknown role."),
    "self": ("Anda tidak bisa mengubah peran, menonaktifkan, atau menghapus akun Anda sendiri.", "You cannot change the role of, disable or delete your own account."),
    "pw_wrong": ("Kata sandi saat ini salah.", "The current password is wrong."),
})


def user_row(u):
    return {"id": u["id"], "name": u["name"], "email": u["email"], "role": u["role"], "disabled": bool(u["disabled"]),
            "created": u["created"], "quizzes": u["quizzes"], "games": u["games"], "plays": u["plays"]}


def target(user_id, admin):
    user = m.row("SELECT * FROM users WHERE id = ?", user_id)
    if not user:
        m.fail(404, "notfound")
    if user["id"] == admin["id"]:
        m.fail(400, "self")  # so the site can never be left without an admin
    return user


@m.app.get("/api/admin/users")
async def list_users(request: Request, q: str = ""):
    m.need_admin(request)
    like = f"%{q.strip()[:60]}%"
    found = m.rows(
        "SELECT u.*, (SELECT COUNT(*) FROM quizzes z WHERE z.owner_id = u.id) AS quizzes, "
        "(SELECT COUNT(*) FROM games g WHERE g.host_id = u.id AND g.settings NOT LIKE '%\"practice\": true%') AS games, "
        "(SELECT COUNT(*) FROM players p WHERE p.user_id = u.id) AS plays "
        "FROM users u WHERE u.name LIKE ? OR u.email LIKE ? ORDER BY u.created DESC LIMIT 500", like, like)
    counts = {r["role"]: r["n"] for r in m.rows("SELECT role, COUNT(*) n FROM users GROUP BY role")}
    return {"users": [user_row(u) for u in found],
            "totals": {"users": sum(counts.values()), **{role: counts.get(role, 0) for role in m.ROLES},
                       "quizzes": m.row("SELECT COUNT(*) n FROM quizzes")["n"], "games": m.row("SELECT COUNT(*) n FROM games")["n"]},
            "settings": m.site_settings(), "site": m.brand.site()}


@m.app.post("/api/admin/users")
async def create_user(request: Request):
    """Make an account for someone. Returns a one-time password to hand to them."""
    m.need_admin(request)
    body = await m.body_of(request)
    email, name = m.valid_identity(body)
    role = body.get("role")
    if role not in m.ROLES:
        m.fail(400, "role")
    if m.row("SELECT 1 FROM users WHERE email = ?", email):
        m.fail(409, "exists")
    password = secrets.token_urlsafe(9)
    pw = await asyncio.to_thread(m.hash_password, password)
    uid = m.run("INSERT INTO users(email,name,pw,created,role) VALUES (?,?,?,?,?)", email, name, pw, time.time(), role).lastrowid
    return {"id": uid, "password": password}


@m.app.patch("/api/admin/users/{user_id}")
async def change_user(user_id: int, request: Request):
    admin = m.need_admin(request)
    user = target(user_id, admin)
    body = await m.body_of(request)
    if "role" in body:
        if body["role"] not in m.ROLES:
            m.fail(400, "role")
        m.run("UPDATE users SET role = ? WHERE id = ?", body["role"], user["id"])
    if "disabled" in body:
        m.run("UPDATE users SET disabled = ? WHERE id = ?", int(bool(body["disabled"])), user["id"])
        if body["disabled"]:
            m.run("DELETE FROM sessions WHERE user_id = ?", user["id"])
    return {"ok": True}


@m.app.post("/api/admin/users/{user_id}/reset-password")
async def reset_password(user_id: int, request: Request):
    admin = m.need_admin(request)
    user = target(user_id, admin)
    password = secrets.token_urlsafe(9)
    m.run("UPDATE users SET pw = ? WHERE id = ?", await asyncio.to_thread(m.hash_password, password), user["id"])
    m.run("DELETE FROM sessions WHERE user_id = ?", user["id"])
    return {"password": password}


@m.app.delete("/api/admin/users/{user_id}")
async def delete_user(user_id: int, request: Request):
    admin = m.need_admin(request)
    user = target(user_id, admin)
    m.run("DELETE FROM users WHERE id = ?", user["id"])  # cascades to their quizzes, games and wheels
    return {"ok": True}


@m.app.put("/api/admin/settings")
async def save_settings(request: Request):
    m.need_admin(request)
    body = await m.body_of(request)
    if "registration" in body:
        m.set_setting("registration", "open" if body["registration"] else "closed")
    if "default_role" in body:
        if body["default_role"] not in ("student", "teacher"):
            m.fail(400, "role")
        m.set_setting("default_role", body["default_role"])
    m.brand.save(body)
    return {**m.site_settings(), "site": m.brand.site()}


@m.app.post("/api/auth/password")
async def change_password(request: Request):
    """Signed-in users change their own password; every other session of theirs is signed out."""
    user = m.need_user(request)
    body = await m.body_of(request)
    new = str(body.get("new") or "")
    if not m.throttle(("pw", user["id"]), 10, 900):
        m.fail(429, "slow")
    if not await asyncio.to_thread(m.check_password, str(body.get("current") or "")[:200], user["pw"]):
        m.fail(400, "pw_wrong")
    if not 8 <= len(new) <= 200:
        m.fail(400, "pw")
    m.run("UPDATE users SET pw = ? WHERE id = ?", await asyncio.to_thread(m.hash_password, new), user["id"])
    m.run("DELETE FROM sessions WHERE user_id = ? AND token != ?", user["id"], m._token_hash(request.cookies.get("qsid") or ""))
    return {"ok": True}
