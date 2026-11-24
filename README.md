# Quiz Platform

A self-hosted classroom quiz platform: live quizzes on the class screen, self-paced
assignments, an AI question writer, results dashboards and a spin-the-wheel. The interface is in
Bahasa Indonesia and English.

It is one small container (FastAPI + SQLite, plain JavaScript, no build step), so a school,
a department or a single teacher can run it on their own server and keep their students' data there.

## Features

| | |
|---|---|
| **Live quiz** | Every game gets a 6-digit code and a QR code. Students join on their phones with a nickname or an account; the teacher runs it on the class screen. Faster correct answers score more. |
| **Assignments** | The same quizzes, self-paced, with an optional per-question timer and a deadline. Question and option order can be shuffled per student. |
| **Question types** | Multiple choice, multiple answers, true/false, short answer and poll, with images, time limits and points. Import/export JSON, or paste many questions as text. |
| **Reading passages** | For reading practice (e.g. TOEFL Reading): the passage is shown first with no clock running, then stays beside its questions. |
| **AI question writer** | Paste material or upload PDF, DOCX, PPTX or text (up to 50 MB), optionally with an assessment rubric. Any OpenAI-compatible API (DeepSeek, OpenAI, OpenRouter...) drafts the questions; the teacher reviews them before saving. |
| **Results dashboard** | Winner and podium, class averages, accuracy spread, per-student and per-question tables, per-rubric-criterion accuracy, CSV and print. |
| **Review** | Step through a finished game question by question: the teacher with the class's answers, each student with their own. |
| **Anti-cheat mode** | Optional per game. A browser cannot stop someone switching apps, but it notices: every exit is logged and the teacher chooses the penalty (record only, zero for the open question, or lock-out). |
| **Spin the wheel** | Names typed in, from a game's players, or from an Excel/CSV class list (number and name). |
| **Accounts and roles** | Student, teacher and admin. Admins manage users, registration, the default role, and the site's name, colours and logo. |

## Quick start

On a Linux server with Docker, and a domain pointing at it:

```bash
git clone https://github.com/firmanhadi21/quiz-platform.git
cd quiz-platform/deploy
./install.sh          # creates .env, then stops
nano .env             # set DOMAIN, ADMIN_EMAIL, and an AI key if wanted
./install.sh          # builds and starts it with HTTPS (Caddy), prints the first admin's password
```

Then open `https://<your domain>/login`. The full guide (all settings, backups, updates,
customising and developing) is in **[DEPLOY.md](DEPLOY.md)**.

## Try it locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest
.venv/bin/python app/manage.py create you@example.org "Your Name" admin   # prints a password
cd app && QUIZ_SECURE_COOKIE=0 ../.venv/bin/uvicorn main:app --port 8765
```

Open <http://127.0.0.1:8765> and sign in. Run the tests with `.venv/bin/pytest -q`.

## Limits

- One process with SQLite: right for a school or department (a few hundred players at once),
  not for many schools on one install.
- No email: password resets go through an admin.
- Anti-cheat mode records leaving the page; it cannot prevent it or see a second device.

## Licence

[MIT](LICENSE). You may use, change and host it, including commercially, as long as the
copyright notice stays with the code.
