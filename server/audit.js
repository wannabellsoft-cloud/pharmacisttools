import { sha256, hmac } from './crypto.js';
import { nowIso } from './db.js';

const GENESIS = '0'.repeat(64);

function rowDigest(prevHash, r) {
  return sha256(
    JSON.stringify([prevHash, r.ts, r.actor_type, r.actor_id, r.action, r.entity_type, r.entity_id, r.patient_id, r.ip_pseudo, r.details]),
  );
}

export function createAudit(db, keys) {
  const last = db.prepare('SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1');
  const insert = db.prepare(`INSERT INTO audit_logs
    (ts, actor_type, actor_id, action, entity_type, entity_id, patient_id, ip_pseudo, details, prev_hash, hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  /**
   * Appends an audit entry. `details` must never include names, national IDs,
   * dates of birth or clinical free text — only identifiers and codes.
   */
  function log({ actorType, actorId = null, action, entityType = null, entityId = null, patientId = null, ip = null, details = null }) {
    const prev = last.get()?.hash ?? GENESIS;
    const row = {
      ts: nowIso(),
      actor_type: actorType,
      actor_id: actorId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      patient_id: patientId,
      ip_pseudo: ip ? hmac(ip, keys.pseudo, 8) : null,
      details: details ? JSON.stringify(details) : null,
    };
    const hash = rowDigest(prev, row);
    insert.run(row.ts, row.actor_type, row.actor_id, row.action, row.entity_type, row.entity_id, row.patient_id, row.ip_pseudo, row.details, prev, hash);
  }

  /** Verifies the hash chain. Entries removed by retention leave a valid anchor at the oldest remaining row. */
  function verifyChain() {
    const rows = db.prepare('SELECT * FROM audit_logs ORDER BY seq ASC').all();
    let prev = rows[0]?.prev_hash ?? GENESIS;
    for (const r of rows) {
      if (r.prev_hash !== prev || rowDigest(prev, r) !== r.hash) return { ok: false, brokenAt: r.seq, count: rows.length };
      prev = r.hash;
    }
    return { ok: true, count: rows.length };
  }

  return { log, verifyChain };
}
