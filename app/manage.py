"""Admin chores, run inside the container (from the deploy/ folder):

    docker compose exec quiz python manage.py users
    docker compose exec quiz python manage.py create someone@example.org "Full Name" admin   (or teacher, student)
    docker compose exec quiz python manage.py role someone@example.org teacher
    docker compose exec quiz python manage.py reset-password someone@example.org
    docker compose exec quiz python manage.py disable someone@example.org     (or: enable)
    docker compose exec quiz python manage.py delete someone@example.org      (account + all its data)
    docker compose exec quiz python manage.py backup        (database + uploads into /data/backups, keeps 14)
"""
import secrets
import sqlite3
import sys
import tarfile
import time

import main as m


def find(email):
    user = m.row("SELECT * FROM users WHERE email = ?", email)
    if not user:
        sys.exit(f"no account with email {email}")
    return user


def run(args):
    if args[:1] == ["users"]:
        for u in m.rows("SELECT u.*, (SELECT COUNT(*) FROM quizzes q WHERE q.owner_id = u.id) n FROM users u ORDER BY u.created"):
            print(f"{u['email']:40} {u['name']:30} {u['role']:8} quizzes={u['n']:<4} {time.strftime('%Y-%m-%d', time.localtime(u['created']))}"
                  f"{' DISABLED' if u['disabled'] else ''}")
    elif len(args) == 4 and args[0] == "create" and args[3] in m.ROLES:
        email, name = m.valid_identity({"email": args[1], "name": args[2]})
        if m.row("SELECT 1 FROM users WHERE email = ?", email):
            sys.exit(f"{email} already has an account; use: role {email} {args[3]}")
        password = secrets.token_urlsafe(9)
        m.run("INSERT INTO users(email,name,pw,created,role) VALUES (?,?,?,?,?)", email, name, m.hash_password(password), time.time(), args[3])
        print(f"created {args[3]} {email} with password: {password}")
    elif len(args) == 3 and args[0] == "role" and args[2] in m.ROLES:
        user = find(args[1])
        m.run("UPDATE users SET role = ? WHERE id = ?", args[2], user["id"])
        print(f"{user['email']}: now {args[2]}")
    elif len(args) == 2 and args[0] == "reset-password":
        user = find(args[1])
        password = secrets.token_urlsafe(9)
        m.run("UPDATE users SET pw = ? WHERE id = ?", m.hash_password(password), user["id"])
        m.run("DELETE FROM sessions WHERE user_id = ?", user["id"])
        print(f"new password for {user['email']}: {password}")
    elif len(args) == 2 and args[0] in ("disable", "enable"):
        user = find(args[1])
        m.run("UPDATE users SET disabled = ? WHERE id = ?", int(args[0] == "disable"), user["id"])
        m.run("DELETE FROM sessions WHERE user_id = ?", user["id"])
        print(f"{user['email']}: {args[0]}d")
    elif len(args) == 2 and args[0] == "delete":
        user = find(args[1])
        m.run("DELETE FROM users WHERE id = ?", user["id"])  # cascades to quizzes, games, wheels
        print(f"{user['email']}: deleted with everything they made")
    elif args[:1] == ["has-admin"]:  # exit code 0 if an admin account exists (used by install.sh)
        sys.exit(0 if m.row("SELECT 1 FROM users WHERE role = 'admin' AND disabled = 0") else 1)
    elif args[:1] == ["backup"]:
        folder = m.DATA / "backups"
        folder.mkdir(exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        db = folder / f"quiz-{stamp}.db"
        with sqlite3.connect(db) as out:
            m._db.backup(out)  # consistent copy while the site keeps running
        archive = folder / f"quiz-{stamp}.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(db, arcname="quiz.db")
            for sub in ("uploads", "brand"):
                if (m.DATA / sub).is_dir():
                    tar.add(m.DATA / sub, arcname=sub)
        db.unlink()
        for old in sorted(folder.glob("quiz-*.tar.gz"))[:-14]:
            old.unlink()
        print(f"backup written: {archive} ({archive.stat().st_size // 1024} KB)")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    run(sys.argv[1:])
