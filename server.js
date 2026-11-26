require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL }));

// Prices per session in RWF (from the MindCare business plan)
const PRICES = {
  student: 3000, workplace: 4000, mutuelle_1: 2000, mutuelle_2_3: 3000,
  mutuelle_4: 4000, other_insurance: "2000-5000", full: 10000, group: 15000,
};
const sign = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
const auth = (req, res, next) => {
  try {
    req.user = jwt.verify((req.headers.authorization || "").replace("Bearer ", ""), process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: "Please log in." }); }
};

app.get("/api/prices", (_, res) => res.json(PRICES));

// Suggest the type of professional from the intake answers. A clinician always confirms the match.
function matchIntake(a) {
  const c = a.concerns || [];
  const urgent = a.safety && a.safety !== "no";
  const needsDoctor = urgent || a.impact === "severe" || (a.care && a.care !== "none") || c.includes("substance");
  let professional = "Counselling therapist";
  if (c.includes("trauma")) professional = "Trauma-informed psychologist";
  else if (c.includes("relationships")) professional = "Relationship and family counsellor";
  else if (c.includes("pressure") && !c.includes("mood") && !c.includes("anxiety")) professional = "Counsellor for school and work stress";
  return { professional, needsDoctor: !!needsDoctor, urgent: !!urgent };
}

app.post("/api/signup", async (req, res) => {
  const { name, contact, password, category, language, hospital, patientNumber, intake } = req.body;
  const cats = ["student", "mutuelle", "hospital", "workplace", "other"];
  if (!name || !contact || (password || "").length < 8 || !cats.includes(category))
    return res.status(400).json({ error: "Enter a name or nickname, your email or phone, and a password of 8+ characters." });
  if (category === "hospital" && (!hospital || !patientNumber))
    return res.status(400).json({ error: "Enter your hospital and patient number." });
  try {
    const hash = await bcrypt.hash(password, 12);
    const r = await db.query(
      `INSERT INTO users (display_name,contact,password_hash,category,language,hospital_name,patient_number)
       VALUES ($1,lower($2),$3,$4,$5,$6,$7) RETURNING id`,
      [name, contact.trim(), hash, category, language === "en" ? "en" : "rw",
       category === "hospital" ? hospital : null, category === "hospital" ? patientNumber : null]
    );
    if (intake && intake.answers) {
      const m = matchIntake(intake.answers);
      await db.query(
        "INSERT INTO intakes (user_id,answers,professional,needs_doctor,urgent) VALUES ($1,$2,$3,$4,$5)",
        [r.rows[0].id, intake.answers, m.professional, m.needsDoctor, m.urgent]);
    }
    res.status(201).json({ token: sign(r.rows[0]) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "That email or phone is already registered." });
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/login", async (req, res) => {
  const { contact, password } = req.body;
  const r = await db.query("SELECT * FROM users WHERE contact=lower($1)", [(contact || "").trim()]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password || "", u.password_hash)))
    return res.status(401).json({ error: "Wrong email/phone or password." });
  res.json({ token: sign(u) });
});

app.get("/api/me", auth, async (req, res) => {
  const r = await db.query(
    "SELECT id,display_name,category,language,hospital_name,hospital_verified,free_chat_used FROM users WHERE id=$1",
    [req.user.id]);
  res.json(r.rows[0]);
});

// Creates the tables automatically the first time the server starts
async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      display_name TEXT NOT NULL,
      contact TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('student','mutuelle','hospital','workplace','other')),
      language TEXT NOT NULL DEFAULT 'rw' CHECK (language IN ('rw','en')),
      hospital_name TEXT,
      patient_number TEXT,
      hospital_verified BOOLEAN NOT NULL DEFAULT FALSE,
      free_chat_used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS intakes (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answers JSONB NOT NULL,
      professional TEXT NOT NULL,
      needs_doctor BOOLEAN NOT NULL,
      urgent BOOLEAN NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','assigned','closed')),
      assigned_to TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

initDb()
  .then(() => app.listen(process.env.PORT || 3000, () => console.log("MindCare API running")))
  .catch((e) => { console.error("Could not set up the database:", e.message); process.exit(1); });

