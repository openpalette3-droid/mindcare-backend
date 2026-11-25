-- Run once:  psql -d mindcare -f schema.sql
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,              -- real name or nickname
  contact TEXT UNIQUE NOT NULL,            -- email or phone
  password_hash TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('student','mutuelle','hospital','workplace','other')),
  language TEXT NOT NULL DEFAULT 'rw' CHECK (language IN ('rw','en')),
  hospital_name TEXT,
  patient_number TEXT,
  hospital_verified BOOLEAN NOT NULL DEFAULT FALSE,  -- set TRUE only after the hospital confirms
  free_chat_used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Intake answers and the suggested match (run this too if you already ran the file above)
CREATE TABLE IF NOT EXISTS intakes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers JSONB NOT NULL,
  professional TEXT NOT NULL,          -- suggested type of therapist
  needs_doctor BOOLEAN NOT NULL,       -- a doctor or psychiatrist should review
  urgent BOOLEAN NOT NULL,             -- safety answer was "sometimes" or "often"
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','assigned','closed')),
  assigned_to TEXT,                    -- name of the therapist or doctor
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Your clinical lead checks this every day, urgent first:
--   SELECT i.id,u.display_name,u.contact,i.professional,i.needs_doctor,i.urgent
--   FROM intakes i JOIN users u ON u.id=i.user_id
--   WHERE i.status='pending_review' ORDER BY i.urgent DESC, i.created_at;
