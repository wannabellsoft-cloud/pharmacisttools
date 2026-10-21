import { addDays, nowIso } from '../db.js';

/**
 * PDPA data-retention job. Removes data once it is no longer needed:
 * - expired claim links and their sessions
 * - used/expired Wallet download links and stale pharmacist sessions
 * - Digital Web Card device tokens unused for HOLDER_INACTIVE_DAYS
 * - patient data past its retention date (crypto-shredded; audit trail kept)
 * - audit entries older than AUDIT_RETENTION_DAYS
 */
export function createRetention(db, config, audit, patients, cards) {
  async function run() {
    const now = nowIso();
    const result = {};
    result.claimsExpired = db.prepare("UPDATE claims SET status = 'expired', session_hash = NULL WHERE status IN ('pending','verified') AND expires_at < ? AND (session_expires_at IS NULL OR session_expires_at < ?)").run(now, now).changes;
    result.claimsPurged = db.prepare("DELETE FROM claims WHERE status <> 'completed' AND created_at < ?").run(addDays(-config.claimPurgeDays)).changes;
    result.downloadTokensPurged = db.prepare('DELETE FROM download_tokens WHERE expires_at < ? OR used_at IS NOT NULL').run(now).changes;
    result.sessionsPurged = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now).changes;
    result.holdersExpired = db.prepare('UPDATE holders SET revoked_at = ? WHERE revoked_at IS NULL AND last_seen_at < ?').run(now, addDays(-config.holderInactiveDays)).changes;

    const due = db.prepare('SELECT id FROM patients WHERE erased_at IS NULL AND retain_until < ?').all(now);
    for (const { id } of due) {
      for (const c of db.prepare("SELECT id FROM cards WHERE patient_id = ? AND status = 'active'").all(id)) {
        await cards.revokeCard(c.id, { type: 'system', id: 'retention' }, 'retention_expired');
      }
      db.prepare('UPDATE cards SET snapshot_enc = NULL WHERE patient_id = ?').run(id);
      patients.erasePatient(id, { type: 'system', id: 'retention' }, 'retention_expired');
    }
    result.patientsErased = due.length;
    result.auditPurged = db.prepare('DELETE FROM audit_logs WHERE ts < ?').run(addDays(-config.auditRetentionDays)).changes;

    const touched = Object.values(result).some((n) => n > 0);
    if (touched) audit.log({ actorType: 'system', action: 'retention.run', details: result });
    return result;
  }

  let timer = null;
  return {
    run,
    start(intervalMs = 60 * 60 * 1000) {
      const tick = () => run().catch((err) => console.error('[retention]', err));
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
