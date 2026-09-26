"""รันระบบในเครื่อง (ใช้ SQLite ไฟล์ data.sqlite3)

    python3 run_local.py                 พอร์ต 8000 เครื่องอื่นในวงแลนเข้าได้
    python3 run_local.py --port 8080 --local   เข้าได้เฉพาะเครื่องนี้
"""
import argparse
import socket
from http.server import ThreadingHTTPServer

from core import db
from core.server import Handler


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--local", action="store_true", help="เปิดให้เข้าได้เฉพาะเครื่องนี้")
    args = ap.parse_args()

    created = db.init()
    srv = ThreadingHTTPServer(("127.0.0.1" if args.local else "0.0.0.0", args.port), Handler)
    print("=" * 60)
    print(" ระบบสรุปคอมเมนต์แจ้งปัญหา — สำนักงานเขตทวีวัฒนา")
    print(" ฐานข้อมูล:", "Postgres (DATABASE_URL)" if db.PG else db.SQLITE_PATH)
    print("=" * 60)
    if created:
        print(" รันครั้งแรก: สร้างรหัสผ่านให้แล้ว (จดไว้ แล้วเปลี่ยนในหน้า ตั้งค่า)")
        for role, label in (("admin", "รหัสผู้ดูแล"), ("viewer", "รหัสผู้ดู  ")):
            if role in created:
                print(f"   {label} : {created[role]}")
        print("-" * 60)
    print(f" เปิดในเครื่องนี้ :  http://localhost:{args.port}")
    ip = lan_ip()
    if ip and not args.local:
        print(f" เครื่องอื่น/มือถือในวงแลนเดียวกัน :  http://{ip}:{args.port}")
    print(" ปิดระบบ: กด Ctrl+C")
    print("=" * 60)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nปิดระบบแล้ว")


if __name__ == "__main__":
    main()
