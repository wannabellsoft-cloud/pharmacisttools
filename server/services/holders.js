import { sha256 } from '../crypto.js';
import { nowIso, tx } from '../db.js';
import { HttpError } from '../http.js';

export function createHolderService(db, audit, cards) {
  /** Middleware: "Authorization: Holder <token>" identifies a patient device holding a digital card. */
  function requireHolder(req, _res, next) {
    const m = /^Holder (.+)$/.exec(req.get('authorization') || '');
    const holder = m && db.prepare('SELECT * FROM holders WHERE token_hash = ?').get(sha256(m[1]));
    if (!holder) return next(new HttpError(401, 'HOLDER_INVALID', 'This digital card is no longer available on this device.'));
    req.holder = holder;
    next();
  }

  /** Card data for the device. Revoked or withdrawn cards return status only, never clinical data. */
  function view(holder, ip) {
    const card = cards.getCard(holder.card_id);
    db.prepare('UPDATE holders SET last_seen_at = ? WHERE id = ?').run(nowIso(), holder.id);
    if (holder.revoked_at || card.status !== 'active' || !card.snapshot) {
      return { status: card.status === 'active' ? 'revoked' : card.status, serial: card.serial, updatedAt: card.updatedAt };
    }
    audit.log({ actorType: 'patient', actorId: `holder:${holder.id}`, action: 'holder.view', entityType: 'card', entityId: card.id, patientId: card.patientId, ip });
    return { status: 'active', serial: card.serial, version: card.version, updatedAt: card.updatedAt, snapshot: card.snapshot, qrSvg: null };
  }

  function requireActiveCard(holder) {
    const card = cards.getCard(holder.card_id);
    if (holder.revoked_at || card.status !== 'active' || !card.snapshot) throw new HttpError(410, 'CARD_INACTIVE', 'This card is no longer valid.');
    return card;
  }

  /**
   * PDPA withdrawal of consent: revokes the digital card on every device and Wallet,
   * and deletes the stored digital card content. Clinical records held by the
   * facility are governed by its medical-records retention policy.
   */
  async function withdraw(holder, ip) {
    const card = cards.getCard(holder.card_id);
    const now = nowIso();
    await cards.revokeCard(card.id, { type: 'patient', id: `holder:${holder.id}` }, 'consent_withdrawn');
    tx(db, () => {
      db.prepare('UPDATE consents SET withdrawn_at = ? WHERE card_id = ? AND withdrawn_at IS NULL').run(now, card.id);
      db.prepare('UPDATE cards SET snapshot_enc = NULL WHERE id = ?').run(card.id);
    });
    audit.log({ actorType: 'patient', actorId: `holder:${holder.id}`, action: 'consent.withdraw', entityType: 'card', entityId: card.id, patientId: card.patientId, ip });
  }

  return { requireHolder, view, requireActiveCard, withdraw };
}
