require("dotenv").config();
const express = require("express"), cors = require("cors"), bcrypt = require("bcrypt"), jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json({ limit: "4mb" }));

const sign = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
const auth = (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || "").replace("Bearer ", ""), process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Please log in." }); }
};
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: "Server error." }); });
const clinicalList = (process.env.CLINICAL_CONTACTS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const clinicOnly = (async (req, res, next) => {
  const r = await db.query("SELECT contact FROM users WHERE id=$1", [req.user.id]);
  if (!r.rows[0] || !clinicalList.includes(r.rows[0].contact)) return res.status(403).json({ error: "Clinical team only." });
  next();
});

// Prices per session in RWF (from the MindCare business plan)
const PRICES = {
  student: ["Student (with student ID)", 3000], mutuelle_1: ["Mutuelle, 1st class", 2000],
  mutuelle_2_3: ["Mutuelle, 2nd and 3rd class", 3000], mutuelle_4: ["Mutuelle, 4th class", 4000],
  other_insurance: ["Other insurance (co-pay varies)", null], workplace: ["Through my workplace", 4000],
  full: ["No insurance, individual session", 10000], group: ["Group session (up to 5 people)", 15000],
};
const PAY = ["momo", "card", "cash"];
const DISC = ["student", "mutuelle_1", "mutuelle_2_3", "mutuelle_4", "other_insurance", "workplace"];
const okProof = (p) => typeof p === "string" && /^data:(image\/(jpeg|png|webp)|application\/pdf);base64,/.test(p) && p.length < 2800000;

// ---------- email ----------
async function sendEmail(to, subject, text, attachments, html) {
  if (!to.length || !process.env.RESEND_API_KEY) { console.warn("Email not sent: email is not set up."); return; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.ALERT_FROM || "MindCare <onboarding@resend.dev>", to, subject, text, attachments, html }),
    });
    if (!r.ok) console.error("Email failed:", r.status, await r.text());
  } catch (e) { console.error("Email failed:", e.message); }
}
const escH = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Email look: "MindCare" as the title, with a subtitle such as "New booking"
function htmlEmail(subtitle, rows, note, link) {
  const tr = rows.map(([k, v]) => `<tr><td style="padding:8px 0;color:#6B8189;width:130px;vertical-align:top">${escH(k)}</td><td style="padding:8px 0;color:#3A5560"><b>${escH(v)}</b></td></tr>`).join("");
  const btn = link ? `<p style="margin:18px 0 0"><a href="${escH(link)}" style="background:#3F7F7B;color:#ffffff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold;display:inline-block">Open the clinical team page</a></p>` : "";
  return `<div style="background:#f4f8f7;padding:24px;font-family:Arial,Helvetica,sans-serif"><div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #E1EBEA;border-radius:16px;overflow:hidden"><div style="padding:26px 28px 8px"><div style="font-family:Georgia,serif;font-size:32px;color:#2F6F6B;font-weight:bold">MindCare</div><div style="font-size:18px;color:#6B8189;margin-top:4px">${escH(subtitle)}</div></div><div style="padding:8px 28px 26px"><table style="width:100%;border-collapse:collapse;font-size:15px">${tr}</table>${btn}<p style="color:#6B8189;font-size:14px;line-height:1.5;margin:18px 0 0">${escH(note)}</p></div></div></div>`;
}
const PAYLBL = { momo: "MoMoPay", card: "Visa or Mastercard", cash: "Cash at a partner centre" };
function alertClinicalTeam() {
  const to = (process.env.ALERT_EMAILS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const link = (process.env.FRONTEND_URL || "") + "/clinic.html";
  return sendEmail(to, "MindCare: Urgent request",
    "MindCare - Urgent request\n\nA new urgent request is waiting. Please log in and open the clinical team page:\n" + link + "\n\nFor privacy, this email does not contain the client's name or answers.",
    undefined,
    htmlEmail("Urgent request", [["What", "A new urgent request needs review today"]], "For privacy, this email does not contain the client's name or answers.", link));
}
const icsDate = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function makeIcs(b, summary, desc) {
  const s = new Date(b.starts_at), e = new Date(s.getTime() + 3600000);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MindCare//EN", "BEGIN:VEVENT", "UID:booking-" + b.id + "@mindcare",
    "DTSTAMP:" + icsDate(new Date()), "DTSTART:" + icsDate(s), "DTEND:" + icsDate(e), "SUMMARY:" + summary, "DESCRIPTION:" + desc,
    "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", "DESCRIPTION:Tomorrow: " + summary, "END:VALARM",
    "BEGIN:VALARM", "TRIGGER:-PT1H", "ACTION:DISPLAY", "DESCRIPTION:In 1 hour: " + summary, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}
async function sendBookingEmails(b, t, u) {
  const k = new Date(new Date(b.starts_at).getTime() + 7200000).toISOString();
  const when = k.slice(0, 10) + " at " + k.slice(11, 16) + " (Kigali time)";
  const att = (summary, desc) => [{ filename: "mindcare-session.ics", content: Buffer.from(makeIcs(b, summary, desc)).toString("base64") }];
  const note = "Open the attached calendar file to add the session to your calendar with reminders (1 day and 1 hour before).";
  await sendEmail([t.email], "MindCare: New booking",
    "MindCare - New booking\n\nClient: " + u.display_name + " (" + u.contact + ")\nWhen: " + when + "\nSession: " + b.price_label + "\nPayment: " + (PAYLBL[b.payment] || "none (free first chat)") + "\n\n" + note,
    att("MindCare session with " + u.display_name, "Session: " + b.price_label),
    htmlEmail("New booking", [["Client", u.display_name + " (" + u.contact + ")"], ["When", when], ["Session", b.price_label], ["Payment", PAYLBL[b.payment] || "None (free first chat)"]], note));
  if (String(u.contact).includes("@"))
    await sendEmail([u.contact], "MindCare: Booking confirmed",
      "MindCare - Booking confirmed\n\nTherapist: " + t.name + "\nWhen: " + when + "\nSession: " + b.price_label + "\n\n" + note,
      att("MindCare session with " + t.name, "Session: " + b.price_label),
      htmlEmail("Booking confirmed", [["Therapist", t.name], ["When", when], ["Session", b.price_label]], note));
}

// ---------- matching ----------
function matchIntake(a) {
  const c = a.concerns || [];
  const urgent = !!(a.safety && a.safety !== "no");
  const needsDoctor = urgent || a.impact === "severe" || (a.care && a.care !== "none") || c.includes("substance");
  let professional = "Counselling therapist";
  if (c.includes("trauma")) professional = "Trauma-informed psychologist";
  else if (c.includes("relationships")) professional = "Relationship and family counsellor";
  else if (c.includes("pressure") && !c.includes("mood") && !c.includes("anxiety")) professional = "Counsellor for school and work stress";
  return { professional, needsDoctor: !!needsDoctor, urgent };
}
// Picks the best available therapist or doctor from the clients' preferences
async function assignTherapist(a, needsDoctor) {
  const t = await db.query(`SELECT t.*,(SELECT count(*) FROM intakes i WHERE i.therapist_id=t.id AND i.status<>'closed') AS load FROM therapists t WHERE t.active`);
  if (!t.rows.length) return { id: null, prefsMet: true };
  const c = a.concerns || []; let best = null;
  for (const x of t.rows) {
    let sc = 0;
    const gOk = !a.gender || a.gender === "any" || x.gender === a.gender; if (gOk) sc += 3;
    const lOk = !a.language || a.language === "any" || x.languages.includes(a.language); if (lOk) sc += 3;
    sc += c.filter((v) => x.specialties.includes(v)).length * 2;
    if (needsDoctor && x.role === "doctor") sc += 6;
    if (c.includes("trauma") && x.role === "psychologist") sc += 2;
    sc -= Number(x.load) * 0.2;
    if (!best || sc > best.sc) best = { x, sc, ok: gOk && lOk };
  }
  return { id: best.x.id, prefsMet: best.ok };
}
async function saveIntake(userId, a) {
  const m = matchIntake(a), t = await assignTherapist(a, m.needsDoctor);
  await db.query(
    `INSERT INTO intakes (user_id,answers,professional,needs_doctor,urgent,therapist_id,prefs_met,status,assigned_to)
     VALUES ($1,$2,$3,$4,$5,$6::int,$7,$8,(SELECT name FROM therapists WHERE id=$6::int))`,
    [userId, a, m.professional, m.needsDoctor, m.urgent, t.id, t.prefsMet, t.id ? "assigned" : "pending_review"]);
  if (m.urgent) alertClinicalTeam();
}

// ---------- accounts ----------
app.get("/api/pricing", (_, res) => res.json(PRICES));

app.post("/api/signup", wrap(async (req, res) => {
  const { name, contact, password, category, language, hospital, patientNumber, intake, proof } = req.body;
  if (!name || !contact || (password || "").length < 8 || !["student", "mutuelle", "hospital", "workplace", "other"].includes(category))
    return res.status(400).json({ error: "Enter a name or nickname, your email or phone, and a password of 8+ characters." });
  if (category === "hospital" && (!hospital || !patientNumber))
    return res.status(400).json({ error: "Enter your hospital and patient number." });
  const needsProof = ["student", "mutuelle"].includes(category);
  if (needsProof && !okProof(proof))
    return res.status(400).json({ error: "Please upload a clear photo (JPG or PNG) or a PDF under 1.5 MB of your " + (category === "student" ? "student card." : "Mutuelle or insurance card.") });
  try {
    const hash = await bcrypt.hash(password, 12);
    const r = await db.query(
      `INSERT INTO users (display_name,contact,password_hash,category,language,hospital_name,patient_number,proof_data,proof_status)
       VALUES ($1,lower($2),$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [name, contact.trim(), hash, category, language === "en" ? "en" : "rw",
       category === "hospital" ? hospital : null, category === "hospital" ? patientNumber : null,
       needsProof ? proof : null, needsProof ? "pending" : "none"]);
    if (intake && intake.answers) { try { await saveIntake(r.rows[0].id, intake.answers); } catch (e) { console.error(e); } }
    res.status(201).json({ token: sign(r.rows[0]) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "That email or phone is already registered." });
    throw e;
  }
}));

app.post("/api/login", wrap(async (req, res) => {
  const { contact, password } = req.body;
  const r = await db.query("SELECT * FROM users WHERE contact=lower($1)", [(contact || "").trim()]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password || "", u.password_hash)))
    return res.status(401).json({ error: "Wrong email/phone or password." });
  res.json({ token: sign(u) });
}));

app.get("/api/me", auth, wrap(async (req, res) => {
  const r = await db.query("SELECT id,display_name,contact,category,language,hospital_name,hospital_verified,proof_status,approved_price FROM users WHERE id=$1", [req.user.id]);
  const u = r.rows[0];
  if (!u) return res.status(404).json({ error: "Account not found." });
  const i = await db.query(
    `SELECT i.professional,i.needs_doctor,i.urgent,i.status,i.answers,i.prefs_met,t.id AS tid,t.name AS tname,t.role AS trole
     FROM intakes i LEFT JOIN therapists t ON t.id=i.therapist_id WHERE i.user_id=$1 ORDER BY i.created_at DESC LIMIT 1`, [u.id]);
  const b = await db.query(
    `SELECT b.id,b.starts_at,b.kind,b.price_label,b.price_rwf,b.payment,t.name AS tname
     FROM bookings b JOIN therapists t ON t.id=b.therapist_id WHERE b.client_id=$1 AND b.status<>'cancelled' ORDER BY b.starts_at`, [u.id]);
  const x = i.rows[0];
  res.json({ ...u, isClinical: clinicalList.includes(u.contact), bookings: b.rows,
    intake: x ? { ...x, therapist: x.tid ? { id: x.tid, name: x.tname, role: x.trole } : null } : null });
}));

app.post("/api/intake", auth, wrap(async (req, res) => {
  const a = req.body && req.body.answers;
  if (!a || typeof a !== "object") return res.status(400).json({ error: "No answers received." });
  await saveIntake(req.user.id, a);
  res.status(201).json({ ok: true });
}));

app.post("/api/proof", auth, wrap(async (req, res) => {
  if (!okProof(req.body.proof)) return res.status(400).json({ error: "Please upload a clear photo (JPG or PNG) or a PDF under 1.5 MB." });
  await db.query("UPDATE users SET proof_data=$1, proof_status='pending' WHERE id=$2", [req.body.proof, req.user.id]);
  res.json({ ok: true });
}));

// ---------- booking ----------
async function myTherapist(userId) {
  const r = await db.query("SELECT t.* FROM intakes i JOIN therapists t ON t.id=i.therapist_id WHERE i.user_id=$1 ORDER BY i.created_at DESC LIMIT 1", [userId]);
  return r.rows[0];
}
app.get("/api/booked", auth, wrap(async (req, res) => {
  const t = await myTherapist(req.user.id);
  if (!t) return res.json([]);
  const r = await db.query("SELECT starts_at FROM bookings WHERE therapist_id=$1 AND status<>'cancelled' AND starts_at>now()", [t.id]);
  res.json(r.rows.map((x) => x.starts_at));
}));

app.post("/api/bookings", auth, wrap(async (req, res) => {
  const { kind, priceKey, payment, startsAt } = req.body;
  const t = await myTherapist(req.user.id);
  if (!t) return res.status(400).json({ error: "You don't have a therapist yet." });
  const d = new Date(startsAt), k = new Date(d.getTime() + 7200000), now = Date.now();
  if (isNaN(d) || d < now + 3600000 || d > now + 30 * 86400000 || k.getUTCDay() === 0 || k.getUTCHours() < 8 || k.getUTCHours() > 16 || k.getUTCMinutes() !== 0)
    return res.status(400).json({ error: "Please choose a time between 08:00 and 16:00, Monday to Saturday." });
  let label, price, pay = null;
  if (kind === "first") {
    const f = await db.query("SELECT 1 FROM bookings WHERE client_id=$1 AND kind='first' AND status<>'cancelled'", [req.user.id]);
    if (f.rows.length) return res.status(400).json({ error: "You have already booked your free first chat." });
    label = "First chat (free)"; price = 0;
  } else {
    const p = PRICES[priceKey];
    if (!p || !PAY.includes(payment)) return res.status(400).json({ error: "Choose a session and a way to pay." });
    const ur = (await db.query("SELECT category,proof_status,approved_price FROM users WHERE id=$1", [req.user.id])).rows[0];
    if (DISC.includes(priceKey) && (ur.proof_status !== "approved" || ur.approved_price !== priceKey))
      return res.status(400).json({ error: "That price needs proof approved by our team. Choose the price you are approved for, or the full price." });
    label = p[0]; price = p[1]; pay = payment;
  }
  let b;
  try {
    const r = await db.query(
      "INSERT INTO bookings (client_id,therapist_id,starts_at,kind,price_label,price_rwf,payment) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [req.user.id, t.id, d, kind === "first" ? "first" : "session", label, price, pay]);
    b = r.rows[0];
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "That time was just taken. Please choose another." });
    throw e;
  }
  const u = (await db.query("SELECT display_name,contact FROM users WHERE id=$1", [req.user.id])).rows[0];
  sendBookingEmails(b, t, u);
  res.status(201).json({ ok: true, id: b.id });
}));

// ---------- clinical team only ----------
app.get("/api/clinical/intakes", auth, clinicOnly, wrap(async (req, res) => {
  const r = await db.query(
    `SELECT i.id,i.answers,i.professional,i.needs_doctor,i.urgent,i.status,i.therapist_id,t.name AS tname,
            u.display_name,u.contact,u.category,u.hospital_name,u.patient_number,u.hospital_verified,u.id AS user_id,u.proof_status,u.approved_price
     FROM intakes i JOIN users u ON u.id=i.user_id LEFT JOIN therapists t ON t.id=i.therapist_id
     ORDER BY (i.status<>'closed') DESC, i.urgent DESC, i.created_at DESC LIMIT 200`);
  res.json(r.rows);
}));
app.post("/api/clinical/intakes/:id", auth, clinicOnly, wrap(async (req, res) => {
  const { status, therapistId } = req.body;
  if (!["pending_review", "assigned", "closed"].includes(status)) return res.status(400).json({ error: "Bad status." });
  await db.query("UPDATE intakes SET status=$1, therapist_id=$2::int, assigned_to=(SELECT name FROM therapists WHERE id=$2::int) WHERE id=$3",
    [status, therapistId || null, Number(req.params.id) || 0]);
  res.json({ ok: true });
}));
app.get("/api/clinical/therapists", auth, clinicOnly, wrap(async (req, res) => {
  res.json((await db.query("SELECT * FROM therapists ORDER BY id")).rows);
}));
app.post("/api/clinical/therapists", auth, clinicOnly, wrap(async (req, res) => {
  const { name, email, role, gender, languages, specialties } = req.body;
  if (!name || !email || !["therapist", "psychologist", "doctor"].includes(role) || !["f", "m"].includes(gender) || !(languages || []).length)
    return res.status(400).json({ error: "Fill in name, email, role, gender and at least one language." });
  try {
    await db.query("INSERT INTO therapists (name,email,role,gender,languages,specialties) VALUES ($1,lower($2),$3,$4,$5,$6)",
      [name, email.trim(), role, gender, languages, specialties || []]);
  } catch (e) { if (e.code === "23505") return res.status(409).json({ error: "That email is already added." }); throw e; }
  res.status(201).json({ ok: true });
}));
app.post("/api/clinical/therapists/:id/active", auth, clinicOnly, wrap(async (req, res) => {
  await db.query("UPDATE therapists SET active=$1 WHERE id=$2", [!!req.body.active, Number(req.params.id) || 0]);
  res.json({ ok: true });
}));

app.get("/api/clinical/proof/:uid", auth, clinicOnly, wrap(async (req, res) => {
  const r = await db.query("SELECT proof_data FROM users WHERE id=$1", [Number(req.params.uid) || 0]);
  res.json({ data: (r.rows[0] && r.rows[0].proof_data) || null });
}));
app.post("/api/clinical/proof/:uid", auth, clinicOnly, wrap(async (req, res) => {
  const { status, priceKey } = req.body;
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "Bad status." });
  if (status === "approved" && !DISC.includes(priceKey)) return res.status(400).json({ error: "Choose which price to approve." });
  await db.query("UPDATE users SET proof_status=$1, approved_price=$3 WHERE id=$2", [status, Number(req.params.uid) || 0, status === "approved" ? priceKey : null]);
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "That file is too large. Please use a smaller photo or PDF." });
  console.error(err);
  res.status(400).json({ error: "Something was wrong with that request." });
});

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, display_name TEXT NOT NULL, contact TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('student','mutuelle','hospital','workplace','other')),
      language TEXT NOT NULL DEFAULT 'rw' CHECK (language IN ('rw','en')),
      hospital_name TEXT, patient_number TEXT, hospital_verified BOOLEAN NOT NULL DEFAULT FALSE,
      free_chat_used BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS therapists (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('therapist','psychologist','doctor')),
      gender TEXT NOT NULL CHECK (gender IN ('f','m')),
      languages TEXT[] NOT NULL DEFAULT '{}', specialties TEXT[] NOT NULL DEFAULT '{}', active BOOLEAN NOT NULL DEFAULT TRUE);
    CREATE TABLE IF NOT EXISTS intakes (
      id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, answers JSONB NOT NULL,
      professional TEXT NOT NULL, needs_doctor BOOLEAN NOT NULL, urgent BOOLEAN NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','assigned','closed')),
      assigned_to TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    ALTER TABLE intakes ADD COLUMN IF NOT EXISTS therapist_id INT REFERENCES therapists(id);
    ALTER TABLE intakes ADD COLUMN IF NOT EXISTS prefs_met BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY, client_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      therapist_id INT NOT NULL REFERENCES therapists(id), starts_at TIMESTAMPTZ NOT NULL,
      kind TEXT NOT NULL, price_label TEXT NOT NULL, price_rwf INT, payment TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS bookings_slot ON bookings (therapist_id, starts_at) WHERE status<>'cancelled';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS proof_data TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS proof_status TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_price TEXT;
    UPDATE users SET approved_price = CASE category WHEN 'student' THEN 'student' WHEN 'mutuelle' THEN 'mutuelle_2_3' END WHERE proof_status='approved' AND approved_price IS NULL;
  `);
}
initDb()
  .then(() => app.listen(process.env.PORT || 3000, () => console.log("MindCare API running")))
  .catch((e) => { console.error("Could not set up the database:", e.message); process.exit(1); });
