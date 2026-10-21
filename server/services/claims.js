import { randomToken, sha256, uuid, safeEqual } from '../crypto.js';
import { addMinutes, nowIso, tx } from '../db.js';
import { HttpError } from '../http.js';

const CONSENT_SCOPES = ['health_data_processing', 'digital_card'];

// Generic error so a scanner cannot tell an unknown token from an expired or used one.
const invalidClaim = () => new HttpError(404, 'CLAIM_INVALID', 'This link is invalid or has expired. Please ask the pharmacist for a new QR code.');

function normalizeDob(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

export function createClaimService(db, config, audit, patients, cards) {
  const byTokenHash = db.prepare('SELECT * FROM claims WHERE token_hash = ?');
  const byId = db.prepare('SELECT * FROM claims WHERE id = ?');

  function expireIfNeeded(claim) {
    if (['pending', 'verified'].includes(claim.status) && claim.expires_at < nowIso() && !(claim.status === 'verified' && claim.session_expires_at > nowIso())) {
      db.prepare("UPDATE claims SET status = 'expired', session_hash = NULL WHERE id = ?").run(claim.id);
      audit.log({ actorType: 'system', action: 'claim.expired', entityType: 'claim', entityId: claim.id, patientId: claim.patient_id });
      return { ...claim, status: 'expired' };
    }
    return claim;
  }

  function createClaim(patientId, actor, ip) {
    const ready = patients.readiness(patientId);
    if (!ready.ready) throw new HttpError(409, 'NOT_READY', 'All allergy records must be verified before issuing a digital card.', { reasons: ready.reasons });
    const token = randomToken(32);
    const id = uuid();
    const expiresAt = addMinutes(config.claimTtlMinutes);
    tx(db, () => {
      // Only one outstanding claim per patient.
      db.prepare("UPDATE claims SET status = 'cancelled', session_hash = NULL WHERE patient_id = ? AND status IN ('pending','verified')").run(patientId);
      db.prepare("INSERT INTO claims (id, token_hash, patient_id, created_by, created_at, expires_at, status) VALUES (?,?,?,?,?,?, 'pending')")
        .run(id, sha256(token), patientId, actor.id, nowIso(), expiresAt);
    });
    audit.log({ actorType: 'pharmacist', actorId: actor.id, action: 'claim.create', entityType: 'claim', entityId: id, patientId, ip, details: { ttlMinutes: config.claimTtlMinutes } });
    // The token travels in the URL fragment, which browsers never send to servers or in Referer headers.
    const url = `${config.publicBaseUrl}/claim#t=${token}`;
    return { id, url, expiresAt, status: 'pending' };
  }

  function claimStatus(id) {
    const row = byId.get(id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Claim not found.');
    const c = expireIfNeeded(row);
    return { id: c.id, patientId: c.patient_id, status: c.status, expiresAt: c.expires_at, attempts: c.attempts, verifiedAt: c.verified_at, completedAt: c.completed_at, cardId: c.card_id };
  }

  function cancelClaim(id, actor) {
    const c = byId.get(id);
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Claim not found.');
    if (['pending', 'verified'].includes(c.status)) {
      db.prepare("UPDATE claims SET status = 'cancelled', session_hash = NULL WHERE id = ?").run(id);
      audit.log({ actorType: 'pharmacist', actorId: actor.id, action: 'claim.cancel', entityType: 'claim', entityId: id, patientId: c.patient_id });
    }
    return claimStatus(id);
  }

  function loadPending(token) {
    if (typeof token !== 'string' || token.length < 30) throw invalidClaim();
    const row = byTokenHash.get(sha256(token));
    if (!row) throw invalidClaim();
    const c = expireIfNeeded(row);
    if (c.status !== 'pending') throw invalidClaim();
    return c;
  }

  /** First contact from the patient's phone. Reveals no personal data. */
  function start(token, ip) {
    const c = loadPending(token);
    audit.log({ actorType: 'patient', action: 'claim.open', entityType: 'claim', entityId: c.id, patientId: c.patient_id, ip });
    return { status: 'pending', expiresAt: c.expires_at, attemptsRemaining: config.claimMaxAttempts - c.attempts, facility: config.facility };
  }

  /** Patient proves identity with date of birth and the last 4 characters of their ID. */
  function verifyIdentity(token, { dob, idLast4 }, ip) {
    const c = loadPending(token);
    const patient = patients.getPatient(c.patient_id);
    const expectedLast4 = String(patient.nationalId || '').replace(/[\s-]/g, '').slice(-4).toUpperCase();
    const givenLast4 = String(idLast4 || '').replace(/[\s-]/g, '').toUpperCase();
    const ok = !patient.erased && expectedLast4.length === 4 && safeEqual(normalizeDob(dob), patient.dob) && safeEqual(givenLast4, expectedLast4);
    if (!ok) {
      const attempts = c.attempts + 1;
      const locked = attempts >= config.claimMaxAttempts;
      db.prepare('UPDATE claims SET attempts = ?, status = ? WHERE id = ?').run(attempts, locked ? 'locked' : 'pending', c.id);
      audit.log({ actorType: 'patient', action: locked ? 'claim.locked' : 'claim.verify_failed', entityType: 'claim', entityId: c.id, patientId: c.patient_id, ip, details: { attempts } });
      if (locked) throw new HttpError(423, 'CLAIM_LOCKED', 'Too many unsuccessful attempts. Please ask the pharmacist for a new QR code.');
      throw new HttpError(401, 'IDENTITY_MISMATCH', 'The details do not match our records.', { attemptsRemaining: config.claimMaxAttempts - attempts });
    }
    const session = randomToken(32);
    db.prepare("UPDATE claims SET status = 'verified', verified_at = ?, session_hash = ?, session_expires_at = ? WHERE id = ? AND status = 'pending'")
      .run(nowIso(), sha256(session), addMinutes(config.claimSessionTtlMinutes), c.id);
    audit.log({ actorType: 'patient', action: 'claim.verified', entityType: 'claim', entityId: c.id, patientId: c.patient_id, ip });
    return { session, sessionExpiresAt: addMinutes(config.claimSessionTtlMinutes) };
  }

  /** Middleware for routes used after identity verification ("Authorization: Claim <session>"). */
  function requireClaimSession(req, _res, next) {
    const m = /^Claim (.+)$/.exec(req.get('authorization') || '');
    const row = m && db.prepare("SELECT * FROM claims WHERE session_hash = ? AND status = 'verified' AND session_expires_at > ?").get(sha256(m[1]), nowIso());
    if (!row) return next(new HttpError(401, 'CLAIM_SESSION_INVALID', 'Your session has expired. Please scan a new QR code.'));
    req.claim = row;
    next();
  }

  function sessionView(claim, language = 'th') {
    const { snapshot, readiness } = cards.previewSnapshot(claim.patient_id, language);
    if (!readiness.ready) throw new HttpError(409, 'NOT_READY', 'Your record is being updated by the pharmacist. Please ask for a new QR code.');
    return {
      sessionExpiresAt: claim.session_expires_at,
      consentVersion: config.consentVersion,
      retentionDays: config.recordRetentionDays,
      holderInactiveDays: config.holderInactiveDays,
      facility: config.facility,
      snapshot: { ...snapshot, preview: false, serial: null, verifyUrl: null },
    };
  }

  /** Records explicit consent, issues (or reuses) the digital card and returns a device access token. */
  async function complete(claim, { consents = {}, language = 'th' }, ip) {
    const missing = CONSENT_SCOPES.filter((s) => consents[s] !== true);
    if (missing.length) throw new HttpError(422, 'CONSENT_REQUIRED', 'Consent is required to create a digital card.', { missing });
    const actor = { type: 'patient', id: `claim:${claim.id}` };
    const card = await cards.ensureDigitalCard(claim.patient_id, ['th', 'en', 'bi'].includes(language) ? language : 'th', actor);
    const holderToken = randomToken(32);
    const now = nowIso();
    tx(db, () => {
      db.prepare('INSERT INTO holders (id, card_id, token_hash, created_at, last_seen_at) VALUES (?,?,?,?,?)').run(uuid(), card.id, sha256(holderToken), now, now);
      for (const scope of CONSENT_SCOPES) {
        db.prepare("INSERT INTO consents (id, patient_id, card_id, scope, version, method, granted_at) VALUES (?,?,?,?,?, 'patient_self', ?)")
          .run(uuid(), claim.patient_id, card.id, scope, config.consentVersion, now);
      }
      db.prepare("UPDATE claims SET status = 'completed', completed_at = ?, card_id = ?, session_hash = NULL WHERE id = ?").run(now, card.id, claim.id);
    });
    audit.log({ actorType: 'patient', actorId: actor.id, action: 'claim.completed', entityType: 'claim', entityId: claim.id, patientId: claim.patient_id, ip, details: { cardId: card.id, consentVersion: config.consentVersion } });
    return { holderToken, cardId: card.id };
  }

  return { createClaim, claimStatus, cancelClaim, start, verifyIdentity, requireClaimSession, sessionView, complete };
}
