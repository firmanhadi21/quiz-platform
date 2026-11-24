# Installing, customising and developing the quiz platform

This guide is for putting the platform on a server, for example for a school or a client,
and for changing it. For what the platform does, see [README.md](README.md).

Already running nginx? Use `deploy/nginx.example.conf` instead of the bundled Caddy.

## 1. What you need

- A Linux server with **Docker** and the **compose plugin**. 1 CPU and 1 GB of free memory is
  enough for a school (a few hundred players at once).
- A **domain name** whose DNS points at the server, with ports **80 and 443** open. Caddy gets
  and renews the HTTPS certificate by itself.
- Optional: an **API key** for an OpenAI-compatible AI service (DeepSeek, OpenAI, OpenRouter...)
  for the AI question writer. Without one, everything else works.

## 2. Install

```bash
git clone https://github.com/firmanhadi21/quiz-platform.git
cd quiz-platform/deploy
./install.sh          # first run: creates .env and stops
nano .env             # set DOMAIN, ADMIN_EMAIL, and the AI key if wanted
./install.sh          # builds, starts, creates the first admin and prints its password
```

Open `https://<DOMAIN>/login`, sign in with that password, then change it (click your name in the menu).

Everything the site stores (database, uploaded images, logo, backups) is in the Docker volume
`quiz_quiz-data`. Settings are in `.env`, which holds the AI key: keep it private (`chmod 600`).

To check a fresh install end to end (sign-in, a quiz, and a live game through the proxy):

```bash
docker run --rm --network host -v "$PWD/../tests/install_check.py:/t.py:ro" quiz-quiz \
  python /t.py https://<DOMAIN> <admin email> <password>
```

## 3. Configure

Starting values are in `.env`. The ones marked *admin page* can be changed later on the site
(**Admin** in the menu) without touching the server.

| Setting | What it does | Admin page |
|---|---|---|
| `DOMAIN` | Address of the site | – |
| `ADMIN_EMAIL`, `ADMIN_NAME` | First admin, made by `install.sh` | – |
| `QUIZ_SITE_NAME`, `QUIZ_ORG` | Name in the header and browser tab; organisation | yes |
| `QUIZ_COLOR_PRIMARY`, `QUIZ_COLOR_ACCENT` | Brand colours (`#rrggbb`); lighter and darker shades are derived | yes |
| logo | PNG, JPG or WebP up to 1 MB, uploaded on the Admin page | yes |
| `QUIZ_REGISTRATION` | `open`, or `closed` so only admins create accounts | yes |
| `QUIZ_DEFAULT_ROLE` | Role of new sign-ups: `student` or `teacher` | yes |
| `QUIZ_SEED` | `on` loads the starter quizzes in `app/seed/` into the library | – |
| `QUIZ_AI_URL`, `QUIZ_AI_MODEL`, `QUIZ_AI_KEY` | AI question writer; empty key switches it off | – |
| `TZ` | Time zone for dates in reports | – |
| `HTTP_PORT`, `HTTPS_PORT` | Only if 80/443 are taken | – |

After editing `.env`, apply it with `./install.sh` (or `docker compose up -d`).

**AI providers.** Any service with an OpenAI-style `/chat/completions` endpoint works:

| Provider | `QUIZ_AI_URL` | `QUIZ_AI_MODEL` (example) |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-v4-flash` |
| OpenAI | `https://api.openai.com/v1` | `gpt-5-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` |

Each AI request is billed to that key. The site limits each teacher to 5 requests per 5 minutes
and 40 per day.

**Own starter quizzes.** Put quiz files (the JSON from *Ekspor JSON* on a quiz page) in a folder,
mount it into the container, and set `QUIZ_SEED=on` and `QUIZ_SEED_DIR=/seed`. Each file is
loaded once, as a read-only public quiz anyone can copy.

## 4. Run it day to day

| Task | Command (in `deploy/`) |
|---|---|
| Backup | `docker compose exec quiz python manage.py backup` (keeps the last 14 in `/data/backups`) |
| Copy a backup out | `docker compose cp quiz:/data/backups ./backups` |
| List users | `docker compose exec quiz python manage.py users` |
| Lost admin password | `docker compose exec quiz python manage.py reset-password <email>` |
| Make someone admin | `docker compose exec quiz python manage.py role <email> admin` |
| Logs | `docker compose logs -f quiz` |
| Update | `git pull && ./install.sh` |

Schedule the backup nightly, e.g. with cron:
`0 2 * * * cd /path/to/quiz-platform/deploy && docker compose exec -T quiz python manage.py backup`

**Restore** a backup: stop the site (`docker compose stop quiz`), unpack the archive's `quiz.db`,
`uploads/` and `brand/` into the data volume (for example with
`docker compose run --rm -v "$PWD:/b" quiz tar xzf /b/quiz-<stamp>.tar.gz -C /data`), then
`docker compose start quiz`.

**Updates** keep all data. A restart interrupts a live game that is running (answers already
given are kept), so update outside class hours.

## 5. Customise further (code)

| To change | Edit |
|---|---|
| Any interface text, in both languages | `app/static/js/strings.js` (key → `[Indonesian, English]`) |
| Layout and default colours | `app/static/style.css` (brand colours: the `--teal-*` and `--amber-*` variables) |
| Page title and header | `app/static/index.html` (name and logo come from the Admin page) |
| What the AI is told | `build_prompt` and `build_reading_prompt` in `app/ai.py` |
| Scoring (speed bonus) | `points_for` in `app/main.py` |
| Anti-cheat grace period | `GRACE` in `app/guard.py` |
| Limits (players per game, file sizes) | constants at the top of `app/main.py` and `app/ai.py` |

Keep one codebase for every client and put client differences in `.env` and on the Admin
page. A fork per client means every fix has to be made again for each one.

## 6. Develop

```bash
cd quiz-platform
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest
cd app && QUIZ_SECURE_COOKIE=0 ../.venv/bin/uvicorn main:app --reload --port 8765
# first admin for the local copy (data in data/):
.venv/bin/python app/manage.py create you@example.org "Your Name" admin
```

Then open <http://127.0.0.1:8765>. `QUIZ_SECURE_COOKIE=0` lets sign-in work without HTTPS.

**Tests**, before every release:

```bash
.venv/bin/pytest -q                                   # API: accounts, quizzes, games, AI, anti-cheat...
PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs tests/run_e2e.sh [screenshot-dir]
                                                      # browser: a teacher and students through a whole session
```

**Code map**

```
app/main.py      accounts, quizzes, games, assignments, reports, wheels, pages
app/live.py      live games over WebSocket
app/ai.py        AI question writer (file reading, prompts, provider call)
app/guard.py     anti-cheat mode
app/admin.py     user management, site settings, password change
app/brand.py     site name, colours, logo
app/manage.py    server-side admin commands and backup
app/static/      the whole frontend: plain JavaScript modules, no build step
deploy/          docker-compose + Caddy + install.sh; nginx.example.conf for servers that already run nginx
```

The app is one Python process with SQLite. That is deliberate: live games keep their turn state
in memory, so do not run more than one worker.

## 7. Before handing it to a client

- **Licence.** The code is under the [MIT licence](LICENSE): keep the copyright notice with it.
  Support and hosting terms are separate; agree them in writing.
- **Personal data.** The site stores students' names, email addresses and scores on the
  client's server. The client is responsible for that data; agree on retention and who has
  admin access. AI requests send teaching material (not student data) to the AI provider.
- **Email.** There is none: password resets go through an admin.
- **Scale.** Built for a school or department, not many schools on one install.
