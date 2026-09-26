"""ฐานข้อมูล และการนำเข้า CSV จาก extension "Comments Exporter"

รองรับ 2 แบบ (โค้ดชุดเดียวกัน):
  - ในเครื่อง: SQLite ไฟล์ data.sqlite3 (ไม่ต้องตั้งค่าอะไร)
  - ออนไลน์ (Vercel): Postgres ของ Supabase — ตั้ง env DATABASE_URL หรือ POSTGRES_URL
"""
import base64
import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from . import classifier

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or ""
PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))
SQLITE_PATH = os.environ.get("COMMENT_DB", os.path.join(ROOT, "data.sqlite3"))
SCHEMA_VERSION = "2"
TZ = timezone(timedelta(hours=7))  # เวลาประเทศไทย (เซิร์ฟเวอร์ออนไลน์ใช้ UTC)
_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    fb_id TEXT,              -- เลขโพสต์จาก Comment ID
    fb_key TEXT,             -- รหัสจากลิงก์ที่ลงทะเบียน (pfbid / เลขโพสต์) ใช้จับคู่กับ CSV
    fb_url TEXT,             -- ลิงก์ที่ผู้ดูแลเพิ่มเอง
    url TEXT,                -- ลิงก์โพสต์ที่อ่านได้จาก CSV
    title TEXT,
    note TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT,
    first_imported TEXT,
    last_imported TEXT
);
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT,
    parent_id TEXT,
    text TEXT,
    ts TEXT,
    like_count INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    url TEXT,
    user_id TEXT,
    user_name TEXT,
    user_homepage TEXT,
    imported_at TEXT,
    auto_label TEXT,
    auto_category TEXT,
    auto_urgency TEXT,
    auto_location TEXT,
    matched TEXT,
    is_problem INTEGER DEFAULT 0,
    category TEXT,
    urgency TEXT,
    location TEXT,
    review TEXT DEFAULT 'pending',
    status TEXT,
    note TEXT,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_c_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_c_ts ON comments(ts);
CREATE TABLE IF NOT EXISTS history (
    id {serial},
    comment_id TEXT,
    at TEXT,
    field TEXT,
    old_value TEXT,
    new_value TEXT
);
CREATE INDEX IF NOT EXISTS idx_h_comment ON history(comment_id);
CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY,
    at TEXT,
    filename TEXT,
    post_id TEXT,
    total INTEGER,
    added INTEGER,
    duplicate INTEGER
);
CREATE TABLE IF NOT EXISTS keywords (
    grp TEXT PRIMARY KEY,
    words TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS login_fail (
    ip TEXT,
    at REAL
)
"""
TABLES = ("posts", "comments", "history", "imports", "keywords", "settings", "login_fail")
EDITABLE = ("is_problem", "category", "urgency", "location", "review", "status", "note")


def now():
    return datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# การเชื่อมต่อ (ให้ SQLite และ Postgres ใช้คำสั่งชุดเดียวกัน โดยเขียน SQL ด้วย ?)
# ---------------------------------------------------------------------------
def _clean_pg_url(url):
    # ลิงก์จาก Vercel/Supabase บางทีมีพารามิเตอร์ที่ psycopg ไม่รู้จัก (เช่น supa=...)
    p = urlsplit(url)
    keep = [(k, v) for k, v in parse_qsl(p.query) if k in ("sslmode", "connect_timeout", "application_name")]
    host = p.hostname or ""
    if not any(k == "sslmode" for k, _ in keep) and host not in ("localhost", "127.0.0.1", ""):
        keep.append(("sslmode", "require"))
    return urlunsplit((p.scheme, p.netloc, p.path, urlencode(keep), ""))


class Conn:
    def __init__(self, raw):
        self.raw = raw

    def _sql(self, sql):
        return sql.replace("?", "%s") if PG else sql

    def q(self, sql, args=()):
        return [dict(r) for r in self.raw.execute(self._sql(sql), tuple(args)).fetchall()]

    def one(self, sql, args=()):
        rows = self.q(sql, args)
        return rows[0] if rows else None

    def val(self, sql, args=()):
        r = self.one(sql, args)
        return list(r.values())[0] if r else None

    def x(self, sql, args=()):
        return self.raw.execute(self._sql(sql), tuple(args)).rowcount

    def many(self, sql, seq):
        seq = list(seq)
        if not seq:
            return
        if PG:
            with self.raw.cursor() as cur:
                cur.executemany(self._sql(sql), seq)
        else:
            self.raw.executemany(sql, seq)


_pg = None


def _pg_connect():
    import psycopg
    from psycopg.rows import dict_row
    # prepare_threshold=None: ใช้กับ connection pooler ของ Supabase (transaction mode) ได้
    return psycopg.connect(_clean_pg_url(DATABASE_URL), row_factory=dict_row,
                           prepare_threshold=None, connect_timeout=10)


class tx:
    """with tx() as c:  — ทำงานใน transaction เดียว commit เมื่อจบ"""

    def __enter__(self):
        global _pg
        _lock.acquire()
        try:
            if PG:
                if _pg is None or _pg.closed or _pg.broken:
                    _pg = _pg_connect()
                self.raw = _pg
            else:
                self.raw = sqlite3.connect(SQLITE_PATH)
                self.raw.row_factory = sqlite3.Row
            return Conn(self.raw)
        except BaseException:
            _lock.release()
            raise

    def __exit__(self, et, ev, tb):
        global _pg
        try:
            if et is None:
                self.raw.commit()
            else:
                try:
                    self.raw.rollback()
                except Exception:
                    _pg = None
            if not PG:
                self.raw.close()
        finally:
            _lock.release()
        return False


# ---------------------------------------------------------------------------
# สร้างตาราง / ค่าเริ่มต้น
# ---------------------------------------------------------------------------
_inited = False


def init():
    """สร้างตาราง ใส่ keyword เริ่มต้น และตั้งรหัสผ่านครั้งแรก
    รหัสผ่านเริ่มต้นมาจาก env ADMIN_PASSWORD / VIEWER_PASSWORD ถ้ามี ไม่งั้นสุ่มให้
    คืนค่า dict รหัสผ่านที่เพิ่งสุ่ม (ไว้แสดงบนหน้าจอตอนรันในเครื่อง)"""
    global _inited
    if _inited:
        return {}
    created = {}
    with tx() as c:
        ready = False
        try:
            ready = c.val("SELECT value FROM settings WHERE key='schema_version'") == SCHEMA_VERSION
        except Exception:
            c.raw.rollback()
        if not ready:
            serial = "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY" if PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
            for stmt in SCHEMA.format(serial=serial).split(";"):
                if stmt.strip():
                    c.x(stmt)
            if PG:
                # ปิดการเข้าถึงผ่าน API สาธารณะของ Supabase (anon key) — ระบบนี้ต่อฐานข้อมูลตรง
                for t in TABLES:
                    c.x(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
            for grp, words in classifier.DEFAULT_KEYWORDS.items():
                c.x("INSERT INTO keywords(grp, words) VALUES (?, ?) ON CONFLICT(grp) DO NOTHING", (grp, words))
            for role in ("admin", "viewer"):
                if not c.one("SELECT 1 AS x FROM settings WHERE key=?", (f"pw_{role}",)):
                    env_pw = os.environ.get(f"{role.upper()}_PASSWORD")
                    pw = env_pw or secrets.token_hex(3)
                    if not env_pw:
                        created[role] = pw
                    c.x("INSERT INTO settings VALUES (?, ?)", (f"pw_{role}", hash_pw(pw)))
            c.x("INSERT INTO settings VALUES ('secret', ?) ON CONFLICT(key) DO NOTHING", (secrets.token_hex(32),))
            c.x("""INSERT INTO settings VALUES ('schema_version', ?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value""", (SCHEMA_VERSION,))
    _inited = True
    return created


# ---------------------------------------------------------------------------
# รหัสผ่าน และ session (cookie ที่เซ็นด้วย HMAC — ใช้ได้บน serverless)
# ---------------------------------------------------------------------------
def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(8)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 200_000).hex()
    return f"{salt}${h}"


_settings_cache = {"at": 0, "data": {}}


def _settings(fresh=False):
    if fresh or time.time() - _settings_cache["at"] > 30:
        with tx() as c:
            rows = c.q("SELECT key, value FROM settings WHERE key IN ('pw_admin','pw_viewer','secret')")
        _settings_cache.update(at=time.time(), data={r["key"]: r["value"] for r in rows})
    return _settings_cache["data"]


def check_pw(pw):
    s = _settings(fresh=True)
    for role in ("admin", "viewer"):
        stored = s.get(f"pw_{role}")
        if stored and hmac.compare_digest(hash_pw(pw, stored.split("$")[0]), stored):
            return role
    return None


def set_pw(role, pw):
    with tx() as c:
        c.x("UPDATE settings SET value=? WHERE key=?", (hash_pw(pw), f"pw_{role}"))
    _settings(fresh=True)


def _pw_ver(s, role):
    return hashlib.sha256((s.get(f"pw_{role}") or "").encode()).hexdigest()[:10]


def make_token(role, hours):
    s = _settings()
    body = base64.urlsafe_b64encode(json.dumps(
        {"r": role, "e": int(time.time() + hours * 3600), "v": _pw_ver(s, role)}).encode()).decode()
    sig = hmac.new(s["secret"].encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def read_token(token):
    """คืนสิทธิ์ถ้า token ถูกต้อง ยังไม่หมดอายุ และรหัสผ่านยังไม่ถูกเปลี่ยน"""
    if not token or "." not in token:
        return None
    body, sig = token.rsplit(".", 1)
    s = _settings()
    good = hmac.new(s["secret"].encode(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, good):
        return None
    try:
        d = json.loads(base64.urlsafe_b64decode(body.encode()))
    except ValueError:
        return None
    if d.get("e", 0) < time.time() or d.get("r") not in ("admin", "viewer"):
        return None
    if d.get("v") != _pw_ver(s, d["r"]):
        return None
    return d["r"]


def login_blocked(ip):
    with tx() as c:
        c.x("DELETE FROM login_fail WHERE at < ?", (time.time() - 300,))
        return (c.val("SELECT COUNT(*) AS n FROM login_fail WHERE ip=?", (ip,)) or 0) >= 8


def login_failed(ip):
    with tx() as c:
        c.x("INSERT INTO login_fail VALUES (?, ?)", (ip, time.time()))


# ---------------------------------------------------------------------------
# keyword
# ---------------------------------------------------------------------------
def get_keywords():
    with tx() as c:
        return {r["grp"]: r["words"] for r in c.q("SELECT grp, words FROM keywords")}


def save_keywords(data):
    with tx() as c:
        for grp, words in data.items():
            if grp in classifier.DEFAULT_KEYWORDS:
                clean = "\n".join(classifier.split_words(words))
                c.x("INSERT INTO keywords VALUES (?, ?) ON CONFLICT(grp) DO UPDATE SET words=excluded.words",
                    (grp, clean))


def reclassify(only_pending=True):
    """คัดกรองใหม่ตาม keyword ปัจจุบัน (ค่าเริ่มต้น: เฉพาะเรื่องที่ยังไม่ได้ตรวจทาน)"""
    kw = get_keywords()
    with tx() as c:
        rows = c.q("SELECT id, text FROM comments" + (" WHERE review='pending'" if only_pending else ""))
        seq = []
        for row in rows:
            r = classifier.classify(row["text"], kw)
            seq.append((r["label"], r["category"], r["urgency"], r["location"], r["matched"],
                        r["is_problem"], r["category"], r["urgency"], r["location"],
                        r["is_problem"], row["id"]))
        c.many("""UPDATE comments SET auto_label=?, auto_category=?, auto_urgency=?,
                  auto_location=?, matched=?, is_problem=?, category=?, urgency=?, location=?,
                  status=CASE WHEN ?=1 THEN COALESCE(status,'ใหม่') ELSE status END
                  WHERE id=?""", seq)
    return len(rows)


# ---------------------------------------------------------------------------
# โพสต์ (หลังบ้าน: ผู้ดูแลเพิ่มลิงก์โพสต์ที่ต้องติดตาม)
# ---------------------------------------------------------------------------
FB_URL = re.compile(r"^https://([a-z0-9-]+\.)?(facebook\.com|fb\.com|fb\.watch|fb\.me)/", re.I)


def fb_key_from_url(url):
    """ดึงรหัสโพสต์จากลิงก์ Facebook: pfbid... หรือเลขโพสต์"""
    m = re.search(r"(pfbid[0-9A-Za-z]+)", url or "")
    if m:
        return m.group(1)
    for pat in (r"story_fbid=(\d+)", r"/posts/(\d+)", r"/permalink/(\d+)", r"[?&]fbid=(\d+)",
                r"/videos/(\d+)", r"/reel/(\d+)", r"/photos/[^/]+/(\d+)"):
        m = re.search(pat, url or "")
        if m:
            return m.group(1)
    return ""


def add_post(fb_url, title, note=""):
    fb_url = (fb_url or "").strip()
    if not FB_URL.match(fb_url):
        raise ValueError("ลิงก์ต้องเป็นลิงก์ Facebook (https://www.facebook.com/...)")
    key = fb_key_from_url(fb_url)
    with tx() as c:
        if key and c.one("SELECT 1 AS x FROM posts WHERE fb_key=? OR fb_id=?", (key, key)):
            raise ValueError("โพสต์นี้มีในระบบแล้ว")
        pid = "p" + secrets.token_hex(5)
        c.x("""INSERT INTO posts(id, fb_key, fb_url, title, note, active, created_at)
               VALUES (?, ?, ?, ?, ?, 1, ?)""",
            (pid, key, fb_url, (title or "").strip()[:200] or "โพสต์ใหม่", (note or "").strip()[:500], now()))
    return pid


def update_post(pid, changes):
    allowed = {k: v for k, v in changes.items() if k in ("title", "note", "active", "fb_url")}
    if "fb_url" in allowed:
        allowed["fb_url"] = str(allowed["fb_url"] or "").strip()
        if allowed["fb_url"] and not FB_URL.match(allowed["fb_url"]):
            raise ValueError("ลิงก์ต้องเป็นลิงก์ Facebook")
        allowed["fb_key"] = fb_key_from_url(allowed["fb_url"])
    if "active" in allowed:
        allowed["active"] = 1 if allowed["active"] in (1, True, "1") else 0
    for k in ("title", "note"):
        if k in allowed:
            allowed[k] = str(allowed[k] or "").strip()[:500]
    if not allowed:
        return
    with tx() as c:
        c.x(f"UPDATE posts SET {', '.join(f'{k}=?' for k in allowed)} WHERE id=?", (*allowed.values(), pid))


def delete_post(pid):
    with tx() as c:
        if c.val("SELECT COUNT(*) AS n FROM comments WHERE post_id=?", (pid,)):
            raise ValueError("โพสต์นี้มีคอมเมนต์แล้ว ลบไม่ได้ (ใช้ปิดการติดตามแทน)")
        c.x("DELETE FROM posts WHERE id=?", (pid,))


def posts():
    with tx() as c:
        return c.q(f"""SELECT p.*, COUNT(c.id) AS n,
               {_cnt("c.is_problem=1 AND c.review!='rejected'")} AS problems,
               {_cnt("c.is_problem=1 AND c.review!='rejected' AND c.urgency='urgent' AND COALESCE(c.status,'')!='เสร็จสิ้น'")} AS urgent_open,
               {_cnt("c.review='pending' AND (c.is_problem=1 OR c.auto_label='needs_view')")} AS pending,
               MAX(c.ts) AS last_comment
               FROM posts p LEFT JOIN comments c ON c.post_id=p.id
               GROUP BY p.id ORDER BY p.active DESC, COALESCE(p.last_imported, p.created_at) DESC""")


# ---------------------------------------------------------------------------
# นำเข้า CSV
# ---------------------------------------------------------------------------
def parse_time(s):
    """'26/9/2569 12:59:58' (พ.ศ.) -> '2026-09-26 12:59:58'"""
    s = (s or "").strip()
    for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            d = datetime.strptime(s[:19], fmt)
            if d.year > 2400:
                d = d.replace(year=d.year - 543)
            return d.strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    return s


def fb_id_from(comment_id, filename=""):
    """Comment ID เป็น base64 ของ 'comment:<postid>_<commentid>'"""
    try:
        raw = base64.b64decode(comment_id + "=" * (-len(comment_id) % 4)).decode()
        m = re.match(r"comment:(\d+)_", raw)
        if m:
            return m.group(1)
    except Exception:
        pass
    m = re.search(r"(\d{10,})", filename or "")
    return m.group(1) if m else "unknown"


def _int(v):
    try:
        return int(str(v).replace(",", "").strip() or 0)
    except ValueError:
        return 0


def _resolve_post(c, fb_id, csv_url, target, t):
    """หาโพสต์ในระบบที่ตรงกับคอมเมนต์ชุดนี้ คืน (post_id, warning)"""
    p = c.one("SELECT id FROM posts WHERE fb_id=?", (fb_id,))
    if p:
        warn = ""
        if target and target != p["id"]:
            warn = "ไฟล์นี้เป็นของโพสต์อื่นในระบบ — นำเข้าไปที่โพสต์ที่ถูกต้องให้แล้ว"
        return p["id"], warn
    key = fb_key_from_url(csv_url)
    if target:
        tp = c.one("SELECT id, fb_id, fb_key FROM posts WHERE id=?", (target,))
        if tp and not tp["fb_id"] and (not tp["fb_key"] or tp["fb_key"] in (key, fb_id)):
            c.x("UPDATE posts SET fb_id=?, url=? WHERE id=?", (fb_id, csv_url, target))
            return target, ""
    cands = [key, fb_id] if key else [fb_id]
    p = c.one(f"SELECT id FROM posts WHERE fb_id IS NULL AND fb_key IN ({','.join('?' * len(cands))})", cands)
    if p:
        c.x("UPDATE posts SET fb_id=?, url=? WHERE id=?", (fb_id, csv_url, p["id"]))
        return p["id"], ""
    c.x("""INSERT INTO posts(id, fb_id, fb_key, url, title, active, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(id) DO NOTHING""",
        (fb_id, fb_id, key, csv_url, f"โพสต์ {fb_id[-6:]}", t))
    warn = ("ไฟล์ไม่ตรงกับลิงก์ของโพสต์ที่เลือก — สร้างเป็นโพสต์ใหม่ให้แล้ว ตรวจชื่อโพสต์อีกครั้ง"
            if target else "")
    return fb_id, warn


def import_rows(rows, filename="", target_post=None, batch_id=None):
    """นำเข้าแถวจาก CSV (list ของ dict ตามหัวคอลัมน์ของ Comments Exporter)
    คอมเมนต์ที่มี Comment ID ซ้ำจะไม่ถูกเพิ่มซ้ำ (อัปเดตแค่ยอดไลก์/ตอบกลับ)"""
    kw = get_keywords()
    t = now()
    rows = [r for r in rows if isinstance(r, dict) and str(r.get("Comment ID") or "").strip()]
    warnings = []
    added = dup = 0
    post_ids = []
    with tx() as c:
        groups = {}
        for r in rows:
            groups.setdefault(fb_id_from(str(r["Comment ID"]).strip(), filename), []).append(r)
        for fb_id, grp in groups.items():
            csv_url = next((str(r.get("Comment URL")).split("?")[0] for r in grp if r.get("Comment URL")), "")
            pid, warn = _resolve_post(c, fb_id, csv_url, target_post, t)
            post_ids.append(pid)
            if warn:
                warnings.append(warn)
            ids = [str(r["Comment ID"]).strip() for r in grp]
            existing = set()
            for i in range(0, len(ids), 400):
                chunk = ids[i:i + 400]
                existing |= {x["id"] for x in c.q(
                    f"SELECT id FROM comments WHERE id IN ({','.join('?' * len(chunk))})", chunk)}
            new, upd, seen = [], [], set()
            for r in grp:
                cid = str(r["Comment ID"]).strip()
                if cid in existing or cid in seen:
                    dup += 1
                    upd.append((_int(r.get("Like Count")), _int(r.get("Reply Count")), cid))
                    continue
                seen.add(cid)
                text = str(r.get("Comment") or "")
                k = classifier.classify(text, kw)
                new.append((cid, pid, str(r.get("Reply To Comment") or "").strip(), text,
                            parse_time(r.get("Comment Time")), _int(r.get("Like Count")),
                            _int(r.get("Reply Count")), str(r.get("Comment URL") or "").strip(),
                            str(r.get("User ID") or ""), str(r.get("User Name") or ""),
                            str(r.get("User Homepage") or ""), t,
                            k["label"], k["category"], k["urgency"], k["location"], k["matched"],
                            k["is_problem"], k["category"], k["urgency"], k["location"],
                            "pending", "ใหม่" if k["is_problem"] else None, t))
            c.many("""INSERT INTO comments (id, post_id, parent_id, text, ts, like_count,
                reply_count, url, user_id, user_name, user_homepage, imported_at,
                auto_label, auto_category, auto_urgency, auto_location, matched,
                is_problem, category, urgency, location, review, status, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO NOTHING""", new)
            c.many("UPDATE comments SET like_count=?, reply_count=? WHERE id=?", upd)
            added += len(new)
            c.x("UPDATE posts SET last_imported=?, first_imported=COALESCE(first_imported, ?) WHERE id=?",
                (t, t, pid))
        c.x("""INSERT INTO imports(id, at, filename, post_id, total, added, duplicate) VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET total=imports.total+excluded.total,
               added=imports.added+excluded.added, duplicate=imports.duplicate+excluded.duplicate,
               at=excluded.at""",
            (str(batch_id or secrets.token_hex(6))[:40], t, (filename or "")[:200],
             ",".join(dict.fromkeys(post_ids)), len(rows), added, dup))
    return {"total": len(rows), "added": added, "duplicate": dup,
            "posts": list(dict.fromkeys(post_ids)), "warnings": list(dict.fromkeys(warnings))}


def import_csv(content, filename="", target_post=None):
    """นำเข้าเนื้อหาไฟล์ CSV ทั้งไฟล์ (ใช้ตอนรันในเครื่อง/ทดสอบ)"""
    reader = csv.DictReader(io.StringIO(content.lstrip("﻿")))
    if not reader.fieldnames or "Comment ID" not in reader.fieldnames:
        raise ValueError("ไม่พบคอลัมน์ 'Comment ID' — ไฟล์นี้ไม่ใช่ CSV จาก Comments Exporter")
    return import_rows(list(reader), filename, target_post)


# ---------------------------------------------------------------------------
# แก้ไขเรื่อง
# ---------------------------------------------------------------------------
def update_comment(cid, changes):
    changes = {k: v for k, v in changes.items() if k in EDITABLE}
    if not changes:
        return False
    t = now()
    with tx() as c:
        old = c.one("SELECT * FROM comments WHERE id=?", (cid,))
        if not old:
            return False
        if "is_problem" in changes:
            changes["is_problem"] = 1 if changes["is_problem"] in (1, True, "1", "true") else 0
            if changes["is_problem"]:
                changes.setdefault("status", old["status"] or "ใหม่")
                if not (changes.get("category") or old["category"]):
                    changes["category"] = "other"
                if not (changes.get("urgency") or old["urgency"]):
                    changes["urgency"] = "normal"
        hist = []
        for k, v in changes.items():
            if str(old[k] if old[k] is not None else "") != str(v if v is not None else ""):
                hist.append((cid, t, k, None if old[k] is None else str(old[k]), None if v is None else str(v)))
        c.many("INSERT INTO history(comment_id, at, field, old_value, new_value) VALUES (?,?,?,?,?)", hist)
        c.x(f"UPDATE comments SET {', '.join(f'{k}=?' for k in changes)}, updated_at=? WHERE id=?",
            (*changes.values(), t, cid))
    return True


def history(cid):
    with tx() as c:
        return c.q("SELECT at, field, old_value, new_value FROM history WHERE comment_id=? ORDER BY id DESC", (cid,))


def purge_personal(before=None):
    """ลบข้อมูลส่วนบุคคล (ชื่อ/ลิงก์โปรไฟล์/ลิงก์คอมเมนต์) ตาม PDPA
    before = 'YYYY-MM-DD' ลบเฉพาะคอมเมนต์ก่อนวันนั้น, None = ลบทั้งหมด"""
    q = "UPDATE comments SET user_name='(ลบแล้ว)', user_id='', user_homepage='', url=''"
    with tx() as c:
        return c.x(q + " WHERE ts < ?", (before,)) if before else c.x(q)


# ---------------------------------------------------------------------------
# ค้นหา / สรุป
# ---------------------------------------------------------------------------
VIEWS = {
    "problems": "is_problem=1 AND review!='rejected'",
    "review": "is_problem=1 AND review='pending'",
    "unmatched": "is_problem=0 AND review='pending' AND auto_label IN ('unmatched','not_problem')",
    "needs_view": "auto_label='needs_view' AND review='pending'",
    "rejected": "review='rejected' OR (is_problem=0 AND review='confirmed')",
    "all": "1=1",
}


def _cnt(cond):
    return f"CAST(COALESCE(SUM(CASE WHEN {cond} THEN 1 ELSE 0 END),0) AS INTEGER)"


def _where(f, view="problems"):
    conds = [f"({VIEWS.get(view, VIEWS['problems'])})"]
    args = []
    if f.get("post"):
        conds.append("post_id=?"); args.append(f["post"])
    if f.get("from"):
        conds.append("ts >= ?"); args.append(f["from"])
    if f.get("to"):
        conds.append("ts < ?")
        try:
            args.append((datetime.strptime(f["to"], "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d"))
        except ValueError:
            args.append(f["to"])
    for k in ("category", "urgency", "status"):
        if f.get(k):
            conds.append(f"{k}=?"); args.append(f[k])
    if f.get("dept"):
        keys = [k for k, _, d in classifier.CATEGORIES if d == f["dept"]] or ["-"]
        conds.append(f"category IN ({','.join('?' * len(keys))})"); args += keys
    if f.get("open"):
        conds.append("COALESCE(status,'') != 'เสร็จสิ้น'")
    if f.get("q"):
        conds.append("(text LIKE ? OR location LIKE ? OR user_name LIKE ? OR note LIKE ?)")
        args += [f"%{f['q']}%"] * 4
    return " AND ".join(conds), args


def list_comments(f, view="problems", limit=200, offset=0):
    where, args = _where(f, view)
    order = ("CASE urgency WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, ts DESC"
             if view == "problems" else "ts DESC")
    with tx() as c:
        total = c.val(f"SELECT COUNT(*) AS n FROM comments WHERE {where}", args)
        rows = c.q(f"""SELECT * FROM (SELECT c.*, p.title AS post_title FROM comments c
                       LEFT JOIN posts p ON p.id=c.post_id) x
                       WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?""", (*args, limit, offset))
    return total, rows


def stats(f):
    where, args = _where(f, "problems")
    base = f"FROM comments WHERE {where}"
    w2, a2 = _where({**f, "category": "", "urgency": "", "status": "", "dept": "", "q": "", "open": ""}, "all")
    with tx() as c:
        summary = c.one(f"""SELECT COUNT(*) AS total,
            {_cnt("urgency='urgent' AND COALESCE(status,'')!='เสร็จสิ้น'")} AS urgent_open,
            {_cnt("status IN ('รับเรื่อง','กำลังดำเนินการ','ส่งต่อหน่วยงาน')")} AS in_progress,
            {_cnt("status='เสร็จสิ้น'")} AS done,
            {_cnt("status='ใหม่'")} AS new {base}""", args)
        summary.update(c.one(f"""SELECT COUNT(*) AS all_comments,
            {_cnt("review='pending' AND (is_problem=1 OR auto_label='needs_view')")} AS pending_review
            FROM comments WHERE {w2}""", a2))

        def group(col):
            return {r["k"] or "": r["n"] for r in c.q(f"SELECT {col} AS k, COUNT(*) AS n {base} GROUP BY {col}", args)}

        by_cat, by_urg, by_st = group("category"), group("urgency"), group("status")
        times = [r["ts"] for r in c.q(f"SELECT ts {base} AND ts != '' ORDER BY ts", args)]
        hotspots = c.q(f"""SELECT location, COUNT(*) AS n, COUNT(DISTINCT user_id) AS people,
                {_cnt("urgency='urgent'")} AS urgent, MAX(ts) AS last
                {base} AND location != '' GROUP BY location ORDER BY n DESC, last DESC LIMIT 15""", args)
        urgent_open = c.q(f"""SELECT id, text, ts, location, category, status, user_name, url {base}
                AND urgency='urgent' AND status IN ('ใหม่','รับเรื่อง') ORDER BY ts LIMIT 30""", args)

    by_dept = {}
    for k, _, d in classifier.CATEGORIES:
        if by_cat.get(k):
            by_dept[d] = by_dept.get(d, 0) + by_cat[k]
    trend, unit = [], "hour"
    if times:
        t0 = datetime.strptime(times[0][:13], "%Y-%m-%d %H")
        t1 = datetime.strptime(times[-1][:13], "%Y-%m-%d %H")
        unit = "hour" if (t1 - t0) <= timedelta(hours=72) else "day"
        n = 13 if unit == "hour" else 10
        fmt, step = ("%Y-%m-%d %H", timedelta(hours=1)) if unit == "hour" else ("%Y-%m-%d", timedelta(days=1))
        counts = {}
        for t in times:
            counts[t[:n]] = counts.get(t[:n], 0) + 1
        cur = t0 if unit == "hour" else t0.replace(hour=0)
        while cur <= t1:
            key = cur.strftime(fmt)
            trend.append([key, counts.get(key, 0)])
            cur += step
    return {"summary": summary, "by_category": by_cat, "by_dept": by_dept,
            "by_urgency": by_urg, "by_status": by_st,
            "trend": trend, "trend_unit": unit, "hotspots": hotspots, "urgent_open": urgent_open}


def imports(limit=20):
    with tx() as c:
        return c.q("""SELECT i.*, p.title AS post_title FROM imports i
                      LEFT JOIN posts p ON p.id = i.post_id ORDER BY i.at DESC LIMIT ?""", (limit,))


# ---------------------------------------------------------------------------
# ส่งออก CSV (เปิดใน Excel ได้ภาษาไทยไม่เพี้ยน เพราะมี BOM)
# ---------------------------------------------------------------------------
def export_ops(f):
    """รายงานปฏิบัติการ (ภายใน) — มีชื่อและลิงก์ผู้แจ้ง"""
    _, rows = list_comments(f, "problems", limit=100000)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["เวลา", "ความเร่งด่วน", "หมวด", "ฝ่ายที่รับผิดชอบ", "สถานที่", "ข้อความ",
                "สถานะ", "หมายเหตุ", "ผู้แจ้ง", "ลิงก์โปรไฟล์", "ลิงก์คอมเมนต์", "โพสต์", "ตรวจทานแล้ว"])
    urg = dict(classifier.URGENCIES)
    for r in rows:
        w.writerow([r["ts"], urg.get(r["urgency"], ""), classifier.CATEGORY_NAME.get(r["category"], ""),
                    classifier.CATEGORY_DEPT.get(r["category"], ""), r["location"], r["text"],
                    r["status"], r["note"] or "", r["user_name"], r["user_homepage"], r["url"],
                    r["post_title"], "ใช่" if r["review"] == "confirmed" else "ยัง"])
    return "﻿" + out.getvalue()


def export_exec(f):
    """สรุปผู้บริหาร/เผยแพร่ — มีแต่ตัวเลขและพื้นที่ ไม่มีชื่อผู้แจ้ง"""
    s = stats(f)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["สรุปเรื่องแจ้งปัญหาจากคอมเมนต์ Facebook สำนักงานเขตทวีวัฒนา"])
    w.writerow(["ช่วงข้อมูล", f.get("from") or "ทั้งหมด", "ถึง", f.get("to") or "ปัจจุบัน"])
    w.writerow(["ออกรายงานเมื่อ", now()])
    w.writerow([])
    labels = {"total": "เรื่องทั้งหมด", "urgent_open": "เรื่องด่วนที่ยังไม่เสร็จ",
              "new": "เรื่องใหม่ (ยังไม่รับเรื่อง)", "in_progress": "กำลังดำเนินการ/ส่งต่อ",
              "done": "เสร็จสิ้น"}
    w.writerow(["ตัวเลขสรุป", "จำนวน"])
    for k, lab in labels.items():
        w.writerow([lab, s["summary"][k]])
    w.writerow([])
    w.writerow(["หมวดปัญหา", "ฝ่ายที่รับผิดชอบ", "จำนวน"])
    for k, name, dept in classifier.CATEGORIES:
        if s["by_category"].get(k):
            w.writerow([name, dept, s["by_category"][k]])
    w.writerow([])
    w.writerow(["ความเร่งด่วน", "จำนวน"])
    for k, name in classifier.URGENCIES:
        w.writerow([name, s["by_urgency"].get(k, 0)])
    w.writerow([])
    w.writerow(["สถานะ", "จำนวน"])
    for st in classifier.STATUSES:
        w.writerow([st, s["by_status"].get(st, 0)])
    w.writerow([])
    w.writerow(["พื้นที่ที่ถูกแจ้งบ่อย", "จำนวนเรื่อง", "จำนวนผู้แจ้ง", "เรื่องด่วน"])
    for h in s["hotspots"]:
        w.writerow([h["location"], h["n"], h["people"], h["urgent"]])
    w.writerow([])
    w.writerow([f"แนวโน้ม ({'รายชั่วโมง' if s['trend_unit'] == 'hour' else 'รายวัน'})", "จำนวน"])
    for k, n in s["trend"]:
        w.writerow([k + (":00" if s["trend_unit"] == "hour" else ""), n])
    return "﻿" + out.getvalue()
