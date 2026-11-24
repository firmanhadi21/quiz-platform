"""Site identity: name, organisation, colours and logo. Set by an admin on the Admin page, with
starting values from the environment (QUIZ_SITE_NAME, QUIZ_ORG, QUIZ_COLOR_PRIMARY, QUIZ_COLOR_ACCENT),
so one codebase serves every client without code changes.
"""
import os
import re

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, Response

import main as m

DEFAULTS = {
    "site_name": os.environ.get("QUIZ_SITE_NAME", "Quiz"),
    "org_name": os.environ.get("QUIZ_ORG", ""),
    "color_primary": os.environ.get("QUIZ_COLOR_PRIMARY", "#0f6b5f"),
    "color_accent": os.environ.get("QUIZ_COLOR_ACCENT", "#f0b429"),
    "logo": "",
}
HEX = re.compile(r"#[0-9a-fA-F]{6}")
LOGO_DIR = m.DATA / "brand"
LOGO_DIR.mkdir(exist_ok=True)
LOGO_MAGIC = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"))  # no SVG: it could carry script

m.MSG.update({
    "color": ("Warna harus berupa kode seperti #0f6b5f.", "Colours must be a code like #0f6b5f."),
    "site_name": ("Nama situs wajib diisi (maks. 60 karakter).", "The site name is required (60 characters at most)."),
    "logo": ("Logo harus PNG, JPG, atau WebP, maks. 1 MB.", "The logo must be PNG, JPG or WebP, 1 MB at most."),
})


def site():
    saved = {r["key"]: r["value"] for r in m.rows("SELECT key, value FROM settings WHERE key IN (?,?,?,?,?)", *DEFAULTS)}
    s = {**DEFAULTS, **saved}
    for key in ("color_primary", "color_accent"):
        if not HEX.fullmatch(s[key]):
            s[key] = DEFAULTS[key] if HEX.fullmatch(DEFAULTS[key]) else ("#0f6b5f" if key == "color_primary" else "#f0b429")
    return {"name": s["site_name"], "org": s["org_name"], "primary": s["color_primary"].lower(),
            "accent": s["color_accent"].lower(), "logo": f"/brand/{s['logo']}" if s["logo"] else ""}


def mix(color, other, amount):
    a = [int(color[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(other[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * amount):02x}" for x, y in zip(a, b))


def theme_css(s):
    p, a = s["primary"], s["accent"]
    return (":root{"
            f"--teal:{p};--teal-deep:{mix(p, '#000000', .3)};--teal-night:{mix(p, '#000000', .55)};"
            f"--teal-wash:{mix(p, '#ffffff', .9)};--teal-glow:{mix(p, '#ffffff', .08)};"
            f"--amber-bright:{a};--amber:{mix(a, '#000000', .2)};--amber-wash:{mix(a, '#ffffff', .88)}}}\n")


@m.app.get("/brand.css")
async def brand_css():
    return Response(theme_css(site()), media_type="text/css", headers={"Cache-Control": "no-cache"})


@m.app.get("/brand/{name}")
async def brand_file(name: str):
    path = LOGO_DIR / name
    if not re.fullmatch(r"logo-[0-9a-z]{8}\.(png|jpg|webp)", name) or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})


def save(body):
    """Apply the branding fields present in an admin settings request."""
    if "site_name" in body:
        name = m._text(body["site_name"], 60)
        if not name:
            m.fail(400, "site_name")
        m.set_setting("site_name", name)
    if "org_name" in body:
        m.set_setting("org_name", m._text(body["org_name"], 120))
    for key in ("color_primary", "color_accent"):
        if key in body:
            if not isinstance(body[key], str) or not HEX.fullmatch(body[key]):
                m.fail(400, "color")
            m.set_setting(key, body[key].lower())


@m.app.post("/api/admin/logo")
async def upload_logo(request: Request):
    m.need_admin(request)
    data = await request.body()
    ext = next((e for magic, e in LOGO_MAGIC if data.startswith(magic)), None)
    if not ext and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        ext = "webp"
    if not ext or len(data) > 1024 * 1024:
        m.fail(400, "logo")
    old = site()["logo"]
    name = f"logo-{m.new_id(8)}.{ext}"  # a new name each time, so browsers never show a cached old logo
    (LOGO_DIR / name).write_bytes(data)
    m.set_setting("logo", name)
    if old:
        (LOGO_DIR / old.rsplit("/", 1)[1]).unlink(missing_ok=True)
    return site()


@m.app.delete("/api/admin/logo")
async def remove_logo(request: Request):
    m.need_admin(request)
    old = site()["logo"]
    m.set_setting("logo", "")
    if old:
        (LOGO_DIR / old.rsplit("/", 1)[1]).unlink(missing_ok=True)
    return site()

