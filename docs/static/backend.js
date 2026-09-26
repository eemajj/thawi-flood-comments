"use strict";
// ---------------------------------------------------------------------------
// ชั้นเชื่อมต่อ Supabase — หน้าเว็บเรียก api("/api/...") แบบเดิม แล้วไฟล์นี้แปลงเป็นคำสั่ง Supabase
// สิทธิ์จริงถูกบังคับที่ฐานข้อมูล (Row Level Security) ไม่ใช่ที่หน้าเว็บ
// ---------------------------------------------------------------------------
const CFG = window.APP_CONFIG || {};
const CONFIGURED = !!(CFG.supabaseUrl && CFG.supabaseKey && window.supabase);
const sb = CONFIGURED ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;

const AUTH_ERR = {
  "Invalid login credentials": "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
  "Email not confirmed": "ยังไม่ได้ยืนยันอีเมล — เปิดลิงก์ในอีเมลที่ได้รับก่อน",
  "User already registered": "อีเมลนี้สมัครไว้แล้ว",
  "Password should be at least 6 characters.": "รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร",
};
function fail(error) {
  if (!error) return;
  const msg = error.message || String(error);
  if (/JWT|not authenticated|session/i.test(msg) && !/password/i.test(msg)) { showLogin(); throw new Error("login"); }
  throw new Error(AUTH_ERR[msg] || msg);
}
async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  fail(error);
  return data;
}

// ---------- ตัวช่วยนำเข้า ----------
const FB_URL_RE = /^https:\/\/([a-z0-9-]+\.)?(facebook\.com|fb\.com|fb\.watch|fb\.me)\//i;
function fbKeyFromUrl(url) {
  url = url || "";
  const m = url.match(/(pfbid[0-9A-Za-z]+)/);
  if (m) return m[1];
  for (const re of [/story_fbid=(\d+)/, /\/posts\/(\d+)/, /\/permalink\/(\d+)/, /[?&]fbid=(\d+)/,
                    /\/videos\/(\d+)/, /\/reel\/(\d+)/, /\/photos\/[^/]+\/(\d+)/]) {
    const k = url.match(re);
    if (k) return k[1];
  }
  return "";
}
// Comment ID เป็น base64 ของ "comment:<เลขโพสต์>_<เลขคอมเมนต์>"
function fbIdFrom(commentId, filename) {
  try {
    const raw = atob(commentId + "=".repeat((4 - commentId.length % 4) % 4));
    const m = raw.match(/^comment:(\d+)_/);
    if (m) return m[1];
  } catch { /* ignore */ }
  const m = (filename || "").match(/(\d{10,})/);
  return m ? m[1] : "unknown";
}
// "26/9/2569 12:59:58" (พ.ศ.) → "2026-09-26 12:59:58"
function parseTime(s) {
  const m = (s || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    let y = +m[3]; if (y > 2400) y -= 543;
    const p = n => String(n).padStart(2, "0");
    return `${y}-${p(m[2])}-${p(m[1])} ${p(m[4])}:${m[5]}:${m[6] || "00"}`;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(s || "") ? s.replace("T", " ").slice(0, 19) : "";
}
const toInt = v => parseInt(String(v || "0").replace(/,/g, ""), 10) || 0;

let KW_CACHE = null;
async function getKeywords(fresh) {
  if (KW_CACHE && !fresh) return KW_CACHE;
  const { data, error } = await sb.from("keywords").select("grp, words");
  fail(error);
  KW_CACHE = { ...DEFAULT_KEYWORDS, ...Object.fromEntries(data.map(r => [r.grp, r.words])) };
  return KW_CACHE;
}

// ---------- สถิติ: เติมชั่วโมงที่ไม่มีข้อมูล และเลือกรายชั่วโมง/รายวัน ----------
function buildTrend(hours) {
  if (!hours.length) return { trend: [], unit: "hour" };
  const d = k => new Date(k.slice(0, 10) + "T" + k.slice(11, 13) + ":00:00Z");
  const t0 = d(hours[0][0]), t1 = d(hours[hours.length - 1][0]);
  const unit = (t1 - t0) <= 72 * 36e5 ? "hour" : "day";
  const counts = {};
  for (const [k, n] of hours) { const key = unit === "hour" ? k : k.slice(0, 10); counts[key] = (counts[key] || 0) + n; }
  const trend = [];
  const cur = new Date(t0); if (unit === "day") cur.setUTCHours(0);
  const fmt = x => x.toISOString().slice(0, unit === "hour" ? 13 : 10).replace("T", " ");
  while (cur <= t1) { const k = fmt(cur); trend.push([k, counts[k] || 0]); cur.setUTCHours(cur.getUTCHours() + (unit === "hour" ? 1 : 24)); }
  return { trend, unit };
}
function statsFilter(f) {
  const out = { post: f.post || "", from: f.from || "", to: f.to || "", category: f.category || "",
                urgency: f.urgency || "", status: f.status || "", q: f.q || "", open: f.open || "" };
  if (f.dept) out.cats = CATEGORIES.filter(c => c[2] === f.dept).map(c => c[0]);
  return out;
}
async function getStats(f) {
  const s = await rpc("dashboard_stats", { f: statsFilter(f) });
  const { trend, unit } = buildTrend(s.hours || []);
  const by_dept = {};
  for (const [k, , d] of CATEGORIES) if (s.by_category[k]) by_dept[d] = (by_dept[d] || 0) + s.by_category[k];
  return { ...s, by_dept, trend, trend_unit: unit };
}

// ---------- ส่งออก CSV (มี BOM ให้ Excel อ่านไทยได้) ----------
function csvText(rows) {
  const cell = v => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "﻿" + rows.map(r => r.map(cell).join(",")).join("\r\n");
}
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function exportReport(type, f) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const urg = Object.fromEntries(URGENCIES);
  if (type === "ops") {
    const { rows } = await rpc("list_comments", { f: statsFilter(f), p_view: "problems", p_limit: 100000, p_offset: 0 });
    const out = [["เวลา", "ความเร่งด่วน", "หมวด", "ฝ่ายที่รับผิดชอบ", "สถานที่", "ข้อความ", "สถานะ", "หมายเหตุ",
                  "ผู้แจ้ง", "ลิงก์โปรไฟล์", "ลิงก์คอมเมนต์", "โพสต์", "ตรวจทานแล้ว"]];
    for (const r of rows) out.push([(r.ts || "").replace("T", " "), urg[r.urgency] || "", CATEGORY_NAME[r.category] || "",
      CATEGORY_DEPT[r.category] || "", r.location, r.text, r.status, r.note, r.user_name, r.user_homepage, r.url,
      r.post_title, r.review === "confirmed" ? "ใช่" : "ยัง"]);
    return download(`รายงานปฏิบัติการ-ภายใน-${stamp}.csv`, csvText(out));
  }
  const s = await getStats(f);
  const out = [["สรุปเรื่องแจ้งปัญหาจากคอมเมนต์ Facebook สำนักงานเขตทวีวัฒนา"],
    ["ช่วงข้อมูล", f.from || "ทั้งหมด", "ถึง", f.to || "ปัจจุบัน"], ["ออกรายงานเมื่อ", new Date().toLocaleString("th-TH")], [],
    ["ตัวเลขสรุป", "จำนวน"], ["เรื่องทั้งหมด", s.summary.total], ["เรื่องด่วนที่ยังไม่เสร็จ", s.summary.urgent_open],
    ["เรื่องใหม่ (ยังไม่รับเรื่อง)", s.summary.new], ["กำลังดำเนินการ/ส่งต่อ", s.summary.in_progress], ["เสร็จสิ้น", s.summary.done], [],
    ["หมวดปัญหา", "ฝ่ายที่รับผิดชอบ", "จำนวน"],
    ...CATEGORIES.filter(([k]) => s.by_category[k]).map(([k, n, d]) => [n, d, s.by_category[k]]), [],
    ["ความเร่งด่วน", "จำนวน"], ...URGENCIES.map(([k, n]) => [n, s.by_urgency[k] || 0]), [],
    ["สถานะ", "จำนวน"], ...STATUSES.map(st => [st, s.by_status[st] || 0]), [],
    ["พื้นที่ที่ถูกแจ้งบ่อย", "จำนวนเรื่อง", "จำนวนผู้แจ้ง", "เรื่องด่วน"], ...s.hotspots.map(h => [h.location, h.n, h.people, h.urgent]), [],
    [`แนวโน้ม (${s.trend_unit === "hour" ? "รายชั่วโมง" : "รายวัน"})`, "จำนวน"],
    ...s.trend.map(([k, n]) => [k + (s.trend_unit === "hour" ? ":00" : ""), n])];
  return download(`สรุปผู้บริหาร-${stamp}.csv`, csvText(out));
}

// ---------- จุดเดียวที่หน้าเว็บเรียก ----------
async function api(path, body) {
  if (!sb) throw new Error("ยังไม่ได้ตั้งค่า Supabase (docs/static/config.js)");
  const [p, query] = path.split("?");
  const q = Object.fromEntries(new URLSearchParams(query || ""));
  body = body || {};

  switch (p) {
    case "/api/me": {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return { role: null };
      const { data, error } = await sb.from("profiles").select("role, email, display_name").eq("user_id", session.user.id).maybeSingle();
      fail(error);
      return { role: data?.role || "pending", email: session.user.email, name: data?.display_name };
    }
    case "/api/login": {
      const { error } = await sb.auth.signInWithPassword({ email: body.email, password: body.password });
      fail(error);
      return api("/api/me");
    }
    case "/api/signup": {
      const { data, error } = await sb.auth.signUp({ email: body.email, password: body.password,
        options: { data: { display_name: body.name }, emailRedirectTo: location.origin + location.pathname } });
      fail(error);
      return { needConfirm: !data.session };
    }
    case "/api/reset": {
      const { error } = await sb.auth.resetPasswordForEmail(body.email, { redirectTo: location.origin + location.pathname });
      fail(error);
      return { ok: true };
    }
    case "/api/logout": await sb.auth.signOut(); return { ok: true };
    case "/api/password": {
      if ((body.password || "").length < 8) throw new Error("รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร");
      const { error } = await sb.auth.updateUser({ password: body.password });
      fail(error);
      return { ok: true };
    }
    case "/api/meta":
      return { categories: CATEGORIES.map(([key, name, dept]) => ({ key, name, dept })),
               urgencies: URGENCIES.map(([key, name]) => ({ key, name })), statuses: STATUSES,
               posts: await rpc("posts_overview") };
    case "/api/stats": return getStats(q);
    case "/api/comments": {
      const page = Math.max(+q.page || 1, 1), size = 100;
      const d = await rpc("list_comments", { f: statsFilter(q), p_view: q.view || "problems", p_limit: size, p_offset: (page - 1) * size });
      return { total: d.total, page, size, rows: d.rows };
    }
    case "/api/history": {
      const { data, error } = await sb.from("history").select("at, field, old_value, new_value, user_email")
        .eq("comment_id", q.id).order("id", { ascending: false });
      fail(error);
      return data;
    }
    case "/api/comment": {
      const ch = { ...body.changes };
      if ("is_problem" in ch) {
        ch.is_problem = [1, true, "1", "true"].includes(ch.is_problem);
        if (ch.is_problem) {
          const { data: old } = await sb.from("comments").select("status, category, urgency").eq("id", body.id).single();
          if (!("status" in ch)) ch.status = old?.status || "ใหม่";
          if (!ch.category) ch.category = old?.category || "other";
          if (!ch.urgency) ch.urgency = old?.urgency || "normal";
        }
      }
      const { data, error } = await sb.from("comments").update(ch).eq("id", body.id).select("id");
      fail(error);
      if (!data.length) throw new Error("บันทึกไม่ได้ (ไม่มีสิทธิ์ หรือไม่พบรายการ)");
      return { ok: true };
    }
    case "/api/bulk": {
      const ch = { ...body.changes, is_problem: [1, true, "1"].includes(body.changes.is_problem) };
      const { error } = await sb.from("comments").update(ch).in("id", body.ids.slice(0, 500));
      fail(error);
      return { ok: true };
    }
    case "/api/import": {
      const kw = await getKeywords();
      const rows = body.rows.filter(r => (r["Comment ID"] || "").trim()).map(r => {
        const id = r["Comment ID"].trim();
        const k = Classifier.classify(r["Comment"] || "", kw);
        const postUrl = (r["Comment URL"] || "").split("?")[0];
        return { id, fb_id: fbIdFrom(id, body.filename), post_url: postUrl, post_key: fbKeyFromUrl(postUrl),
          parent_id: (r["Reply To Comment"] || "").trim(), text: r["Comment"] || "", ts: parseTime(r["Comment Time"]),
          like_count: toInt(r["Like Count"]), reply_count: toInt(r["Reply Count"]), url: (r["Comment URL"] || "").trim(),
          user_id: r["User ID"] || "", user_name: r["User Name"] || "", user_homepage: r["User Homepage"] || "",
          auto_label: k.label, is_problem: !!k.is_problem, category: k.category, urgency: k.urgency,
          location: k.location, matched: k.matched };
      });
      return rpc("import_comments", { p_rows: rows, p_filename: body.filename || "", p_post: body.post || null, p_batch: body.batch || "" });
    }
    case "/api/imports": {
      const { data, error } = await sb.from("imports").select("*").order("at", { ascending: false }).limit(20);
      fail(error);
      const titles = Object.fromEntries((S.meta?.posts || []).map(x => [x.id, x.title]));
      return data.map(i => ({ ...i, post_title: (i.post_id || "").split(",").map(x => titles[x] || "").filter(Boolean).join(", ") }));
    }
    case "/api/post/add": {
      const url = (body.fb_url || "").trim();
      if (!FB_URL_RE.test(url)) throw new Error("ลิงก์ต้องเป็นลิงก์ Facebook (https://www.facebook.com/...)");
      const id = "p" + crypto.getRandomValues(new Uint32Array(2)).join("").slice(0, 10);
      const { error } = await sb.from("posts").insert({ id, fb_url: url, fb_key: fbKeyFromUrl(url) || null,
        title: (body.title || "").trim().slice(0, 200) || "โพสต์ใหม่", note: (body.note || "").trim().slice(0, 500) });
      if (error && /duplicate|unique/i.test(error.message)) throw new Error("โพสต์นี้มีในระบบแล้ว");
      fail(error);
      return { ok: true, id };
    }
    case "/api/post": {
      const ch = {};
      for (const k of ["title", "note"]) if (k in body.changes) ch[k] = String(body.changes[k] || "").trim().slice(0, 500);
      if ("active" in body.changes) ch.active = [1, true, "1"].includes(body.changes.active);
      if ("fb_url" in body.changes) {
        const url = String(body.changes.fb_url || "").trim();
        if (url && !FB_URL_RE.test(url)) throw new Error("ลิงก์ต้องเป็นลิงก์ Facebook");
        ch.fb_url = url || null; ch.fb_key = fbKeyFromUrl(url) || null;
      }
      const { data, error } = await sb.from("posts").update(ch).eq("id", body.id).select("id");
      if (error && /duplicate|unique/i.test(error.message)) throw new Error("ลิงก์นี้เป็นของโพสต์อื่นในระบบแล้ว");
      fail(error);
      if (!data.length) throw new Error("บันทึกไม่ได้ (ไม่มีสิทธิ์)");
      return { ok: true };
    }
    case "/api/post/delete": {
      const { error } = await sb.from("posts").delete().eq("id", body.id);
      if (error && /foreign key/i.test(error.message)) throw new Error("โพสต์นี้มีคอมเมนต์แล้ว ลบไม่ได้ (ใช้ปิดการติดตามแทน)");
      fail(error);
      return { ok: true };
    }
    case "/api/keywords": {
      if (!body.keywords) return getKeywords(true);
      const rows = Object.entries(body.keywords).filter(([g]) => g in DEFAULT_KEYWORDS)
        .map(([grp, words]) => ({ grp, words: Classifier.splitWords(words).join("\n") }));
      const { error } = await sb.from("keywords").upsert(rows);
      fail(error);
      const kw = await getKeywords(true);
      let n = 0;
      if (body.reclassify) {
        // คัดกรองใหม่เฉพาะเรื่องที่ยังไม่ได้ตรวจทาน
        for (let from = 0; ; from += 1000) {
          const { data, error: e2 } = await sb.from("comments").select("id, text").eq("review", "pending").order("id").range(from, from + 999);
          fail(e2);
          if (!data.length) break;
          const out = data.map(r => { const k = Classifier.classify(r.text || "", kw);
            return { id: r.id, auto_label: k.label, is_problem: !!k.is_problem, category: k.category,
                     urgency: k.urgency, location: k.location, matched: k.matched }; });
          n += await rpc("apply_classification", { p_rows: out });
          if (data.length < 1000) break;
        }
      }
      return { ok: true, reclassified: n };
    }
    case "/api/users": {
      if (body.user) { await rpc("set_user_role", { p_user: body.user, p_role: body.role }); return { ok: true }; }
      const { data, error } = await sb.from("profiles").select("*").order("created_at");
      fail(error);
      return data;
    }
    case "/api/purge": return { ok: true, count: await rpc("purge_personal", { p_before: body.before || null }) };
  }
  throw new Error("ไม่รู้จักคำสั่ง " + p);
}
