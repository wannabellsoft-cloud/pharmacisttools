import { CARD_VISIBLE_STATUS, scoreNaranjo, validateRecord, NARANJO_QUESTIONS } from '../../shared/clinical.js';
import { blindIndex, decryptJSON, encryptJSON, sha256, uuid } from '../crypto.js';
import { addDays, nowIso, tx } from '../db.js';
import { HttpError } from '../http.js';

const PATIENT_FIELDS = ['hn', 'nationalId', 'firstNameTh', 'lastNameTh', 'firstNameEn', 'lastNameEn', 'dob', 'sex', 'phone'];
const RECORD_DATA_FIELDS = ['drugGeneric', 'drugBrand', 'drugClass', 'manifestations', 'reactionNote', 'onsetDate', 'confirmationNote', 'internalNote'];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = typeof obj[f] === 'string' ? obj[f].trim() : obj[f];
  return out;
}

function validatePatient(p) {
  const errors = [];
  if (!p.hn) errors.push({ field: 'hn', code: 'REQUIRED' });
  if (!p.nationalId || String(p.nationalId).replace(/[\s-]/g, '').length < 6) errors.push({ field: 'nationalId', code: 'REQUIRED' });
  if (!p.dob || !/^\d{4}-\d{2}-\d{2}$/.test(p.dob)) errors.push({ field: 'dob', code: 'REQUIRED' });
  if (!(p.firstNameTh && p.lastNameTh) && !(p.firstNameEn && p.lastNameEn)) errors.push({ field: 'name', code: 'REQUIRED' });
  if (p.nationalId && /^\d[\d\s-]*$/.test(p.nationalId)) {
    const d = p.nationalId.replace(/\D/g, '');
    if (d.length === 13 && !thaiIdChecksumOk(d)) errors.push({ field: 'nationalId', code: 'CHECKSUM' });
  }
  return errors;
}

/** Thai national ID check digit (mod 11). */
export function thaiIdChecksumOk(d) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(d[12]);
}

export function createPatientService(db, keys, config, audit) {
  const aad = (id) => `patient:${id}`;
  const raad = (id) => `record:${id}`;

  const decodePatient = (row) => {
    if (!row) return null;
    const data = row.erased_at ? null : decryptJSON(row.data_enc, keys.enc, aad(row.id));
    return { id: row.id, ...data, erased: Boolean(row.erased_at), createdAt: row.created_at, updatedAt: row.updated_at, retainUntil: row.retain_until };
  };

  const decodeRecord = (row) => {
    if (!row) return null;
    const data = decryptJSON(row.data_enc, keys.enc, raad(row.id)) || {};
    return {
      id: row.id,
      patientId: row.patient_id,
      ...data,
      naranjo: row.naranjo_answers ? { answers: JSON.parse(row.naranjo_answers), score: row.naranjo_score, category: row.naranjo_category } : null,
      reactionType: row.reaction_type,
      certainty: row.certainty,
      confirmationBasis: row.confirmation_basis ? JSON.parse(row.confirmation_basis) : [],
      clinicalStatus: row.clinical_status,
      severity: row.severity,
      assessmentDate: row.assessment_date,
      reviewStatus: row.review_status,
      version: row.version,
      verifiedBy: row.verified_by,
      verifiedAt: row.verified_at,
      verificationNote: row.verification_note,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  };

  const getPatientRow = db.prepare('SELECT * FROM patients WHERE id = ?');
  const getRecordRow = db.prepare('SELECT * FROM allergy_records WHERE id = ?');
  const listRecordRows = db.prepare('SELECT * FROM allergy_records WHERE patient_id = ? ORDER BY created_at ASC');

  function getPatient(id) {
    const p = decodePatient(getPatientRow.get(id));
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Patient not found.');
    return p;
  }

  function requireActivePatient(id) {
    const p = getPatient(id);
    if (p.erased) throw new HttpError(410, 'ERASED', 'Patient data has been erased.');
    return p;
  }

  function touchRetention(patientId) {
    db.prepare('UPDATE patients SET retain_until = ?, updated_at = ? WHERE id = ?').run(addDays(config.recordRetentionDays), nowIso(), patientId);
  }

  function createPatient(input, actor) {
    const data = pick(input, PATIENT_FIELDS);
    const errors = validatePatient(data);
    if (errors.length) throw new HttpError(422, 'VALIDATION', 'Invalid patient data.', { errors });
    const id = uuid();
    const hnIndex = blindIndex(data.hn, keys.index);
    if (db.prepare('SELECT 1 FROM patients WHERE hn_index = ?').get(hnIndex)) {
      throw new HttpError(409, 'DUPLICATE_HN', 'A patient with this HN already exists.');
    }
    const now = nowIso();
    db.prepare('INSERT INTO patients (id, hn_index, data_enc, created_by, created_at, updated_at, retain_until) VALUES (?,?,?,?,?,?,?)')
      .run(id, hnIndex, encryptJSON(data, keys.enc, aad(id)), actor.id, now, now, addDays(config.recordRetentionDays));
    audit.log({ actorType: 'pharmacist', actorId: actor.id, action: 'patient.create', entityType: 'patient', entityId: id, patientId: id });
    return getPatient(id);
  }

  function updatePatient(id, input, actor) {
    const current = requireActivePatient(id);
    const data = { ...pick(current, PATIENT_FIELDS), ...pick(input, PATIENT_FIELDS) };
    const errors = validatePatient(data);
    if (errors.length) throw new HttpError(422, 'VALIDATION', 'Invalid patient data.', { errors });
    const hnIndex = blindIndex(data.hn, keys.index);
    const clash = db.prepare('SELECT id FROM patients WHERE hn_index = ? AND id <> ?').get(hnIndex, id);
    if (clash) throw new HttpError(409, 'DUPLICATE_HN', 'A patient with this HN already exists.');
    db.prepare('UPDATE patients SET hn_index = ?, data_enc = ?, updated_at = ? WHERE id = ?').run(hnIndex, encryptJSON(data, keys.enc, aad(id)), nowIso(), id);
    touchRetention(id);
    audit.log({ actorType: 'pharmacist', actorId: actor.id, action: 'patient.update', entityType: 'patient', entityId: id, patientId: id, details: { fields: Object.keys(pick(input, PATIENT_FIELDS)) } });
    return getPatient(id);
  }

  function findByHn(hn) {
    const row = db.prepare('SELECT * FROM patients WHERE hn_index = ? AND erased_at IS NULL').get(blindIndex(hn, keys.index));
    return row ? [decodePatient(row)] : [];
  }

  function recentPatients(limit = 30) {
    return db.prepare('SELECT * FROM patients WHERE erased_at IS NULL ORDER BY updated_at DESC LIMIT ?').all(limit).map(decodePatient);
  }

  function listRecords(patientId) {
    return listRecordRows.all(patientId).map(decodeRecord);
  }

  function getRecord(id) {
    const r = decodeRecord(getRecordRow.get(id));
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
    return r;
  }

  function normalizeRecordInput(input) {
    const naranjoAnswers = input.naranjoAnswers ?? input.naranjo?.answers ?? null;
    const cleanAnswers = {};
    if (naranjoAnswers) {
      for (const q of NARANJO_QUESTIONS) if (['yes', 'no', 'unknown'].includes(naranjoAnswers[q.id])) cleanAnswers[q.id] = naranjoAnswers[q.id];
    }
    return {
      ...pick(input, RECORD_DATA_FIELDS),
      reactionType: input.reactionType,
      // Certainty is never derived from Naranjo: default is always "suspected".
      certainty: input.certainty || 'suspected',
      confirmationBasis: input.certainty === 'confirmed' ? (Array.isArray(input.confirmationBasis) ? input.confirmationBasis : []) : [],
      confirmationNote: input.certainty === 'confirmed' ? input.confirmationNote : undefined,
      clinicalStatus: input.clinicalStatus || 'active',
      severity: input.severity,
      assessmentDate: input.assessmentDate,
      naranjoAnswers: Object.keys(cleanAnswers).length ? cleanAnswers : null,
    };
  }

  function writeRecord(id, patientId, r, actor, isNew) {
    const errors = validateRecord(r);
    if (errors.length) throw new HttpError(422, 'VALIDATION', 'Invalid allergy record.', { errors });
    const naranjo = r.naranjoAnswers ? scoreNaranjo(r.naranjoAnswers) : null;
    const data = pick(r, RECORD_DATA_FIELDS);
    const now = nowIso();
    const enc = encryptJSON(data, keys.enc, raad(id));
    const args = [
      enc,
      r.naranjoAnswers ? JSON.stringify(r.naranjoAnswers) : null,
      naranjo?.score ?? null,
      naranjo?.category ?? null,
      r.reactionType,
      r.certainty,
      r.confirmationBasis.length ? JSON.stringify(r.confirmationBasis) : null,
      r.clinicalStatus,
      r.severity,
      r.assessmentDate,
    ];
    if (isNew) {
      db.prepare(`INSERT INTO allergy_records (data_enc, naranjo_answers, naranjo_score, naranjo_category, reaction_type, certainty,
        confirmation_basis, clinical_status, severity, assessment_date, id, patient_id, review_status, version, created_by, created_at, updated_by, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending_review', 1, ?,?,?,?)`).run(...args, id, patientId, actor.id, now, actor.id, now);
    } else {
      // Any change invalidates the previous verification and requires a fresh pharmacist review.
      db.prepare(`UPDATE allergy_records SET data_enc=?, naranjo_answers=?, naranjo_score=?, naranjo_category=?, reaction_type=?, certainty=?,
        confirmation_basis=?, clinical_status=?, severity=?, assessment_date=?, review_status='pending_review', version=version+1,
        verified_by=NULL, verified_at=NULL, verification_note=NULL, updated_by=?, updated_at=? WHERE id=?`).run(...args, actor.id, now, id);
    }
    touchRetention(patientId);
    return naranjo;
  }

  function createRecord(patientId, input, actor) {
    requireActivePatient(patientId);
    const id = uuid();
    const r = normalizeRecordInput(input);
    const naranjo = writeRecord(id, patientId, r, actor, true);
    audit.log({
      actorType: 'pharmacist', actorId: actor.id, action: 'record.create', entityType: 'record', entityId: id, patientId,
      details: { certainty: r.certainty, reactionType: r.reactionType, naranjo: naranjo?.category ?? null },
    });
    return getRecord(id);
  }

  function updateRecord(id, input, actor) {
    const current = getRecord(id);
    requireActivePatient(current.patientId);
    const merged = normalizeRecordInput({ ...current, naranjoAnswers: current.naranjo?.answers, ...input });
    const naranjo = writeRecord(id, current.patientId, merged, actor, false);
    audit.log({
      actorType: 'pharmacist', actorId: actor.id, action: 'record.update', entityType: 'record', entityId: id, patientId: current.patientId,
      details: { version: current.version + 1, certainty: merged.certainty, clinicalStatus: merged.clinicalStatus, naranjo: naranjo?.category ?? null },
    });
    return getRecord(id);
  }

  function verifyRecord(id, { attest, note, expectedVersion }, pharmacist) {
    const r = getRecord(id);
    requireActivePatient(r.patientId);
    if (!attest) throw new HttpError(422, 'ATTESTATION_REQUIRED', 'The reviewing pharmacist must attest to the review.');
    if (r.reviewStatus === 'verified') throw new HttpError(409, 'ALREADY_VERIFIED', 'This version is already verified.');
    if (expectedVersion !== undefined && Number(expectedVersion) !== r.version) {
      throw new HttpError(409, 'VERSION_CHANGED', 'The record changed while you were reviewing it. Please review again.');
    }
    if (config.requireIndependentReviewer && r.updatedBy === pharmacist.id) {
      throw new HttpError(403, 'INDEPENDENT_REVIEW_REQUIRED', 'A different pharmacist must verify this record.');
    }
    const errors = validateRecord({ ...r });
    if (errors.length) throw new HttpError(422, 'VALIDATION', 'Record is incomplete.', { errors });
    db.prepare("UPDATE allergy_records SET review_status='verified', verified_by=?, verified_at=?, verification_note=? WHERE id=? AND version=?")
      .run(pharmacist.id, nowIso(), note ? String(note).slice(0, 500) : null, id, r.version);
    audit.log({
      actorType: 'pharmacist', actorId: pharmacist.id, action: 'record.verify', entityType: 'record', entityId: id, patientId: r.patientId,
      details: { version: r.version, certainty: r.certainty, clinicalStatus: r.clinicalStatus },
    });
    return getRecord(id);
  }

  /** Determines whether cards may be issued for a patient. */
  function readiness(patientId) {
    const patient = getPatient(patientId);
    const records = listRecords(patientId);
    const reasons = [];
    if (patient.erased) reasons.push('PATIENT_ERASED');
    const pending = records.filter((r) => r.reviewStatus !== 'verified');
    if (pending.length) reasons.push('PENDING_REVIEW');
    const included = records.filter((r) => r.reviewStatus === 'verified' && CARD_VISIBLE_STATUS.includes(r.clinicalStatus));
    if (!included.length) reasons.push('NO_VERIFIED_RECORDS');
    const fingerprint = sha256(included.map((r) => `${r.id}:${r.version}`).sort().join('|'));
    return { ready: reasons.length === 0, reasons, pendingCount: pending.length, includedCount: included.length, included, fingerprint };
  }

  /** PDPA erasure: crypto-shreds identifiers and clinical content; audit trail is kept (PII-free). */
  function erasePatient(id, actor, reason) {
    requireActivePatient(id);
    tx(db, () => {
      const now = nowIso();
      db.prepare("UPDATE patients SET data_enc = NULL, hn_index = 'erased:' || id, erased_at = ? WHERE id = ?").run(now, id);
      db.prepare('UPDATE allergy_records SET data_enc = NULL, naranjo_answers = NULL WHERE patient_id = ?').run(id);
    });
    audit.log({ actorType: actor.type ?? 'pharmacist', actorId: actor.id, action: 'patient.erase', entityType: 'patient', entityId: id, patientId: id, details: { reason: reason ?? null } });
  }

  return {
    getPatient, requireActivePatient, createPatient, updatePatient, findByHn, recentPatients,
    listRecords, getRecord, createRecord, updateRecord, verifyRecord, readiness, erasePatient,
  };
}
