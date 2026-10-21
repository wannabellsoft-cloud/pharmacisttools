import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pharmacists (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  license_no TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'pharmacist' CHECK (role IN ('pharmacist','admin')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  pharmacist_id TEXT NOT NULL REFERENCES pharmacists(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Patient identifiers and demographics are encrypted at rest (data_enc).
-- hn_index is a keyed blind index used for exact-match lookup only.
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  hn_index TEXT NOT NULL UNIQUE,
  data_enc TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retain_until TEXT NOT NULL,
  erased_at TEXT
);

CREATE TABLE IF NOT EXISTS allergy_records (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  data_enc TEXT,
  naranjo_answers TEXT,
  naranjo_score INTEGER,
  naranjo_category TEXT,
  reaction_type TEXT NOT NULL CHECK (reaction_type IN ('allergy','adr')),
  certainty TEXT NOT NULL CHECK (certainty IN ('suspected','confirmed')),
  confirmation_basis TEXT,
  clinical_status TEXT NOT NULL CHECK (clinical_status IN ('active','inactive','resolved','refuted','entered_in_error')),
  severity TEXT NOT NULL,
  assessment_date TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('pending_review','verified')),
  version INTEGER NOT NULL DEFAULT 1,
  verified_by TEXT REFERENCES pharmacists(id),
  verified_at TEXT,
  verification_note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_patient ON allergy_records(patient_id);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  kind TEXT NOT NULL CHECK (kind IN ('physical','digital')),
  status TEXT NOT NULL CHECK (status IN ('active','revoked','superseded')),
  language TEXT NOT NULL,
  format TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  snapshot_enc TEXT,
  snapshot_hash TEXT,
  records_fingerprint TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_cards_patient ON cards(patient_id);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','verified','completed','expired','cancelled','locked')),
  attempts INTEGER NOT NULL DEFAULT 0,
  session_hash TEXT UNIQUE,
  session_expires_at TEXT,
  verified_at TEXT,
  completed_at TEXT,
  card_id TEXT REFERENCES cards(id)
);

-- Device-held access tokens for the Digital Web Card.
CREATE TABLE IF NOT EXISTS holders (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS wallet_passes (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  platform TEXT NOT NULL CHECK (platform IN ('apple','google')),
  serial_number TEXT NOT NULL UNIQUE,
  auth_token_enc TEXT,
  google_object_id TEXT,
  discreet INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  update_tag INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS apple_registrations (
  device_library_id TEXT NOT NULL,
  pass_type_id TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  push_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_library_id, pass_type_id, serial_number)
);

CREATE TABLE IF NOT EXISTS download_tokens (
  token_hash TEXT PRIMARY KEY,
  wallet_pass_id TEXT NOT NULL REFERENCES wallet_passes(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  card_id TEXT REFERENCES cards(id),
  scope TEXT NOT NULL,
  version TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('patient_self','pharmacist_recorded')),
  granted_at TEXT NOT NULL,
  withdrawn_at TEXT,
  recorded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_consents_patient ON consents(patient_id);

-- Tamper-evident (hash-chained) audit log. Never contains clear-text PII.
CREATE TABLE IF NOT EXISTS audit_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  patient_id TEXT,
  ip_pseudo TEXT,
  details TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_logs(patient_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_id);
`;

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside a transaction, rolling back on error. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
export const addMinutes = (min, from = new Date()) => new Date(from.getTime() + min * 60_000).toISOString();
export const addDays = (days, from = new Date()) => new Date(from.getTime() + days * 86_400_000).toISOString();
