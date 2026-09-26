"""จุดเข้าของ Vercel (Python serverless function) — ทุก /api/* ถูกส่งมาที่นี่"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.server import Handler  # noqa: E402


class handler(Handler):
    pass
