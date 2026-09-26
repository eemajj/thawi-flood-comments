"use strict";
// ---------------------------------------------------------------------------
// สถานะหลัก
// ---------------------------------------------------------------------------
const S = { role: null, meta: null, catName: {}, catDept: {}, urgName: {} };
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const view = () => $("#view");

const URG_ICON = { urgent: "🔴", normal: "🟡", request: "🟢" };
const REVIEW_TABS = [
  ["review", "รอตรวจทาน", "ระบบคัดว่าเป็นการแจ้งปัญหา — ยืนยัน แก้หมวด หรือตัดทิ้ง"],
  ["unmatched", "ไม่เข้าหมวด", "ระบบคัดว่าไม่ใช่ปัญหา (ให้กำลังใจ/คุยทั่วไป/ไม่เข้าเกณฑ์) — ไล่ดูกันเรื่องหลุด"],
  ["needs_view", "ต้องเปิดดู", "คอมเมนต์ไม่มีข้อความ อาจเป็นรูปหรือสติกเกอร์ — เปิดดูบน Facebook"],
  ["rejected", "ตัดทิ้งแล้ว", "เรื่องที่ตัดสินว่าไม่ใช่ปัญหา — ดึงกลับได้"],
];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeUrl(u) {
  return /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(u || "") ? u : "";
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3000);
}
function fmtTime(t) {
  if (!t) return "";
  let d, h;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(t)) {
    // เวลาระบบ (มีเขตเวลา) → แสดงเป็นเวลาไทย
    const x = new Date(t);
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(x).map(o => [o.type, o.value]));
    d = `${p.year}-${p.month}-${p.day}`; h = `${p.hour}:${p.minute}`;
  } else {
    [d, h] = t.replace("T", " ").split(" ");
  }
  const [y, m, dd] = d.split("-");
  return `${+dd}/${+m}/${+y + 543} ${(h || "").slice(0, 5)}`;
}

// ---------------------------------------------------------------------------
// ตัวกรองร่วม (โพสต์ + ช่วงวันที่) — จำไว้ในเบราว์เซอร์
// ---------------------------------------------------------------------------
function filters() {
  return { post: $("#fPost").value, from: $("#fFrom").value, to: $("#fTo").value };
}
function qs(obj) {
  return new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== "" && v != null)).toString();
}
function saveFilters() {
  try { localStorage.setItem("filters", JSON.stringify(filters())); } catch { /* ignore */ }
}
function loadFilters() {
  try {
    const f = JSON.parse(localStorage.getItem("filters") || "{}");
    $("#fFrom").value = f.from || ""; $("#fTo").value = f.to || "";
    return f;
  } catch { return {}; }
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// เข้าสู่ระบบ
// ---------------------------------------------------------------------------
let LOGIN_MODE = "login";
function showLogin(msg) {
  S.role = null;
  $("#app").hidden = true; $("#pending").hidden = true; $("#login").hidden = false;
  if (msg) $("#loginMsg").textContent = msg;
  setLoginMode(LOGIN_MODE);
}
function setLoginMode(mode) {
  LOGIN_MODE = mode;
  $("#nameRow").hidden = mode !== "signup";
  $("#pwRow").hidden = mode === "reset";
  $("#pw").autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("#loginBtn").textContent = { login: "เข้าสู่ระบบ", signup: "สมัครใช้งาน", reset: "ส่งลิงก์ตั้งรหัสผ่านใหม่" }[mode];
  $("#toSignup").hidden = mode === "signup"; $("#toLogin").hidden = mode === "login"; $("#toReset").hidden = mode !== "login";
  $("#loginErr").textContent = "";
}
$("#toSignup").addEventListener("click", e => { e.preventDefault(); setLoginMode("signup"); });
$("#toLogin").addEventListener("click", e => { e.preventDefault(); setLoginMode("login"); });
$("#toReset").addEventListener("click", e => { e.preventDefault(); setLoginMode("reset"); });
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("#loginErr").textContent = ""; $("#loginMsg").textContent = "";
  const email = $("#email").value.trim(), password = $("#pw").value;
  const btn = $("#loginBtn"); btn.disabled = true;
  try {
    if (LOGIN_MODE === "signup") {
      if (password.length < 8) throw new Error("รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร");
      const r = await api("/api/signup", { email, password, name: $("#name").value.trim() });
      if (r.needConfirm) { setLoginMode("login"); $("#loginMsg").textContent = "สมัครแล้ว — เปิดลิงก์ยืนยันในอีเมล แล้วกลับมาเข้าสู่ระบบ"; return; }
      return boot();
    }
    if (LOGIN_MODE === "reset") {
      await api("/api/reset", { email });
      setLoginMode("login"); $("#loginMsg").textContent = "ส่งลิงก์ไปที่อีเมลแล้ว เปิดลิงก์เพื่อตั้งรหัสผ่านใหม่";
      return;
    }
    await api("/api/login", { email, password });
    $("#pw").value = "";
    await boot();
  } catch (err) { $("#loginErr").textContent = err.message; }
  finally { btn.disabled = false; }
});
$$("[data-logout]").forEach(b => b.addEventListener("click", async () => { await api("/api/logout", {}); showLogin(); }));

async function boot() {
  const me = await api("/api/me");
  if (!me.role) return showLogin();
  if (me.role === "pending") {
    $("#login").hidden = true; $("#app").hidden = true; $("#pending").hidden = false;
    $("#pendingEmail").textContent = me.email;
    return;
  }
  S.me = me;
  await start(me.role);
}

async function start(role) {
  S.role = role;
  document.body.classList.toggle("viewer", role !== "admin");
  $("#roleLabel").textContent = `${S.me?.name || S.me?.email || ""} · ${role === "admin" ? "ผู้ดูแล" : "ผู้ดู"}`;
  $("#login").hidden = true; $("#pending").hidden = true; $("#app").hidden = false;
  await loadMeta();
  if (!location.hash || !PAGES[location.hash.slice(1).split("?")[0]]) location.hash = "#dashboard";
  route();
}

async function loadMeta() {
  S.meta = await api("/api/meta");
  S.catName = Object.fromEntries(S.meta.categories.map(c => [c.key, c.name]));
  S.catDept = Object.fromEntries(S.meta.categories.map(c => [c.key, c.dept]));
  S.urgName = Object.fromEntries(S.meta.urgencies.map(u => [u.key, u.name]));
  const sel = $("#fPost"), cur = sel.value || (loadFilters().post || "");
  sel.innerHTML = `<option value="">ทุกโพสต์</option>` + S.meta.posts.map(p =>
    `<option value="${esc(p.id)}">${esc(p.title)} (${p.problems || 0}/${p.n})</option>`).join("");
  sel.value = S.meta.posts.some(p => p.id === cur) ? cur : "";
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
const PAGES = { dashboard: renderDashboard, list: renderList, review: renderReview, posts: renderPosts, settings: renderSettings };
function route() {
  if (!S.role) return;
  let page = location.hash.slice(1).split("?")[0] || "dashboard";
  if (!PAGES[page] || (S.role !== "admin" && ["review", "posts", "settings"].includes(page))) page = "dashboard";
  $$("#nav a").forEach(a => a.classList.toggle("active", a.getAttribute("href") === "#" + page));
  $("#filters").hidden = page === "settings" || page === "posts";
  PAGES[page]().catch(e => { if (e.message !== "login") view().innerHTML = `<p class="error">${esc(e.message)}</p>`; });
  if (S.role === "admin") refreshBadge();
}
window.addEventListener("hashchange", route);
["#fPost", "#fFrom", "#fTo"].forEach(id => $(id).addEventListener("change", () => { saveFilters(); route(); }));
$$(".quick button").forEach(b => b.addEventListener("click", () => {
  const r = b.dataset.range, today = new Date();
  if (r === "") { $("#fFrom").value = ""; $("#fTo").value = ""; }
  else {
    const from = new Date(today);
    if (r !== "today") from.setDate(from.getDate() - (+r - 1));
    $("#fFrom").value = isoDate(from); $("#fTo").value = isoDate(today);
  }
  saveFilters(); route();
}));

async function refreshBadge() {
  try {
    const s = await api("/api/stats?" + qs(filters()));
    const n = s.summary.pending_review, b = $("#reviewBadge");
    b.textContent = n; b.hidden = !n;
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function hbars(entries, opts = {}) {
  const list = entries.filter(e => e.n > 0);
  if (!list.length) return `<p class="empty">ยังไม่มีข้อมูล</p>`;
  const max = Math.max(...list.map(e => e.n));
  return `<div class="hbars">` + list.map(e => `
    <a class="hbar" ${e.href ? `href="${e.href}"` : ""} style="text-decoration:none;color:inherit"
       data-tip="${esc(e.label)}: ${e.n} เรื่อง">
      <span class="name">${e.icon ? e.icon + " " : ""}${esc(e.label)}${e.sub ? `<small>${esc(e.sub)}</small>` : ""}</span>
      <span class="track"><span class="fill ${e.cls || ""}" style="display:block;width:${(e.n / max * 100).toFixed(1)}%"></span></span>
      <span class="n">${e.n}</span>
    </a>`).join("") + `</div>`;
}

function trendChart(trend, unit) {
  if (!trend.length) return `<p class="empty">ยังไม่มีข้อมูล</p>`;
  const W = 800, H = 220, pl = 32, pr = 8, pt = 10, pb = 28;
  const max = Math.max(1, ...trend.map(t => t[1]));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const bw = (W - pl - pr) / trend.length;
  const y = v => pt + (H - pt - pb) * (1 - v / top);
  let g = "";
  for (let v = 0; v <= top; v += step) {
    g += `<line class="gridline" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/>
          <text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  const labelEvery = Math.max(1, Math.ceil(trend.length / 8));
  const lab = k => unit === "hour" ? `${+k.slice(8, 10)}/${+k.slice(5, 7)} ${k.slice(11, 13)}:00` : `${+k.slice(8, 10)}/${+k.slice(5, 7)}`;
  const bars = trend.map(([k, n], i) => {
    const gap = Math.max(Math.min(2, bw * 0.15), (bw - 48) / 2);  // แท่งกว้างไม่เกิน 48
    const x = pl + i * bw, h = y(0) - y(n);
    const bwid = Math.max(1, bw - gap * 2);
    const r = Math.min(4, bwid / 2, h);
    const path = n ? `M${x + gap},${y(0)} v${-(h - r)} q0,${-r} ${r},${-r} h${bwid - 2 * r} q${r},0 ${r},${r} v${h - r} z` : "";
    return `<rect class="hit" x="${x}" y="${pt}" width="${bw}" height="${H - pt - pb}" data-tip="${esc(lab(k))} น. — ${n} เรื่อง"/>
      ${n ? `<path class="bar" d="${path}"/>` : ""}
      ${i % labelEvery === 0 ? `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(lab(k))}</text>` : ""}`;
  }).join("");
  return `<div class="trend"><svg viewBox="0 0 ${W} ${H}" role="img"
    aria-label="จำนวนเรื่องแจ้ง${unit === "hour" ? "รายชั่วโมง" : "รายวัน"}">${g}${bars}
    <line class="baseline" x1="${pl}" x2="${W - pr}" y1="${y(0)}" y2="${y(0)}"/></svg></div>`;
}
function niceStep(max) {
  const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  return Math.max(1, [1, 2, 5, 10].map(m => m * p).find(s => s >= raw) || 1);  // นับเป็นเรื่อง ไม่มีทศนิยม
}

async function renderDashboard() {
  const f = filters();
  const s = await api("/api/stats?" + qs(f));
  const m = s.summary;
  const listLink = extra => "#list?" + qs(extra);
  view().innerHTML = `
    <div class="section-head">
      <h2>ภาพรวม</h2>
      <div class="row">
        <button class="btn small" data-export="exec">⬇ สรุปผู้บริหาร (ไม่มีชื่อ)</button>
        <button class="btn small" data-export="ops">⬇ รายงานปฏิบัติการ (ภายใน)</button>
      </div>
    </div>
    <div class="kpis">
      <a class="kpi" href="${listLink({})}"><div class="v">${m.total}</div><div class="l">เรื่องทั้งหมด</div></a>
      <a class="kpi crit" href="${listLink({ urgency: "urgent", open: 1 })}"><div class="v">${m.urgent_open}</div><div class="l">🔴 เรื่องด่วนที่ยังไม่เสร็จ</div></a>
      <a class="kpi prog" href="${listLink({ status: "กำลังดำเนินการ" })}"><div class="v">${m.in_progress}</div><div class="l">กำลังดำเนินการ/ส่งต่อ</div></a>
      <a class="kpi done" href="${listLink({ status: "เสร็จสิ้น" })}"><div class="v">${m.done}</div><div class="l">✓ เสร็จสิ้น</div></a>
      <a class="kpi rev" href="${S.role === "admin" ? "#review" : "#dashboard"}"><div class="v">${m.pending_review}</div><div class="l">รอตรวจทาน</div></a>
    </div>
    <p class="muted small">จากคอมเมนต์ทั้งหมด ${m.all_comments} รายการ · เรื่องใหม่ที่ยังไม่รับเรื่อง ${m.new} เรื่อง
      ${m.pending_review ? " · ตัวเลขรวมเรื่องที่ระบบคัดอัตโนมัติแต่ยังไม่ได้ตรวจทาน" : ""}</p>

    <div class="grid g2">
      <div class="card">
        <h3>🔴 เรื่องด่วนที่ยังไม่ดำเนินการ</h3>
        ${s.urgent_open.length ? `<div class="tbl-wrap"><table><thead><tr><th>เวลา</th><th>สถานที่</th><th>ข้อความ</th><th>สถานะ</th></tr></thead><tbody>
          ${s.urgent_open.map(r => `<tr><td class="small">${fmtTime(r.ts)}</td><td>${esc(r.location || "-")}</td>
            <td>${esc(r.text).slice(0, 140)} ${safeUrl(r.url) ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">เปิด</a>` : ""}</td>
            <td><span class="st new">${esc(r.status)}</span></td></tr>`).join("")}
          </tbody></table></div>` : `<p class="empty">ไม่มีเรื่องด่วนค้าง 👍</p>`}
      </div>
      <div class="card">
        <h3>แนวโน้มการแจ้ง (${s.trend_unit === "hour" ? "รายชั่วโมง" : "รายวัน"})</h3>
        ${trendChart(s.trend, s.trend_unit)}
      </div>
      <div class="card">
        <h3>จำนวนเรื่องตามหมวดปัญหา</h3>
        ${hbars(S.meta.categories.map(c => ({ label: c.name, sub: c.dept, n: s.by_category[c.key] || 0, href: listLink({ category: c.key }) })))}
      </div>
      <div class="card">
        <h3>จำนวนเรื่องตามฝ่ายที่รับผิดชอบ</h3>
        ${hbars(Object.entries(s.by_dept).sort((a, b) => b[1] - a[1]).map(([d, n]) => ({ label: d, n, href: listLink({ dept: d }) })))}
      </div>
      <div class="card">
        <h3>ความเร่งด่วน</h3>
        ${hbars(S.meta.urgencies.map(u => ({ label: u.name, icon: URG_ICON[u.key], n: s.by_urgency[u.key] || 0, cls: u.key, href: listLink({ urgency: u.key }) })))}
        <h3 style="margin-top:1rem">สถานะเรื่อง</h3>
        ${hbars(S.meta.statuses.map(st => ({ label: st, n: s.by_status[st] || 0, href: listLink({ status: st }) })))}
      </div>
      <div class="card">
        <h3>จุดที่ถูกแจ้งบ่อย</h3>
        ${s.hotspots.length ? `<div class="tbl-wrap"><table><thead><tr><th>พื้นที่</th><th class="num">เรื่อง</th><th class="num">ผู้แจ้ง</th><th class="num">ด่วน</th><th>ล่าสุด</th></tr></thead><tbody>
          ${s.hotspots.map(h => `<tr><td><a href="${listLink({ q: h.location })}">${esc(h.location)}</a></td><td class="num">${h.n}</td>
            <td class="num">${h.people}</td><td class="num">${h.urgent ? "🔴 " + h.urgent : "-"}</td><td class="small">${fmtTime(h.last)}</td></tr>`).join("")}
          </tbody></table></div>` : `<p class="empty">ยังไม่มีข้อมูลสถานที่</p>`}
      </div>
    </div>`;
  $$("[data-export]").forEach(btn => btn.addEventListener("click", () =>
    exportReport(btn.dataset.export, f).catch(e => toast(e.message))));
}

// ---------------------------------------------------------------------------
// รายการปัญหา
// ---------------------------------------------------------------------------
function hashParams() {
  return Object.fromEntries(new URLSearchParams(location.hash.split("?")[1] || ""));
}
function opt(list, val, empty) {
  return (empty ? `<option value="">${esc(empty)}</option>` : "") +
    list.map(([k, n]) => `<option value="${esc(k)}" ${k === val ? "selected" : ""}>${esc(n)}</option>`).join("");
}
const catOpts = () => S.meta.categories.map(c => [c.key, c.name]);
const urgOpts = () => S.meta.urgencies.map(u => [u.key, `${URG_ICON[u.key]} ${u.name}`]);
const stOpts = () => S.meta.statuses.map(s => [s, s]);

async function renderList() {
  const p = hashParams();
  const depts = [...new Set(S.meta.categories.map(c => c.dept).filter(d => d !== "-"))];
  view().innerHTML = `
    <div class="section-head"><h2>รายการปัญหา</h2>
      <button class="btn small" id="expOps">⬇ ส่งออกรายการนี้ (CSV)</button></div>
    <div class="card row" style="margin-bottom:12px;align-items:flex-end">
      <label>ค้นหา<input id="lq" value="${esc(p.q || "")}" placeholder="ข้อความ / ซอย / ชื่อ"></label>
      <label>หมวด<select id="lcat">${opt(catOpts(), p.category, "ทุกหมวด")}</select></label>
      <label>ฝ่าย<select id="ldept">${opt(depts.map(d => [d, d]), p.dept, "ทุกฝ่าย")}</select></label>
      <label>ความเร่งด่วน<select id="lurg">${opt(urgOpts(), p.urgency, "ทั้งหมด")}</select></label>
      <label>สถานะ<select id="lst">${opt(stOpts(), p.status, "ทุกสถานะ")}</select></label>
      <label style="flex-direction:row;align-items:center;gap:.4rem"><input type="checkbox" id="lopen" ${p.open ? "checked" : ""}> ยังไม่เสร็จ</label>
    </div>
    <div id="lres"></div>`;
  const apply = () => {
    const np = { q: $("#lq").value.trim(), category: $("#lcat").value, dept: $("#ldept").value,
      urgency: $("#lurg").value, status: $("#lst").value, open: $("#lopen").checked ? 1 : "" };
    history.replaceState(null, "", "#list?" + qs(np));
    loadItems("problems", { ...filters(), ...np }, $("#lres"), 1);
    $("#expOps").onclick = () => exportReport("ops", { ...filters(), ...np }).catch(e => toast(e.message));
  };
  ["#lcat", "#ldept", "#lurg", "#lst", "#lopen"].forEach(id => $(id).addEventListener("change", apply));
  let t; $("#lq").addEventListener("input", () => { clearTimeout(t); t = setTimeout(apply, 350); });
  apply();
}

async function loadItems(viewName, f, box, page) {
  const d = await api(`/api/comments?${qs({ ...f, view: viewName, page })}`);
  const pages = Math.ceil(d.total / d.size);
  box.innerHTML = `<p class="muted small">${d.total} รายการ</p>` +
    (d.rows.length ? `<div class="items">${d.rows.map(r => itemHtml(r, viewName)).join("")}</div>` : `<p class="empty">ไม่มีรายการ</p>`) +
    (pages > 1 ? `<div class="pager"><button class="btn small" data-pg="${page - 1}" ${page <= 1 ? "disabled" : ""}>‹ ก่อนหน้า</button>
      <span>หน้า ${page}/${pages}</span><button class="btn small" data-pg="${page + 1}" ${page >= pages ? "disabled" : ""}>ถัดไป ›</button></div>` : "");
  $$("[data-pg]", box).forEach(b => b.addEventListener("click", () => loadItems(viewName, f, box, +b.dataset.pg)));
  bindItems(box, () => loadItems(viewName, f, box, page), viewName);
}

function itemHtml(r, viewName) {
  const admin = S.role === "admin";
  const link = safeUrl(r.url);
  const prof = safeUrl(r.user_homepage);
  const who = `${prof ? `<a href="${esc(prof)}" target="_blank" rel="noopener">${esc(r.user_name)}</a>` : esc(r.user_name)}`;
  const reviewMode = viewName !== "problems";
  const problem = r.is_problem && r.review !== "rejected";
  let editor = "";
  if (admin) {
    editor = `<div class="edit">
      <label>หมวด<select data-f="category">${opt(catOpts(), r.category || (reviewMode && !problem ? "" : "other"), reviewMode && !problem ? "— เลือกหมวด —" : "")}</select></label>
      <label>ความเร่งด่วน<select data-f="urgency">${opt(urgOpts(), r.urgency || "normal")}</select></label>
      <label>สถานที่<input data-f="location" value="${esc(r.location || "")}" placeholder="ซอย/ชุมชน/ถนน"></label>
      ${reviewMode ? "" : `<label>สถานะ<select data-f="status">${opt(stOpts(), r.status)}</select></label>
      <label>หมายเหตุ/การดำเนินการ<input data-f="note" value="${esc(r.note || "")}" placeholder="เช่น ส่งทีมสูบน้ำแล้ว"></label>`}
    </div>`;
  }
  let actions = "";
  if (admin && viewName === "problems") {
    actions = `<button class="btn small primary" data-act="save">บันทึก</button>
      <button class="btn small ghost" data-act="hist">ประวัติ</button>
      <button class="btn small ghost danger" data-act="reject">ไม่ใช่ปัญหา</button>`;
  } else if (admin && viewName === "review") {
    actions = `<button class="btn small primary" data-act="confirm">✓ ยืนยัน</button>
      <button class="btn small danger" data-act="reject">✗ ไม่ใช่ปัญหา</button>`;
  } else if (admin) {
    actions = `<button class="btn small primary" data-act="confirm">เป็นการแจ้งปัญหา</button>
      ${viewName === "rejected" ? "" : `<button class="btn small" data-act="reject">ไม่ใช่ปัญหา</button>`}`;
  }
  return `<article class="item ${problem && r.urgency === "urgent" ? "urgent" : ""}" data-id="${esc(r.id)}">
    <div class="meta">
      ${problem ? `<span class="u"><span class="dot ${esc(r.urgency)}"></span>${esc(S.urgName[r.urgency] || "")}</span>
        <strong>${esc(S.catName[r.category] || "")}</strong>
        ${viewName === "problems" ? `<span class="st ${r.status === "เสร็จสิ้น" ? "done" : r.status === "ใหม่" ? "new" : ""}">${esc(r.status || "")}</span>` : ""}` : ""}
      ${r.location ? `<span>📍 ${esc(r.location)}</span>` : ""}
      <span>${fmtTime(r.ts)}</span>
      <span>โดย ${who}</span>
      ${r.parent_id ? `<span class="chip">ตอบกลับ</span>` : ""}
      ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">เปิดคอมเมนต์ ↗</a>` : ""}
    </div>
    <div class="text ${r.text ? "" : "none"}">${r.text ? esc(r.text) : "(ไม่มีข้อความ — อาจเป็นรูปหรือสติกเกอร์ ต้องเปิดดู)"}</div>
    ${problem && viewName === "problems" && r.note && !admin ? `<div class="small">📝 ${esc(r.note)}</div>` : ""}
    ${r.matched && admin ? `<div class="kw">คำที่ตรง: ${esc(r.matched)}</div>` : ""}
    ${problem && viewName === "problems" ? `<div class="small muted">ฝ่าย: ${esc(S.catDept[r.category] || "-")}${r.review === "confirmed" ? " · ✓ ตรวจทานแล้ว" : " · ยังไม่ตรวจทาน"}</div>` : ""}
    ${editor}
    ${actions ? `<div class="actions">${actions}</div>` : ""}
  </article>`;
}

function bindItems(box, reload, viewName) {
  $$(".item", box).forEach(el => {
    const id = el.dataset.id;
    const vals = () => Object.fromEntries($$("[data-f]", el).map(i => [i.dataset.f, i.value.trim()]));
    $$("[data-act]", el).forEach(b => b.addEventListener("click", async () => {
      const act = b.dataset.act;
      try {
        if (act === "hist") return showHistory(id);
        let changes;
        if (act === "save") changes = { ...vals(), review: "confirmed" };
        if (act === "confirm") {
          changes = { ...vals(), is_problem: 1, review: "confirmed" };
          if (!changes.category) { toast("กรุณาเลือกหมวดก่อน"); return; }
        }
        if (act === "reject") changes = { is_problem: 0, review: "rejected" };
        b.disabled = true;
        await api("/api/comment", { id, changes });
        toast(act === "reject" ? "ตัดออกแล้ว" : "บันทึกแล้ว");
        if (viewName === "problems" && act === "save") { b.disabled = false; return; }
        el.style.opacity = ".35";
        setTimeout(reload, 250);
        refreshBadge();
      } catch (e) { b.disabled = false; toast(e.message); }
    }));
    // สถานะเปลี่ยนแล้วบันทึกทันที (ใช้บ่อยสุด)
    const st = $("[data-f=status]", el);
    if (st) st.addEventListener("change", async () => {
      try { await api("/api/comment", { id, changes: { status: st.value } }); toast(`สถานะ: ${st.value}`); }
      catch (e) { toast(e.message); }
    });
  });
}

async function showHistory(id) {
  const h = await api("/api/history?id=" + encodeURIComponent(id));
  const names = { is_problem: "เป็นปัญหา", category: "หมวด", urgency: "ความเร่งด่วน", location: "สถานที่", review: "ตรวจทาน", status: "สถานะ", note: "หมายเหตุ" };
  const show = (f, v) => f === "is_problem" ? (v === "true" ? "ใช่" : v === "false" ? "ไม่ใช่" : v) : f === "category" ? S.catName[v] || v : f === "urgency" ? S.urgName[v] || v : v;
  const d = $("#dlg");
  d.innerHTML = `<h3>ประวัติการแก้ไข</h3>${h.length ? `<div class="tbl-wrap"><table><thead><tr><th>เวลา</th><th>โดย</th><th>รายการ</th><th>จาก</th><th>เป็น</th></tr></thead><tbody>
    ${h.map(x => `<tr><td class="small">${fmtTime(x.at)}</td><td class="small">${esc(x.user_email || "-")}</td><td>${esc(names[x.field] || x.field)}</td><td>${esc(show(x.field, x.old_value) ?? "")}</td><td>${esc(show(x.field, x.new_value) ?? "")}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="empty">ยังไม่มีการแก้ไข</p>`}
    <div class="row" style="justify-content:flex-end;margin-top:1rem"><button class="btn" id="dlgClose">ปิด</button></div>`;
  d.showModal(); $("#dlgClose").onclick = () => d.close();
}

// ---------------------------------------------------------------------------
// ตรวจทาน
// ---------------------------------------------------------------------------
async function renderReview() {
  const p = hashParams();
  const tab = REVIEW_TABS.some(t => t[0] === p.tab) ? p.tab : "review";
  const info = REVIEW_TABS.find(t => t[0] === tab);
  view().innerHTML = `
    <div class="section-head"><h2>ตรวจทาน</h2>
      ${tab === "unmatched" || tab === "needs_view" ? `<button class="btn small" id="bulkReject">ทั้งหน้านี้ไม่ใช่ปัญหา</button>` : ""}</div>
    <div class="tabs">${REVIEW_TABS.map(t => `<button data-tab="${t[0]}" class="${t[0] === tab ? "active" : ""}">${t[1]}</button>`).join("")}</div>
    <p class="muted small">${info[2]}</p>
    <div id="rres"></div>`;
  $$("[data-tab]").forEach(b => b.addEventListener("click", () => { location.hash = "#review?tab=" + b.dataset.tab; }));
  await loadItems(tab, filters(), $("#rres"), 1);
  const bulk = $("#bulkReject");
  if (bulk) bulk.addEventListener("click", async () => {
    const ids = $$("#rres .item").map(e => e.dataset.id);
    if (!ids.length || !confirm(`ยืนยันว่า ${ids.length} รายการในหน้านี้ไม่ใช่การแจ้งปัญหา?`)) return;
    await api("/api/bulk", { ids, changes: { is_problem: 0, review: "rejected" } });
    toast("บันทึกแล้ว"); route();
  });
}

// ---------------------------------------------------------------------------
// โพสต์ที่ติดตาม + นำเข้า CSV (หลังบ้านสำหรับผู้ดูแล)
// ---------------------------------------------------------------------------
const KEEP_COLS = ["Comment ID", "Reply To Comment", "Comment", "Comment Time", "Like Count",
  "Reply Count", "Comment URL", "User ID", "User Name", "User Homepage"];  // ไม่ส่งรูปโปรไฟล์/เพศ (เก็บเท่าที่จำเป็น)
const CHUNK = 300;
const STALE_HOURS = 6;

function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim());
  if (!head.includes("Comment ID")) throw new Error("ไม่พบคอลัมน์ 'Comment ID' — ไฟล์นี้ไม่ใช่ CSV จาก Comments Exporter");
  return rows.slice(1).map(r => Object.fromEntries(KEEP_COLS.map(k => [k, r[head.indexOf(k)] ?? ""])));
}

async function importFile(file, post, progress) {
  const rows = parseCSV(await file.text());
  const batch = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sum = { total: 0, added: 0, duplicate: 0, warnings: [] };
  for (let i = 0; i < rows.length; i += CHUNK) {
    progress(`${file.name}: ${Math.min(i + CHUNK, rows.length)}/${rows.length} แถว…`);
    const r = await api("/api/import", { rows: rows.slice(i, i + CHUNK), filename: file.name, post, batch });
    sum.total += r.total; sum.added += r.added; sum.duplicate += r.duplicate;
    sum.warnings.push(...r.warnings);
  }
  sum.warnings = [...new Set(sum.warnings)];
  return sum;
}

async function runImport(files, post, box) {
  const out = [];
  box.innerHTML = `<p class="muted" id="impProg">กำลังนำเข้า…</p>`;
  for (const f of files) {
    try {
      const r = await importFile(f, post, t => { const p = $("#impProg", box); if (p) p.textContent = t; });
      out.push(`<p>✓ <strong>${esc(f.name)}</strong> — ทั้งหมด ${r.total} · <strong>เพิ่มใหม่ ${r.added}</strong> · ซ้ำ (ข้าม) ${r.duplicate}</p>` +
        r.warnings.map(w => `<p class="warn">⚠ ${esc(w)}</p>`).join(""));
    } catch (e) {
      if (e.message === "login") return;
      out.push(`<p class="error">✗ ${esc(f.name)}: ${esc(e.message)}</p>`);
    }
  }
  box.innerHTML = out.join("") + `<p><a class="btn small primary" href="#review">ไปตรวจทาน →</a></p>`;
  await loadMeta(); refreshBadge();
}

function hoursSince(t) {
  return t ? (Date.now() - new Date(t)) / 36e5 : null;
}
function agoText(h) {
  if (h == null) return "";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} นาทีที่แล้ว`;
  if (h < 48) return `${Math.round(h)} ชม.ที่แล้ว`;
  return `${Math.round(h / 24)} วันที่แล้ว`;
}

async function renderPosts() {
  const tab = hashParams().tab === "closed" ? "closed" : "active";
  const all = S.meta.posts;
  const list = all.filter(p => (tab === "active") === !!p.active);
  view().innerHTML = `
    <div class="section-head"><h2>โพสต์ที่ติดตาม</h2></div>
    <ol class="steps muted small">
      <li>เพิ่มลิงก์โพสต์ Facebook ที่ต้องติดตาม</li>
      <li>เปิดโพสต์ → กด extension <b>Comments Exporter</b> → Export เป็น CSV</li>
      <li>กด <b>นำเข้า CSV</b> ที่โพสต์นั้น (อัปโหลดซ้ำได้ ระบบเพิ่มเฉพาะคอมเมนต์ใหม่)</li>
    </ol>
    <div class="grid g2">
      <form class="card" id="addPost">
        <h3>+ เพิ่มโพสต์ใหม่</h3>
        <div class="formgrid">
          <label class="wide">ลิงก์โพสต์ Facebook<input id="apUrl" type="url" required placeholder="https://www.facebook.com/…/posts/…"></label>
          <label>ชื่อเรื่อง<input id="apTitle" maxlength="200" placeholder="เช่น ฝนตกหนัก 26 ก.ย. ช่วงบ่าย"></label>
          <label>หมายเหตุ<input id="apNote" maxlength="500" placeholder="เช่น โพสต์แจ้งจุดแจกกระสอบทราย"></label>
        </div>
        <div class="row" style="margin-top:.6rem"><button class="btn primary">เพิ่มโพสต์</button><span id="apErr" class="error"></span></div>
      </form>
      <div class="card">
        <h3>นำเข้าแบบไม่ระบุโพสต์</h3>
        <label class="drop" id="drop">
          <input type="file" id="files" accept=".csv,text/csv" multiple hidden>
          <strong>ลากไฟล์ CSV มาวาง หรือคลิกเลือกไฟล์</strong>
          <span class="muted small">ระบบจับคู่กับโพสต์ให้อัตโนมัติ ถ้าไม่พบจะสร้างโพสต์ใหม่</span>
        </label>
      </div>
    </div>
    <div id="impRes" class="card" style="margin-top:16px" hidden></div>
    <div class="tabs" style="margin-top:20px">
      <button data-ptab="active" class="${tab === "active" ? "active" : ""}">กำลังติดตาม (${all.filter(p => p.active).length})</button>
      <button data-ptab="closed" class="${tab === "closed" ? "active" : ""}">ปิดแล้ว (${all.filter(p => !p.active).length})</button>
    </div>
    <div class="items">${list.length ? list.map(postCard).join("") : `<p class="empty">${tab === "active" ? "ยังไม่มีโพสต์ — เพิ่มลิงก์โพสต์ด้านบน" : "ไม่มีโพสต์ที่ปิดแล้ว"}</p>`}</div>
    <div class="card" style="margin-top:16px"><h3>ประวัติการนำเข้า</h3><div id="impHist"><p class="muted">กำลังโหลด…</p></div></div>`;

  const res = $("#impRes");
  const show = () => { res.hidden = false; res.scrollIntoView({ behavior: "smooth", block: "nearest" }); return res; };
  const after = async () => { await loadMeta(); renderPosts(); };

  $$("[data-ptab]").forEach(b => b.addEventListener("click", () => { location.hash = "#posts?tab=" + b.dataset.ptab; }));
  $("#addPost").addEventListener("submit", async e => {
    e.preventDefault(); $("#apErr").textContent = "";
    try {
      await api("/api/post/add", { fb_url: $("#apUrl").value.trim(), title: $("#apTitle").value, note: $("#apNote").value });
      toast("เพิ่มโพสต์แล้ว"); after();
    } catch (err) { $("#apErr").textContent = err.message; }
  });
  const drop = $("#drop"), input = $("#files");
  const go = async (files, post) => { if (files.length) { await runImport([...files], post, show()); renderPostsKeepResult(); } };
  input.addEventListener("change", () => go(input.files, null));
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); go(e.dataTransfer.files, null); });

  $$(".post").forEach(el => {
    const id = el.dataset.id;
    const save = async changes => { await api("/api/post", { id, changes }); toast("บันทึกแล้ว"); };
    $("[data-pf=title]", el).addEventListener("change", e => save({ title: e.target.value }).then(loadMeta));
    $("[data-pf=note]", el).addEventListener("change", e => save({ note: e.target.value }));
    const fi = $("input[type=file]", el);
    $("[data-pa=import]", el).addEventListener("click", () => fi.click());
    fi.addEventListener("change", () => go(fi.files, id));
    el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", e => { e.preventDefault(); el.classList.remove("over"); go(e.dataTransfer.files, id); });
    $("[data-pa=toggle]", el).addEventListener("click", async () => { await save({ active: el.dataset.active === "1" ? 0 : 1 }); after(); });
    $("[data-pa=link]", el).addEventListener("click", async () => {
      const u = prompt("ลิงก์โพสต์ Facebook", el.dataset.url || "");
      if (u === null) return;
      try { await save({ fb_url: u.trim() }); after(); } catch (e) { toast(e.message); }
    });
    const del = $("[data-pa=delete]", el);
    if (del) del.addEventListener("click", async () => {
      if (!confirm("ลบโพสต์นี้ออกจากระบบ?")) return;
      try { await api("/api/post/delete", { id }); toast("ลบแล้ว"); after(); } catch (e) { toast(e.message); }
    });
  });
  loadImportHistory();

  // หลังนำเข้า: วาดรายการโพสต์ใหม่ แต่คงผลการนำเข้าไว้ให้เห็น
  async function renderPostsKeepResult() {
    const html = res.innerHTML;
    await renderPosts();
    const r = $("#impRes"); r.innerHTML = html; r.hidden = false;
  }
}

function postCard(p) {
  const link = safeUrl(p.fb_url) || safeUrl(p.url);
  const h = hoursSince(p.last_imported);
  const stale = p.active && (h == null || h > STALE_HOURS);
  return `<article class="item post ${p.urgent_open ? "urgent" : ""}" data-id="${esc(p.id)}" data-active="${p.active ? 1 : 0}" data-url="${esc(p.fb_url || p.url || "")}">
    <div class="row" style="align-items:center">
      <input class="title-input" data-pf="title" value="${esc(p.title)}" aria-label="ชื่อโพสต์">
      ${p.urgent_open ? `<span class="u"><span class="dot urgent"></span>ด่วนค้าง ${p.urgent_open}</span>` : ""}
      ${p.pending ? `<a class="chip" href="#review">รอตรวจ ${p.pending}</a>` : ""}
    </div>
    <div class="meta">
      <span>คอมเมนต์ ${p.n}</span><span>แจ้งปัญหา ${p.problems}</span>
      <span class="${stale ? "warn" : ""}">${p.last_imported ? `${stale ? "⚠ " : ""}นำเข้าล่าสุด ${agoText(h)}` : "⚠ ยังไม่เคยนำเข้า"}</span>
      ${p.last_comment ? `<span>คอมเมนต์ล่าสุด ${fmtTime(p.last_comment)}</span>` : ""}
      ${!p.fb_url && !p.url ? `<span class="warn">ยังไม่มีลิงก์</span>` : ""}
    </div>
    <input data-pf="note" value="${esc(p.note || "")}" placeholder="หมายเหตุ (ไม่บังคับ)" class="small">
    <div class="actions">
      <input type="file" accept=".csv,text/csv" multiple hidden>
      <button class="btn small primary" data-pa="import">⬆ นำเข้า CSV</button>
      ${link ? `<a class="btn small" href="${esc(link)}" target="_blank" rel="noopener">เปิดโพสต์ ↗</a>` : ""}
      <a class="btn small" href="#list" onclick="$('#fPost').value='${esc(p.id)}';saveFilters()">ดูรายการปัญหา</a>
      <button class="btn small ghost" data-pa="link">${p.fb_url ? "แก้ลิงก์" : "ใส่ลิงก์"}</button>
      <button class="btn small ghost" data-pa="toggle">${p.active ? "ปิดการติดตาม" : "ติดตามอีกครั้ง"}</button>
      ${p.n ? "" : `<button class="btn small ghost danger" data-pa="delete">ลบ</button>`}
    </div>
  </article>`;
}

async function loadImportHistory() {
  const hist = await api("/api/imports");
  const box = $("#impHist");
  if (!box) return;
  box.innerHTML = hist.length ? `<div class="tbl-wrap"><table><thead><tr><th>เวลา</th><th>โพสต์</th><th>ไฟล์</th><th class="num">เพิ่ม</th><th class="num">ซ้ำ</th></tr></thead><tbody>
    ${hist.map(h => `<tr><td class="small">${fmtTime(h.at)}</td><td>${esc(h.post_title || "-")}</td><td class="small" style="word-break:break-all">${esc(h.filename)}</td><td class="num">${h.added}</td><td class="num">${h.duplicate}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="empty">ยังไม่มีการนำเข้า</p>`;
}

// ---------------------------------------------------------------------------
// ตั้งค่า
// ---------------------------------------------------------------------------
async function renderSettings() {
  const kw = await api("/api/keywords");
  const groups = [
    ...S.meta.categories.filter(c => c.key !== "other").map(c => [`cat:${c.key}`, `หมวด: ${c.name}`, c.dept]),
    ["help", "คำขอความช่วยเหลือ/แจ้งเรื่องทั่วไป", "นับเป็นการแจ้งปัญหา แม้ไม่เข้าหมวดใด (จะอยู่หมวด อื่นๆ)"],
    ["praise", "คำให้กำลังใจ/ขอบคุณ", "ถ้ามีแต่คำกลุ่มนี้ จะไม่นับเป็นการแจ้งปัญหา"],
    ["urgent", "🔴 เกณฑ์ ด่วน", "อันตรายต่อชีวิต เช่น น้ำท่วมบ้าน ติดอยู่ ผู้ป่วย สายไฟขาด"],
    ["request", "🟢 เกณฑ์ สอบถาม/ขอรับบริการ", "เช่น ขอกระสอบทราย (ถ้าไม่ตรงเกณฑ์ด่วน)"],
    ["place", "ชื่อถนน/คลอง/สถานที่ในเขต", "ใช้ดึงสถานที่จากข้อความ (ซอย/ชุมชน/หมู่บ้าน ระบบดึงให้อัตโนมัติ)"],
  ];
  view().innerHTML = `
    <h2>ตั้งค่า keyword</h2>
    <p class="muted small">ใส่บรรทัดละ 1 คำ · ใส่คำที่คนพิมพ์ผิดบ่อยด้วย (เช่น ชอย, ท่วมสุง) · หลังบันทึก ระบบจะคัดกรองเรื่องที่ยังไม่ได้ตรวจทานใหม่ (เรื่องที่ตรวจทานแล้วไม่ถูกเปลี่ยน)</p>
    <div class="kwgrid">${groups.map(([k, name, hint]) => `
      <label class="card"><strong style="color:var(--ink)">${esc(name)}</strong><span class="small muted">${esc(hint)}</span>
        <textarea data-kw="${esc(k)}" spellcheck="false">${esc(kw[k] || "")}</textarea></label>`).join("")}</div>
    <div class="row" style="margin:12px 0 28px"><button class="btn primary" id="saveKw">บันทึกและคัดกรองใหม่</button></div>

    <div class="grid g2">
      <div class="card" style="grid-column:1/-1">
        <h3>ผู้ใช้งาน</h3>
        <p class="muted small">ผู้ใช้สมัครเองที่หน้าเข้าสู่ระบบ แล้วจะ "รออนุมัติ" จนกว่าผู้ดูแลกำหนดสิทธิ์ · ผู้ดู = อ่านอย่างเดียว · ผู้ดูแล = แก้ไข/นำเข้า/จัดการผู้ใช้</p>
        <div id="users"><p class="muted">กำลังโหลด…</p></div>
      </div>
      <div class="card">
        <h3>เปลี่ยนรหัสผ่านของฉัน</h3>
        <div class="row" style="align-items:flex-end">
          <label>รหัสผ่านใหม่<input id="pwNew" type="password" minlength="8" autocomplete="new-password"></label>
          <button class="btn" id="savePw">บันทึก</button>
        </div>
        <p class="muted small">อย่างน้อย 8 ตัวอักษร</p>
      </div>
      <div class="card">
        <h3>ลบข้อมูลส่วนบุคคล (PDPA)</h3>
        <p class="small muted">ลบชื่อ ลิงก์โปรไฟล์ และลิงก์คอมเมนต์ของผู้แจ้ง เมื่อจบสถานการณ์ · ตัวเลขสถิติ หมวด สถานที่ และข้อความยังอยู่ · ย้อนกลับไม่ได้</p>
        <div class="row" style="align-items:flex-end">
          <label>ลบเฉพาะคอมเมนต์ก่อนวันที่ (เว้นว่าง = ทั้งหมด)<input type="date" id="purgeBefore"></label>
          <button class="btn danger" id="purge">ลบข้อมูลส่วนบุคคล</button>
        </div>
      </div>
    </div>`;
  $("#saveKw").addEventListener("click", async () => {
    const data = Object.fromEntries($$("[data-kw]").map(t => [t.dataset.kw, t.value]));
    const r = await api("/api/keywords", { keywords: data, reclassify: true });
    toast(`บันทึกแล้ว · คัดกรองใหม่ ${r.reclassified} รายการ`); refreshBadge();
  });
  $("#savePw").addEventListener("click", async () => {
    try { await api("/api/password", { password: $("#pwNew").value }); $("#pwNew").value = ""; toast("เปลี่ยนรหัสผ่านแล้ว"); }
    catch (e) { toast(e.message); }
  });
  $("#purge").addEventListener("click", async () => {
    const b = $("#purgeBefore").value;
    if (!confirm(`ลบชื่อและลิงก์ผู้แจ้ง${b ? ` ของคอมเมนต์ก่อน ${b}` : " ทั้งหมด"}? ย้อนกลับไม่ได้`)) return;
    const r = await api("/api/purge", { before: b });
    toast(`ลบข้อมูลส่วนบุคคลแล้ว ${r.count} รายการ`);
  });
  loadUsers();
}

async function loadUsers() {
  const users = await api("/api/users");
  const roleOpts = [["admin", "ผู้ดูแล"], ["viewer", "ผู้ดู"], ["pending", "รออนุมัติ / ระงับ"]];
  $("#users").innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>ชื่อ</th><th>อีเมล</th><th>สมัครเมื่อ</th><th>สิทธิ์</th></tr></thead><tbody>
    ${users.map(u => `<tr class="${u.role === "pending" ? "pending-row" : ""}"><td>${esc(u.display_name || "-")}</td><td>${esc(u.email)}</td>
      <td class="small">${fmtTime(u.created_at)}</td>
      <td><select data-user="${esc(u.user_id)}" ${u.user_id === S.me?.id ? "" : ""}>${opt(roleOpts, u.role)}</select></td></tr>`).join("")}
    </tbody></table></div>`;
  $$("[data-user]").forEach(sel => sel.addEventListener("change", async () => {
    try { await api("/api/users", { user: sel.dataset.user, role: sel.value }); toast("บันทึกสิทธิ์แล้ว"); }
    catch (e) { toast(e.message); loadUsers(); }
  }));
}

// ---------------------------------------------------------------------------
// tooltip (hover บนกราฟ)
// ---------------------------------------------------------------------------
document.addEventListener("mousemove", e => {
  const el = e.target.closest?.("[data-tip]"), tip = $("#tooltip");
  if (!el) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip; tip.hidden = false;
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = x + "px"; tip.style.top = (e.clientY - 36) + "px";
});

// เริ่มต้น
(async () => {
  loadFilters();
  if (!CONFIGURED) {
    $("#login").hidden = false;
    $("#loginForm").innerHTML = `<h1>ยังไม่ได้ตั้งค่าระบบ</h1><p class="muted">ใส่ Supabase URL และ key ในไฟล์ <code>docs/static/config.js</code> ตามคู่มือใน README</p>`;
    return;
  }
  sb.auth.onAuthStateChange(async (event) => {
    if (event === "PASSWORD_RECOVERY") {
      const pw = prompt("ตั้งรหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)");
      if (pw) {
        try { await api("/api/password", { password: pw }); toast("ตั้งรหัสผ่านใหม่แล้ว"); boot(); }
        catch (e) { alert(e.message); }
      }
    }
  });
  try { await boot(); } catch (e) { if (e.message !== "login") showLogin(e.message); }
})();
