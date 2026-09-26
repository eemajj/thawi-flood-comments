"use strict";
// ตัวคัดกรองคอมเมนต์ด้วย keyword — ทำงานในเบราว์เซอร์ ไม่ส่งข้อความไปที่ไหน
// keyword เริ่มต้นอยู่ใน DEFAULT_KEYWORDS ผู้ดูแลแก้ได้ในหน้า "ตั้งค่า" (เก็บในตาราง keywords)
//
// ผลลัพธ์ label: problem | not_problem | unmatched | needs_view
//   needs_view  = ไม่มีข้อความ (อาจเป็นรูป/สติกเกอร์) ต้องเปิดดูเอง
//   problem     = แจ้งปัญหา/ขอความช่วยเหลือ
//   not_problem = ให้กำลังใจ/ขอบคุณ/คุยทั่วไป
//   unmatched   = ไม่เข้าเกณฑ์ใดเลย (ผู้ดูแลควรไล่ดู กันเรื่องหลุด)
//
// กลุ่ม keyword:
//   cat:<key> = คำที่บ่งบอกหมวดนั้น
//   help      = คำขอความช่วยเหลือ/แจ้งเรื่องทั่วไป (นับเป็นแจ้งปัญหา แม้ไม่เข้าหมวด)
//   praise    = คำให้กำลังใจ/ขอบคุณ (ไม่นับเป็นแจ้งปัญหา ถ้าไม่มีคำอื่น)
//   urgent    = เกณฑ์ "ด่วน" · request = เกณฑ์ "สอบถาม/ขอรับบริการ"
//   place     = ชื่อถนน/คลอง/สถานที่ในเขต (ใช้ดึงสถานที่)
// คำที่พิมพ์ผิดบ่อยใส่ไว้ด้วย เช่น ชอย (ซอย), สุง (สูง)
const CATEGORIES = [
 [
  "flood",
  "น้ำท่วมและการระบายน้ำ",
  "ฝ่ายโยธา / ฝ่ายปกครอง"
 ],
 [
  "waste",
  "ขยะและความสะอาด",
  "ฝ่ายรักษาความสะอาดและสวนสาธารณะ"
 ],
 [
  "tree",
  "ต้นไม้และสวนสาธารณะ",
  "ฝ่ายรักษาความสะอาดและสวนสาธารณะ"
 ],
 [
  "road",
  "ถนน ทางเท้า และไฟส่องสว่าง",
  "ฝ่ายโยธา"
 ],
 [
  "building",
  "อาคารและการก่อสร้าง",
  "ฝ่ายโยธา (งานควบคุมอาคาร)"
 ],
 [
  "sidewalk",
  "การใช้ทางเท้าและความเป็นระเบียบ",
  "ฝ่ายเทศกิจ"
 ],
 [
  "nuisance",
  "เหตุรำคาญและสิ่งแวดล้อม",
  "ฝ่ายสิ่งแวดล้อมและสุขาภิบาล"
 ],
 [
  "animal",
  "สัตว์และพาหะนำโรค",
  "ฝ่ายสิ่งแวดล้อมและสุขาภิบาล"
 ],
 [
  "safety",
  "ความปลอดภัยและความสงบเรียบร้อย",
  "ฝ่ายปกครอง"
 ],
 [
  "welfare",
  "สวัสดิการและชุมชน",
  "ฝ่ายพัฒนาชุมชนและสวัสดิการสังคม"
 ],
 [
  "service",
  "บริการของสำนักงานเขต",
  "ฝ่ายทะเบียน / รายได้ / การคลัง / การศึกษา"
 ],
 [
  "external",
  "นอกอำนาจหน้าที่ (ส่งต่อ)",
  "กฟน. / กปน. / ตำรวจจราจร / สำนักการระบายน้ำ"
 ],
 [
  "other",
  "อื่นๆ",
  "-"
 ]
];
const URGENCIES = [
 [
  "urgent",
  "ด่วน"
 ],
 [
  "normal",
  "ปกติ"
 ],
 [
  "request",
  "สอบถาม/ขอรับบริการ"
 ]
];
const STATUSES = [
 "ใหม่",
 "รับเรื่อง",
 "กำลังดำเนินการ",
 "ส่งต่อหน่วยงาน",
 "เสร็จสิ้น"
];
const SOI_ROADS = [
 "ทวีวัฒนา",
 "พุทธมณฑลสาย 2",
 "พุทธมณฑลสาย 3",
 "พุทธมณฑลสาย 4",
 "ศาลาธรรมสพน์",
 "ฉิมพลี",
 "บรมราชชนนี",
 "อุทยาน",
 "อักษะ",
 "สวนผัก",
 "กาญจนาภิเษก"
];
const DEFAULT_KEYWORDS = {
 "cat:flood": "น้ำท่วม\nท่วม\nน้ำขัง\nน้ำรอการระบาย\nระบายน้ำ\nระบายไม่ทัน\nน้ำไม่ลง\nน้ำไม่ไหล\nน้ำเอ่อ\nน้ำล้น\nล้นตลิ่ง\nปริ่ม\nเขื่อน\nคันกั้นน้ำ\nน้ำในคลอง\nคลองเต็ม\nท่อระบาย\nท่อตัน\nท่ออุดตัน\nลอกท่อ\nลอกคลอง\nผักตบ\nประตูระบายน้ำ\nสูบน้ำ\nเครื่องสูบ\nกระสอบทราย\nถุงทราย\nบ่อพัก\nฝาท่อ",
 "cat:waste": "ขยะ\nไม่มาเก็บ\nไม่เก็บขยะ\nรถขยะ\nเก็บขยะ\nถังขยะ\nทิ้งขยะ\nกองขยะ\nสกปรก\nกวาดถนน\nซากสัตว์\nขยะชิ้นใหญ่",
 "cat:tree": "ต้นไม้\nกิ่งไม้\nตัดกิ่ง\nตัดต้นไม้\nต้นไม้ล้ม\nต้นไม้หัก\nไม้ล้ม\nหญ้ารก\nหญ้าขึ้น\nตัดหญ้า\nสวนสาธารณะ\nสวนหย่อม\nรกร้าง",
 "cat:road": "ถนนพัง\nถนนชำรุด\nถนนทรุด\nถนนเป็นหลุม\nหลุม\nบ่อ\nทรุด\nผิวถนน\nทางเท้าชำรุด\nทางเท้าพัง\nฟุตบาท\nไฟดับ\nไฟทาง\nไฟส่องสว่าง\nเสาไฟ\nไฟฟ้าส่องสว่าง\nมืด\nสะพาน\nลูกระนาด\nป้ายชื่อซอย\nกระจกโค้ง",
 "cat:building": "ก่อสร้าง\nสร้างผิด\nต่อเติม\nไม่มีใบอนุญาต\nรุกล้ำ\nรุกคลอง\nอาคารทรุด\nอาคารร้าง\nป้ายโฆษณา\nนั่งร้าน\nตึกร้าง",
 "cat:sidewalk": "หาบเร่\nแผงลอย\nขายของบนทางเท้า\nวางของ\nจอดรถบนทางเท้า\nจอดขวาง\nกีดขวาง\nขวางทาง\nป้ายผิดกฎหมาย\nรุกทางเท้า\nร้านค้ารุก",
 "cat:nuisance": "เสียงดัง\nเหม็น\nกลิ่น\nควัน\nฝุ่น\nเผาขยะ\nเผา\nน้ำเสีย\nคลองเน่า\nน้ำเน่า\nมลพิษ\nฝุ่นละออง\npm2.5\nเหตุรำคาญ\nร้านอาหารส่งกลิ่น",
 "cat:animal": "ยุง\nลูกน้ำ\nหนู\nแมลงสาบ\nงู\nตะขาบ\nตัวเงินตัวทอง\nสุนัขจรจัด\nหมาจร\nหมากัด\nแมวจร\nไข้เลือดออก\nพ่นยุง\nพ่นหมอกควัน\nสัตว์มีพิษ\nตะกวด",
 "cat:safety": "ขโมย\nลักทรัพย์\nยาเสพติด\nมั่วสุม\nทะเลาะ\nอันตราย\nไม่ปลอดภัย\nเด็กแว้น\nแข่งรถ\nซิ่ง\nปล้น\nวิ่งราว\nคนเมา\nคนแปลกหน้า",
 "cat:welfare": "ถุงยังชีพ\nอาหาร\nน้ำดื่ม\nของแจก\nช่วยเหลือเยียวยา\nเยียวยา\nผู้สูงอายุ\nผู้พิการ\nคนพิการ\nติดเตียง\nคนไร้บ้าน\nเบี้ยยังชีพ\nศูนย์พักพิง\nอพยพ\nที่พักชั่วคราว\nชุมชน",
 "cat:service": "ทะเบียนราษฎร์\nบัตรประชาชน\nย้ายทะเบียน\nทะเบียนบ้าน\nภาษี\nภาษีที่ดิน\nค่าธรรมเนียม\nโรงเรียน\nคิว\nเจ้าหน้าที่ไม่\nบริการ\nเอกสาร\nจดทะเบียน",
 "cat:external": "ไฟฟ้าดับ\nไฟดับทั้งซอย\nหม้อแปลง\nการไฟฟ้า\nกฟน\nสายไฟ\nสายสื่อสาร\nสายเคเบิล\nสายไฟห้อย\nน้ำประปา\nประปาไม่ไหล\nท่อประปาแตก\nท่อแตก\nกปน\nการประปา\nรถติด\nจราจร\nสัญญาณไฟจราจร\nตำรวจ",
 "help": "ช่วยด้วย\nช่วยหน่อย\nช่วยดู\nช่วยมา\nช่วยเข้ามา\nช่วยแก้\nช่วยจัดการ\nช่วยตรวจสอบ\nรบกวน\nฝากด้วย\nฝากดู\nฝากตรวจสอบ\nแจ้งปัญหา\nแจ้งเรื่อง\nร้องเรียน\nเมื่อไหร่จะ\nเมื่อไรจะ\nไม่มีใครมา\nยังไม่มีใคร\nทำไมไม่\nขอความช่วยเหลือ\nขอให้\nอยากให้\nเดือดร้อน\nลำบาก\nแย่มาก\nหนักมาก",
 "praise": "ขอบคุณ\nขอบใจ\nเป็นกำลังใจ\nให้กำลังใจ\nกำลังใจ\nสู้ๆ\nสู้ ๆ\nเหนื่อยหน่อย\nดูแลสุขภาพ\nขอให้ปลอดภัย\nเก่งมาก\nชื่นชม\nปรบมือ\nยอดเยี่ยม\nเยี่ยม\nขอบพระคุณ\nthank",
 "urgent": "ท่วมบ้าน\nเข้าบ้าน\nน้ำเข้าบ้าน\nท่วมสูง\nท่วมสุง\nท่วมหนัก\nท่วมมิด\nท่วมถึงเอว\nท่วมถึงเข่า\nท่วมเข่า\nท่วมเอว\nสูงมาก\nสุงมาก\nติดอยู่\nติดค้าง\nออกไม่ได้\nออกจากบ้านไม่ได้\nติดเตียง\nผู้ป่วย\nคนป่วย\nป่วยหนัก\nหายใจไม่ออก\nคนแก่\nผู้สูงอายุ\nเด็กเล็ก\nทารก\nคนท้อง\nตั้งครรภ์\nสายไฟขาด\nสายไฟตก\nไฟรั่ว\nไฟช็อต\nไฟดูด\nจมน้ำ\nช่วยด้วย\nด่วน\nฉุกเฉิน\nอันตราย\nต้นไม้ล้มทับ\nล้มทับ\nบาดเจ็บ\nงูเข้าบ้าน",
 "request": "กระสอบทราย\nถุงทราย\nขอรับ\nขอทราบ\nสอบถาม\nแจกไหม\nแจกบ้างไหม\nแจกที่ไหน\nรับได้ที่ไหน\nที่ไหน\nยังไง\nอย่างไร\nเมื่อไหร่\nไหมคะ\nไหมครับ\nมั้ย\nบ้างไหม\nได้ไหม",
 "place": "ทวีวัฒนา\nพุทธมณฑลสาย 2\nพุทธมณฑลสาย 3\nพุทธมณฑลสาย 4\nบรมราชชนนี\nศาลาธรรมสพน์\nศาลาธรรมสพ\nฉิมพลี\nอักษะ\nอุทยาน\nกาญจนาภิเษก\nสวนผัก\nทวีวัฒนา-กาญจนาภิเษก\nคลองทวีวัฒนา\nคลองมหาสวัสดิ์\nคลองบางพรม\nคลองบางเชือกหนัง\nคลองขุนศรี\nคลองนราภิรมย์\nหนองแขม"
};
const CATEGORY_NAME = Object.fromEntries(CATEGORIES.map(([k, n]) => [k, n]));
const CATEGORY_DEPT = Object.fromEntries(CATEGORIES.map(([k, , d]) => [k, d]));

const Classifier = (() => {
  const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
  const thaiDigits = s => s.replace(/[๐-๙]/g, ch => String(THAI_DIGITS.indexOf(ch)));
  const stripZW = s => s.replace(/[​‌‍﻿]/g, "");
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");

  function splitWords(raw) {
    const out = [];
    for (const part of (raw || "").split(/[\n,]/)) {
      const w = part.trim();
      if (w && !out.includes(w)) out.push(w);
    }
    return out;
  }
  function normalize(text) {
    return thaiDigits(stripZW(text || "")).toLowerCase().replace(/\s+/g, " ").trim();
  }
  const match = (words, text) => words.filter(w => text.includes(normalize(w)));
  // ให้ "พุทธมณฑลสาย 2" ตรงกับ "พุทธมณฑลสาย2" ด้วย
  const roadPattern = road => [...road.replace(/ /g, "")].map(reEsc).join("\\s*");
  const byLenDesc = arr => [...arr].sort((a, b) => b.length - a.length);

  function canonRoad(matched, roads) {
    const flat = matched.replace(/ /g, "");
    return roads.find(r => r.replace(/ /g, "") === flat) || matched;
  }

  function extractLocation(raw, places) {
    const text = thaiDigits(stripZW(raw || ""));
    let found = [];
    const add = s => {
      s = s.replace(/\s+/g, " ").replace(/^[ .,\-]+|[ .,\-]+$/g, "");
      if (s && !found.some(f => f.includes(s))) {
        found = found.filter(f => !s.includes(f));
        found.push(s);
      }
    };
    const roads = byLenDesc([...new Set([...SOI_ROADS, ...places.filter(p => !p.startsWith("คลอง"))])]);
    const roadRe = roads.length ? roads.map(roadPattern).join("|") : "(?!)";
    const soiMark = "(?:ซอย|ชอย|ซ\\s*\\.|ซ(?=\\s*\\d))";

    // 1) ถนน + ซอย + เลข เช่น "ทวีวัฒนา ซ.9", "ทวีวัฒนา 13", "ซ.ทวีวัฒนา13", "ชอยทวีวัฒนา13"
    const re1 = new RegExp(`(?:${soiMark}\\s*)?(${roadRe})\\s*(?:${soiMark}\\s*)?(\\d{1,3}(?:\\s*/\\s*\\d{1,3})?)(?!\\d)`, "g");
    for (const m of text.matchAll(re1)) {
      const road = canonRoad(m[1], roads);
      // "พุทธมณฑลสาย 2" เลขเป็นส่วนของชื่อถนน ไม่ใช่ซอย
      if (road.startsWith("พุทธมณฑลสาย") && !new RegExp(soiMark).test(m[0])) continue;
      add(`${road} ซ.${m[2].replace(/ /g, "")}`);
    }
    // 2) ซอย + เลข/ชื่อ ที่ไม่ได้ขึ้นต้นด้วยถนนที่รู้จัก
    //    (ชื่อซอยต้องติดกับคำว่าซอย เพื่อไม่ให้ "ทั้งซอย มืดมาก" กลายเป็นชื่อซอย)
    const re2 = new RegExp(`${soiMark}(?:\\s*(\\d{1,3}(?:/\\d{1,3})?)|([ก-๙A-Za-z][ก-๙A-Za-z0-9]{1,24}))`, "g");
    const startsRoad = new RegExp(`^(?:${roadRe})`);
    for (const m of text.matchAll(re2)) {
      let val = m[1] || m[2];
      if (startsRoad.test(val)) continue;
      val = val.split(/(?:ท่วม|น้ำ|ริม|ด้าน|ตรง|หน้า|ตอนนี้|ค่ะ|ครับ|คะ|นะ)/)[0];
      if (val) add(`ซ.${val}`);
    }
    // 3) ชุมชน / หมู่บ้าน / ถนน / แยก + ชื่อ
    for (const [prefix, label] of [["ชุมชน", "ชุมชน"], ["หมู่บ้าน", "หมู่บ้าน"], ["มบ\\.", "หมู่บ้าน"],
                                   ["ถนน", "ถ."], ["ถ\\.", "ถ."], ["แยก", "แยก"]]) {
      for (const m of text.matchAll(new RegExp(`${prefix}\\s*([ก-๙A-Za-z0-9][ก-๙A-Za-z0-9\\-]{1,30})`, "g"))) {
        const val = m[1].split(/(?:ท่วม|น้ำขัง|ริม|ด้าน|ตรง|ตอนนี้|ค่ะ|ครับ|คะ|นะ|มี|ไม่)/)[0];
        if (val.length >= 2) add(`${label}${val}`);
      }
    }
    // 4) สถานที่ที่รู้จัก (คลอง ฯลฯ) ถ้ายังไม่ได้อะไรที่เฉพาะเจาะจงกว่า
    const norm = normalize(text).replace(/ /g, "");
    for (const p of byLenDesc(places)) {
      const flat = p.replace(/ /g, "");
      if (norm.includes(normalize(p).replace(/ /g, "")) && !found.some(f => f.replace(/ /g, "").includes(flat))) add(p);
    }
    return found.slice(0, 3).join(", ");
  }

  function classify(text, keywords) {
    const kw = keywords || DEFAULT_KEYWORDS;
    const norm = normalize(text);
    const result = { label: "unmatched", is_problem: 0, category: "", urgency: "", location: "", matched: "" };
    if (!norm || !/[ก-๙a-z0-9]/.test(norm)) { result.label = "needs_view"; return result; }

    const scores = {};
    let matched = [];
    for (const [key] of CATEGORIES) {
      const hits = match(splitWords(kw[`cat:${key}`]), norm);
      if (hits.length) {
        // คำยาวให้น้ำหนักมากกว่า (เฉพาะเจาะจงกว่า)
        scores[key] = hits.reduce((s, h) => s + 1 + h.length / 10, 0);
        matched.push(...hits);
      }
    }
    const helpHits = match(splitWords(kw.help), norm);
    const praiseHits = match(splitWords(kw.praise), norm);
    const urgentHits = match(splitWords(kw.urgent), norm);
    const requestHits = match(splitWords(kw.request), norm);
    const location = extractLocation(text, splitWords(kw.place));

    // "ชุมชน" อย่างเดียวบ่งบอกสถานที่ ไม่ใช่เรื่องสวัสดิการ
    const keys = Object.keys(scores);
    if (keys.length === 1 && keys[0] === "welfare" &&
        match(splitWords(kw["cat:welfare"]), norm).every(h => h === "ชุมชน")) delete scores.welfare;

    let isProblem = Object.keys(scores).length > 0 || helpHits.length > 0 || (urgentHits.length > 0 && !praiseHits.length);
    if (!isProblem && location && !praiseHits.length && requestHits.length) isProblem = true;

    matched.push(...helpHits, ...urgentHits);
    result.matched = [...new Set(matched)].join(", ");
    result.location = location;
    if (isProblem) {
      result.label = "problem";
      result.is_problem = 1;
      const ks = Object.keys(scores);
      // เท่ากันให้หมวดที่มาก่อนชนะ (เหมือน max() ของ Python)
      result.category = ks.length ? ks.reduce((a, b) => (scores[b] > scores[a] ? b : a)) : "other";
      result.urgency = urgentHits.length ? "urgent" : requestHits.length ? "request" : "normal";
    } else if (praiseHits.length) {
      result.label = "not_problem";
    }
    return result;
  }

  return { classify, extractLocation, splitWords, normalize };
})();

if (typeof module !== "undefined") module.exports = { Classifier, DEFAULT_KEYWORDS, CATEGORIES, URGENCIES, STATUSES };
