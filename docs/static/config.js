// ตั้งค่าการเชื่อมต่อ Supabase (Project Settings → API)
// ค่า key นี้เป็น "publishable/anon key" ซึ่งออกแบบมาให้อยู่ในหน้าเว็บได้
// ความปลอดภัยของข้อมูลมาจาก Row Level Security ใน supabase/schema.sql — ห้ามใส่ service_role key ที่นี่เด็ดขาด
window.APP_CONFIG = {
  supabaseUrl: "",
  supabaseKey: "",
};
