import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { maskId } from '../../shared/clinical.js';
import { decryptJSON, encryptJSON, hmac, safeEqual, sha256, uuid } from '../crypto.js';
import { nowIso, tx } from '../db.js';
import { HttpError } from '../http.js';

const SEVERITY_RANK = { life_threatening: 0, severe: 1, moderate: 2, mild: 3 };
const STATUS_RANK = { active: 0, inactive: 1, resolved: 2 };
const LANGS = ['th', 'en', 'bi'];
const FORMATS = ['id1', 'a4'];

function newSerial() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `PT-${new Date().getFullYear()}-${s.slice(0, 4)}-${s.slice(4)}`;
}

export function createCardService(db, keys, config, audit, patients, pharmacistLookup) {
  const aad = (id, version) => `card:${id}:${version}`;
  // Wallet integrations register here so card changes propagate to passes.
  const listeners = [];

  const sig = (cardId) => hmac(`card:${cardId}`, keys.sign, 12);
  const verifyUrl = (cardId) => `${config.publicBaseUrl}/v/${cardId}?s=${sig(cardId)}`;
  const checkSig = (cardId, s) => Boolean(s) && safeEqual(sig(cardId), s);

  function buildSnapshot(patient, records, meta) {
    const entries = records
      .map((r) => {
        const v = pharmacistLookup(r.verifiedBy);
        return {
          recordId: r.id, version: r.version,
          drugGeneric: r.drugGeneric, drugBrand: r.drugBrand || '', drugClass: r.drugClass || '',
          reactionType: r.reactionType, certainty: r.certainty, confirmationBasis: r.confirmationBasis,
          manifestations: r.manifestations, reactionNote: r.reactionNote || '',
          severity: r.severity, clinicalStatus: r.clinicalStatus, assessmentDate: r.assessmentDate,
          naranjoScore: r.naranjo?.score ?? null, naranjoCategory: r.naranjo?.category ?? null,
          verifiedBy: v ? { name: v.display_name, licenseNo: v.license_no } : null,
          verifiedAt: r.verifiedAt,
        };
      })
      .sort((a, b) =>
        (STATUS_RANK[a.clinicalStatus] - STATUS_RANK[b.clinicalStatus]) ||
        ((a.certainty === 'confirmed' ? 0 : 1) - (b.certainty === 'confirmed' ? 0 : 1)) ||
        (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]));
    const latest = [...entries].sort((a, b) => String(b.verifiedAt).localeCompare(String(a.verifiedAt)))[0];
    return {
      schema: 1,
      ...meta,
      facility: config.facility,
      patient: {
        firstNameTh: patient.firstNameTh || '', lastNameTh: patient.lastNameTh || '',
        firstNameEn: patient.firstNameEn || '', lastNameEn: patient.lastNameEn || '',
        hn: patient.hn, dob: patient.dob, idMasked: maskId(patient.nationalId),
      },
      entries,
      verifiedBy: latest?.verifiedBy ?? null,
      verifiedAt: latest?.verifiedAt ?? null,
      assessmentDate: entries.map((e) => e.assessmentDate).sort().at(-1) ?? null,
    };
  }

  function requireReady(patientId) {
    const r = patients.readiness(patientId);
    if (!r.ready) {
      throw new HttpError(409, 'NOT_READY', 'All allergy records must be reviewed and verified by a pharmacist before a card can be issued.', { reasons: r.reasons });
    }
    return r;
  }

  const getRow = db.prepare('SELECT * FROM cards WHERE id = ?');

  function decode(row, { withSnapshot = true } = {}) {
    if (!row) return null;
    const card = {
      id: row.id, serial: row.serial, patientId: row.patient_id, kind: row.kind, status: row.status,
      language: row.language, format: row.format, version: row.version, issuedBy: row.issued_by,
      issuedAt: row.issued_at, updatedAt: row.updated_at, revokedAt: row.revoked_at, revokeReason: row.revoke_reason,
      recordsFingerprint: row.records_fingerprint,
    };
    if (withSnapshot) card.snapshot = row.snapshot_enc ? decryptJSON(row.snapshot_enc, keys.enc, aad(row.id, row.version)) : null;
    return card;
  }

  function getCard(id) {
    const c = decode(getRow.get(id));
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Card not found.');
    return c;
  }

  function withOutdated(card) {
    if (card.status !== 'active') return { ...card, outdated: false };
    const r = patients.readiness(card.patientId);
    return { ...card, outdated: r.fingerprint !== card.recordsFingerprint, patientReady: r.ready };
  }

  function listCards(patientId) {
    return db.prepare('SELECT * FROM cards WHERE patient_id = ? ORDER BY issued_at DESC').all(patientId)
      .map((row) => withOutdated(decode(row, { withSnapshot: false })));
  }

  function previewSnapshot(patientId, language = 'bi') {
    const r = patients.readiness(patientId);
    const patient = patients.requireActivePatient(patientId);
    return {
      readiness: { ready: r.ready, reasons: r.reasons, pendingCount: r.pendingCount, includedCount: r.includedCount },
      snapshot: buildSnapshot(patient, r.included, {
        cardId: null, serial: 'PT-PREVIEW', kind: 'physical', version: 0, language, preview: true,
        issuedAt: nowIso(), updatedAt: nowIso(), verifyUrl: `${config.publicBaseUrl}/v/preview`,
      }),
    };
  }

  function writeSnapshot(id, version, snapshot) {
    return { enc: encryptJSON(snapshot, keys.enc, aad(id, version)), hash: sha256(JSON.stringify(snapshot)) };
  }

  function supersedeActive(patientId, kind, exceptId, actorId) {
    const rows = db.prepare("SELECT id FROM cards WHERE patient_id = ? AND kind = ? AND status = 'active' AND id <> ?").all(patientId, kind, exceptId);
    for (const { id } of rows) {
      db.prepare("UPDATE cards SET status = 'superseded', updated_at = ? WHERE id = ?").run(nowIso(), id);
      audit.log({ actorType: 'pharmacist', actorId, action: 'card.supersede', entityType: 'card', entityId: id, patientId, details: { by: exceptId } });
    }
    return rows.map((r) => r.id);
  }

  function insertCard(patientId, kind, language, format, actor) {
    const ready = requireReady(patientId);
    const patient = patients.requireActivePatient(patientId);
    const id = uuid();
    const serial = newSerial();
    const now = nowIso();
    const snapshot = buildSnapshot(patient, ready.included, { cardId: id, serial, kind, version: 1, language, issuedAt: now, updatedAt: now, verifyUrl: verifyUrl(id) });
    const { enc, hash } = writeSnapshot(id, 1, snapshot);
    db.prepare(`INSERT INTO cards (id, serial, patient_id, kind, status, language, format, version, snapshot_enc, snapshot_hash, records_fingerprint, issued_by, issued_at, updated_at)
      VALUES (?,?,?,?, 'active', ?,?, 1, ?,?,?,?,?,?)`).run(id, serial, patientId, kind, language, format, enc, hash, ready.fingerprint, actor.id, now, now);
    return id;
  }

  function issuePhysical(patientId, { language = 'bi', format = 'id1', consent }, actor) {
    if (!LANGS.includes(language)) throw new HttpError(422, 'VALIDATION', 'Unsupported language.');
    if (!FORMATS.includes(format)) throw new HttpError(422, 'VALIDATION', 'Unsupported format.');
    if (!consent) throw new HttpError(422, 'CONSENT_REQUIRED', "Record the patient's consent to receive a card containing health information.");
    let superseded = [];
    const id = tx(db, () => {
      const cardId = insertCard(patientId, 'physical', language, format, actor);
      db.prepare("INSERT INTO consents (id, patient_id, card_id, scope, version, method, granted_at, recorded_by) VALUES (?,?,?, 'physical_card', ?, 'pharmacist_recorded', ?, ?)")
        .run(uuid(), patientId, cardId, config.consentVersion, nowIso(), actor.id);
      superseded = supersedeActive(patientId, 'physical', cardId, actor.id);
      return cardId;
    });
    audit.log({ actorType: 'pharmacist', actorId: actor.id, action: 'card.issue', entityType: 'card', entityId: id, patientId, details: { kind: 'physical', language, format, superseded } });
    return getCard(id);
  }

  /** Returns the patient's single living digital card, creating or refreshing it as needed. */
  async function ensureDigitalCard(patientId, language, actor) {
    const active = db.prepare("SELECT * FROM cards WHERE patient_id = ? AND kind = 'digital' AND status = 'active' ORDER BY issued_at DESC LIMIT 1").get(patientId);
    if (active) {
      const card = withOutdated(decode(active, { withSnapshot: false }));
      if (card.outdated) return refreshCardAsync(card.id, actor);
      return getCard(card.id);
    }
    const id = tx(db, () => insertCard(patientId, 'digital', language, null, actor));
    audit.log({ actorType: actor.type, actorId: actor.id, action: 'card.issue', entityType: 'card', entityId: id, patientId, details: { kind: 'digital', language } });
    return getCard(id);
  }

  /** Rebuilds a digital card from the latest verified records and propagates the update to Wallet passes. */
  async function refreshCardAsync(id, actor) {
    const card = refreshCard(id, actor);
    await notify(card, 'update');
    return card;
  }

  function refreshCard(id, actor) {
    const card = getCard(id);
    if (card.kind !== 'digital') throw new HttpError(409, 'PHYSICAL_NOT_UPDATABLE', 'Printed cards cannot be updated. Issue a new physical card instead.');
    if (card.status !== 'active') throw new HttpError(409, 'CARD_INACTIVE', 'Only active cards can be updated.');
    const ready = requireReady(card.patientId);
    const patient = patients.requireActivePatient(card.patientId);
    const version = card.version + 1;
    const now = nowIso();
    const snapshot = buildSnapshot(patient, ready.included, {
      cardId: id, serial: card.serial, kind: card.kind, version, language: card.language, issuedAt: card.issuedAt, updatedAt: now, verifyUrl: verifyUrl(id),
    });
    const { enc, hash } = writeSnapshot(id, version, snapshot);
    db.prepare('UPDATE cards SET version = ?, snapshot_enc = ?, snapshot_hash = ?, records_fingerprint = ?, updated_at = ? WHERE id = ?')
      .run(version, enc, hash, ready.fingerprint, now, id);
    audit.log({ actorType: actor.type ?? 'pharmacist', actorId: actor.id, action: 'card.update', entityType: 'card', entityId: id, patientId: card.patientId, details: { version } });
    return getCard(id);
  }

  async function revokeCard(id, actor, reason) {
    const card = getCard(id);
    if (card.status === 'revoked') return card;
    const now = nowIso();
    tx(db, () => {
      db.prepare("UPDATE cards SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_reason = ?, updated_at = ? WHERE id = ?")
        .run(now, actor.id, reason ? String(reason).slice(0, 200) : null, now, id);
      db.prepare('UPDATE holders SET revoked_at = ? WHERE card_id = ? AND revoked_at IS NULL').run(now, id);
    });
    audit.log({ actorType: actor.type ?? 'pharmacist', actorId: actor.id, action: 'card.revoke', entityType: 'card', entityId: id, patientId: card.patientId, details: { reason: reason ? 'provided' : null } });
    const revoked = getCard(id);
    await notify(revoked, 'revoke');
    return revoked;
  }

  async function notify(card, event) {
    for (const fn of listeners) {
      try {
        await fn(card, event);
      } catch (err) {
        audit.log({ actorType: 'system', action: 'wallet.notify_failed', entityType: 'card', entityId: card.id, patientId: card.patientId, details: { event, error: String(err.message).slice(0, 120) } });
      }
    }
  }

  /** Minimal, non-clinical status for the public QR verification page. */
  function publicStatus(id, s) {
    if (!/^[0-9a-f-]{36}$/.test(id) || !checkSig(id, s)) return null;
    const row = getRow.get(id);
    if (!row) return null;
    return { serial: row.serial, status: row.status, kind: row.kind, issuedAt: row.issued_at, updatedAt: row.updated_at, facility: config.facility };
  }

  const qrSvg = (text) => QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark: '#111111', light: '#ffffff' } });

  return {
    buildSnapshot, previewSnapshot, issuePhysical, ensureDigitalCard, refreshCard, refreshCardAsync, revokeCard,
    getCard, listCards, withOutdated, publicStatus, checkSig, verifyUrl, qrSvg, notify,
    onChange: (fn) => listeners.push(fn),
  };
}
