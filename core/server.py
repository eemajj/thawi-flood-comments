"""เว็บ API ของระบบสรุปคอมเมนต์แจ้งปัญหา

Handler ตัวเดียวใช้ได้ทั้ง
  - ในเครื่อง: python3 run_local.py (เสิร์ฟหน้าเว็บจาก public/ ด้วย)
  - Vercel:    api/index.py (หน้าเว็บเสิร์ฟจาก public/ โดย Vercel)
"""
import json
import os
import time
from http import cookies
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, quote, urlparse

from . import classifier, db

PUBLIC = os.path.join(db.ROOT, "public")
SESSION_HOURS = 12
MAX_BODY = 4 * 1024 * 1024  # Vercel รับได้ไม่เกิน 4.5MB ต่อคำขอ หน้าเว็บจึงส่ง CSV เป็นชุดเล็ก
FILTER_KEYS = ("post", "from", "to", "category", "urgency", "status", "dept", "q", "open")


class Handler(BaseHTTPRequestHandler):
    server_version = "ThawiComment/2.0"

    def log_message(self, fmt, *args):
        pass  # ไม่พิมพ์ log ทุกคำขอ (ไม่ให้ข้อมูลส่วนบุคคลไปอยู่ใน log)

    # ---------- helpers ----------
    def cookie(self, name):
        c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        return c[name].value if name in c else None

    def role(self):
        return db.read_token(self.cookie("sid"))

    def ip(self):
        fwd = self.headers.get("X-Forwarded-For", "")
        return fwd.split(",")[0].strip() or self.client_address[0]

    def https(self):
        return self.headers.get("X-Forwarded-Proto") == "https" or bool(os.environ.get("VERCEL"))

    def send(self, code, body, ctype="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False, default=str)
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def err(self, code, msg):
        self.send(code, {"error": msg})

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("ข้อมูลใหญ่เกินไป")
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def set_session(self, role):
        secure = "; Secure" if self.https() else ""
        return {"Set-Cookie": f"sid={db.make_token(role, SESSION_HOURS)}; HttpOnly; SameSite=Strict; "
                              f"Path=/; Max-Age={SESSION_HOURS * 3600}{secure}"}

    # ---------- GET ----------
    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        if not path.startswith("/api/"):
            return self.static(path)
        try:
            db.init()
            return self.api_get(path, parse_qs(u.query))
        except Exception as e:
            return self.err(500, f"เกิดข้อผิดพลาด: {e}")

    def api_get(self, path, qs):
        role = self.role()
        if path == "/api/me":
            return self.send(200, {"role": role})
        if not role:
            return self.err(401, "กรุณาเข้าสู่ระบบ")
        f = {k: qs.get(k, [""])[0] for k in FILTER_KEYS}

        if path == "/api/meta":
            return self.send(200, {
                "categories": [{"key": k, "name": n, "dept": d} for k, n, d in classifier.CATEGORIES],
                "urgencies": [{"key": k, "name": n} for k, n in classifier.URGENCIES],
                "statuses": classifier.STATUSES,
                "posts": db.posts(),
                "now": db.now(),
            })
        if path == "/api/stats":
            return self.send(200, db.stats(f))
        if path == "/api/comments":
            view = qs.get("view", ["problems"])[0]
            if role != "admin" and view != "problems":
                return self.err(403, "เฉพาะผู้ดูแล")
            try:
                page = max(int(qs.get("page", ["1"])[0] or 1), 1)
            except ValueError:
                page = 1
            size = 100
            total, rows = db.list_comments(f, view, size, (page - 1) * size)
            return self.send(200, {"total": total, "page": page, "size": size, "rows": rows})
        if path == "/api/history":
            return self.send(200, db.history(qs.get("id", [""])[0]))
        if path == "/api/export":
            kind = qs.get("type", ["exec"])[0]
            stamp = time.strftime("%Y%m%d-%H%M")
            if kind == "ops":
                data, name = db.export_ops(f), f"รายงานปฏิบัติการ-ภายใน-{stamp}.csv"
            else:
                data, name = db.export_exec(f), f"สรุปผู้บริหาร-{stamp}.csv"
            return self.send(200, data, "text/csv; charset=utf-8", {
                "Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})

        if role != "admin":
            return self.err(403, "เฉพาะผู้ดูแล")
        if path == "/api/keywords":
            return self.send(200, db.get_keywords())
        if path == "/api/imports":
            return self.send(200, db.imports())
        return self.err(404, "ไม่พบ")

    def static(self, path):
        name = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.normpath(os.path.join(PUBLIC, name))
        if not full.startswith(PUBLIC + os.sep) or not os.path.isfile(full):
            return self.err(404, "ไม่พบไฟล์")
        ctype = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
                 ".png": "image/png", ".ico": "image/x-icon"}.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as fh:
            self.send(200, fh.read(), ctype)

    # ---------- POST ----------
    def do_POST(self):
        path = urlparse(self.path).path
        # กัน CSRF: คำขอ POST ต้องมาจากหน้าเว็บของระบบเอง
        if self.headers.get("X-Requested-With") != "app":
            return self.err(403, "คำขอไม่ถูกต้อง")
        try:
            data = self.body()
        except (ValueError, json.JSONDecodeError) as e:
            return self.err(400, str(e))
        try:
            db.init()
            return self.api_post(path, data)
        except ValueError as e:
            return self.err(400, str(e))
        except Exception as e:  # แสดงข้อผิดพลาดให้ผู้ดูแลเห็น แทนที่จะเงียบ
            return self.err(500, f"เกิดข้อผิดพลาด: {e}")

    def api_post(self, path, data):
        if path == "/api/login":
            ip = self.ip()
            if db.login_blocked(ip):
                return self.err(429, "ใส่รหัสผิดหลายครั้ง กรุณารอ 5 นาที")
            role = db.check_pw(str(data.get("password", "")))
            if not role:
                db.login_failed(ip)
                return self.err(401, "รหัสผ่านไม่ถูกต้อง")
            return self.send(200, {"role": role}, headers=self.set_session(role))
        if path == "/api/logout":
            return self.send(200, {"ok": True}, headers={"Set-Cookie": "sid=; Path=/; Max-Age=0"})

        role = self.role()
        if not role:
            return self.err(401, "กรุณาเข้าสู่ระบบ")
        if role != "admin":
            return self.err(403, "ผู้ดูแก้ไขข้อมูลไม่ได้")

        if path == "/api/import":
            # หน้าเว็บอ่าน CSV แล้วส่งมาเป็นชุด ชุดละไม่กี่ร้อยแถว
            rows = data.get("rows")
            if not isinstance(rows, list):
                raise ValueError("รูปแบบข้อมูลไม่ถูกต้อง")
            return self.send(200, db.import_rows(rows, str(data.get("filename", "")),
                                                 data.get("post") or None, data.get("batch")))
        if path == "/api/comment":
            ok = db.update_comment(str(data.get("id", "")), data.get("changes", {}))
            return self.send(200 if ok else 404, {"ok": ok})
        if path == "/api/bulk":
            for cid in data.get("ids", [])[:500]:
                db.update_comment(str(cid), data.get("changes", {}))
            return self.send(200, {"ok": True})
        if path == "/api/keywords":
            db.save_keywords(data.get("keywords", {}))
            n = db.reclassify(only_pending=True) if data.get("reclassify") else 0
            return self.send(200, {"ok": True, "reclassified": n})
        if path == "/api/post/add":
            pid = db.add_post(data.get("fb_url"), data.get("title"), data.get("note", ""))
            return self.send(200, {"ok": True, "id": pid})
        if path == "/api/post":
            db.update_post(str(data.get("id", "")), data.get("changes", {}))
            return self.send(200, {"ok": True})
        if path == "/api/post/delete":
            db.delete_post(str(data.get("id", "")))
            return self.send(200, {"ok": True})
        if path == "/api/password":
            role_ = data.get("role")
            pw = str(data.get("password", ""))
            if role_ not in ("admin", "viewer") or len(pw) < 6:
                raise ValueError("รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร")
            db.set_pw(role_, pw)
            # token เดิมของสิทธิ์นั้นใช้ไม่ได้ทันที — ออก cookie ใหม่ให้ผู้ดูแลที่กำลังเปลี่ยน
            return self.send(200, {"ok": True}, headers=self.set_session("admin"))
        if path == "/api/purge":
            return self.send(200, {"ok": True, "count": db.purge_personal(data.get("before") or None)})
        return self.err(404, "ไม่พบ")
