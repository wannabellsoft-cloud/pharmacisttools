import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAudit } from './audit.js';
import { createAuth } from './auth.js';
import { appleConfigured, googleConfigured } from './config.js';
import { deriveKeys } from './crypto.js';
import { openDatabase } from './db.js';
import { HttpError, rateLimit, route, securityHeaders } from './http.js';
import { createAppleWallet } from './services/appleWallet.js';
import { createCardService } from './services/cards.js';
import { createClaimService } from './services/claims.js';
import { createGoogleWallet } from './services/googleWallet.js';
import { createHolderService } from './services/holders.js';
import { createPatientService } from './services/patients.js';
import { renderCardPdf } from './services/pdf.js';
import { createRetention } from './services/retention.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createApp(config, { fetchImpl } = {}) {
  const db = openDatabase(config.dbPath);
  const keys = deriveKeys(config.masterKey);
  const audit = createAudit(db, keys);
  const auth = createAuth(db, config, audit);
  const patients = createPatientService(db, keys, config, audit);
  const cards = createCardService(db, keys, config, audit, patients, (id) => (id ? auth.byId(id) : null));
  const claims = createClaimService(db, config, audit, patients, cards);
  const holders = createHolderService(db, audit, cards);
  const apple = createAppleWallet(db, keys, config, audit, cards);
  const google = createGoogleWallet(db, config, audit, cards, fetchImpl);
  cards.onChange(apple.onCardChange);
  cards.onChange(google.onCardChange);
  const retention = createRetention(db, config, audit, patients, cards);

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders(config.production));
  app.use('/api', express.json({ limit: '100kb' }));

  const P = auth.requirePharmacist;
  const actor = (req) => req.pharmacist;

  // ---------------------------------------------------------------- auth
  app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, max: 20 }), route((req, res) => {
    res.json(auth.login(req.body?.username, req.body?.password, req.ip));
  }));
  app.post('/api/auth/logout', P, route((req, res) => {
    auth.logout(req.sessionToken);
    audit.log({ actorType: 'pharmacist', actorId: req.pharmacist.id, action: 'auth.logout' });
    res.json({ ok: true });
  }));
  app.get('/api/auth/me', P, (req, res) => res.json({ pharmacist: req.pharmacist }));

  app.get('/api/config', (_req, res) => res.json({
    facility: config.facility,
    wallet: { apple: appleConfigured(config), google: googleConfigured(config) },
    claimTtlMinutes: config.claimTtlMinutes,
    claimMaxAttempts: config.claimMaxAttempts,
    consentVersion: config.consentVersion,
    retentionDays: config.recordRetentionDays,
    holderInactiveDays: config.holderInactiveDays,
  }));

  // ---------------------------------------------------------------- patients
  app.get('/api/patients', P, route((req, res) => {
    const hn = String(req.query.hn || '').trim();
    const list = hn ? patients.findByHn(hn) : patients.recentPatients();
    if (hn) audit.log({ actorType: 'pharmacist', actorId: req.pharmacist.id, action: 'patient.search', details: { found: list.length } });
    res.json({ patients: list.map((p) => ({ ...p, nationalId: undefined, idLast4: String(p.nationalId || '').slice(-4) })) });
  }));
  app.post('/api/patients', P, route((req, res) => res.status(201).json({ patient: patients.createPatient(req.body || {}, actor(req)) })));

  function patientBundle(id) {
    const patient = patients.getPatient(id);
    const records = patients.listRecords(id);
    const r = patients.readiness(id);
    return {
      patient,
      records: records.map((rec) => ({ ...rec, verifier: rec.verifiedBy ? auth.publicView(auth.byId(rec.verifiedBy) ?? { id: rec.verifiedBy, username: '', display_name: 'Unknown', license_no: '', role: '' }) : null })),
      readiness: { ready: r.ready, reasons: r.reasons, pendingCount: r.pendingCount, includedCount: r.includedCount },
      cards: cards.listCards(id),
    };
  }

  app.get('/api/patients/:id', P, route((req, res) => {
    const bundle = patientBundle(req.params.id);
    audit.log({ actorType: 'pharmacist', actorId: req.pharmacist.id, action: 'patient.view', entityType: 'patient', entityId: req.params.id, patientId: req.params.id });
    res.json(bundle);
  }));
  app.put('/api/patients/:id', P, route((req, res) => res.json({ patient: patients.updatePatient(req.params.id, req.body || {}, actor(req)) })));
  app.post('/api/patients/:id/erase', P, route(async (req, res) => {
    const who = auth.confirmPassword(req.pharmacist.id, req.body?.password);
    for (const c of cards.listCards(req.params.id).filter((c) => c.status === 'active')) await cards.revokeCard(c.id, who, 'patient_erasure');
    db.prepare('UPDATE cards SET snapshot_enc = NULL WHERE patient_id = ?').run(req.params.id);
    patients.erasePatient(req.params.id, who, String(req.body?.reason || 'data_subject_request').slice(0, 60));
    res.json({ ok: true });
  }));
  app.get('/api/patients/:id/audit', P, route((req, res) => {
    const rows = db.prepare('SELECT seq, ts, actor_type, actor_id, action, entity_type, entity_id, details FROM audit_logs WHERE patient_id = ? ORDER BY seq DESC LIMIT 200').all(req.params.id);
    res.json({ entries: rows.map(decorateAudit) });
  }));
  app.get('/api/patients/:id/consents', P, route((req, res) => {
    res.json({ consents: db.prepare('SELECT id, card_id, scope, version, method, granted_at, withdrawn_at FROM consents WHERE patient_id = ? ORDER BY granted_at DESC').all(req.params.id) });
  }));

  function decorateAudit(r) {
    let actorName = r.actor_id;
    if (r.actor_type === 'pharmacist' && r.actor_id) actorName = auth.byId(r.actor_id)?.display_name ?? r.actor_id;
    return { ...r, actorName, details: r.details ? JSON.parse(r.details) : null };
  }

  // ---------------------------------------------------------------- records
  app.post('/api/patients/:id/records', P, route((req, res) => res.status(201).json({ record: patients.createRecord(req.params.id, req.body || {}, actor(req)) })));
  app.get('/api/records/:id', P, route((req, res) => res.json({ record: patients.getRecord(req.params.id) })));
  app.put('/api/records/:id', P, route((req, res) => res.json({ record: patients.updateRecord(req.params.id, req.body || {}, actor(req)) })));
  app.post('/api/records/:id/verify', P, route((req, res) => {
    const who = auth.confirmPassword(req.pharmacist.id, req.body?.password);
    res.json({ record: patients.verifyRecord(req.params.id, req.body || {}, who) });
  }));

  // ---------------------------------------------------------------- cards
  app.get('/api/patients/:id/card-preview', P, route((req, res) => {
    res.json(cards.previewSnapshot(req.params.id, String(req.query.lang || 'bi')));
  }));
  app.post('/api/patients/:id/cards/physical', P, route((req, res) => {
    const card = cards.issuePhysical(req.params.id, req.body || {}, actor(req));
    res.status(201).json({ card: { ...card, qrSvg: null } });
  }));

  async function cardDetail(card) {
    const passes = db.prepare('SELECT id, platform, status, discreet, confirmed_at, updated_at FROM wallet_passes WHERE card_id = ? ORDER BY created_at DESC').all(card.id);
    const holderRows = db.prepare('SELECT id, created_at, last_seen_at, revoked_at FROM holders WHERE card_id = ? ORDER BY created_at DESC').all(card.id);
    const withState = cards.withOutdated(card);
    return {
      ...withState,
      qrSvg: card.snapshot?.verifyUrl ? await cards.qrSvg(card.snapshot.verifyUrl) : null,
      walletPasses: passes,
      holders: holderRows,
    };
  }

  app.get('/api/cards/:id', P, route(async (req, res) => {
    const card = cards.getCard(req.params.id);
    audit.log({ actorType: 'pharmacist', actorId: req.pharmacist.id, action: 'card.view', entityType: 'card', entityId: card.id, patientId: card.patientId });
    res.json({ card: await cardDetail(card) });
  }));
  app.get('/api/cards/:id/pdf', P, route(async (req, res) => {
    const card = cards.getCard(req.params.id);
    if (!card.snapshot) throw new HttpError(410, 'CARD_CONTENT_REMOVED', 'Card content is no longer available.');
    if (card.status !== 'active') throw new HttpError(409, 'CARD_INACTIVE', 'Inactive cards cannot be exported.');
    const format = req.query.format === 'a4' ? 'a4' : 'id1';
    const pdf = await renderCardPdf(card.snapshot, { format });
    audit.log({ actorType: 'pharmacist', actorId: req.pharmacist.id, action: 'card.export_pdf', entityType: 'card', entityId: card.id, patientId: card.patientId, details: { format } });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="allergy-card-${card.serial}-${format}.pdf"` }).send(pdf);
  }));
  app.post('/api/cards/:id/events', P, route((req, res) => {
    const type = ['print', 'print_preview'].includes(req.body?.type) ? req.body.type : null;
    if (!type) throw new HttpError(422, 'VALIDATION', 'Unknown event.');
    const card = cards.getCard(req.params.id);
    audit.log({ actorType: 'pharmacist', actorId: req.pharmacist.id, action: `card.${type}`, entityType: 'card', entityId: card.id, patientId: card.patientId, details: { format: req.body?.format === 'a4' ? 'a4' : 'id1' } });
    res.json({ ok: true });
  }));
  app.post('/api/cards/:id/revoke', P, route(async (req, res) => {
    const who = auth.confirmPassword(req.pharmacist.id, req.body?.password);
    const card = await cards.revokeCard(req.params.id, who, req.body?.reason);
    res.json({ card: await cardDetail(card) });
  }));
  app.post('/api/cards/:id/refresh', P, route(async (req, res) => {
    const card = await cards.refreshCardAsync(req.params.id, actor(req));
    res.json({ card: await cardDetail(card) });
  }));

  // Full card details for a signed-in pharmacist who scanned a card QR.
  app.get('/api/verify/:id', P, route(async (req, res) => {
    if (!cards.checkSig(req.params.id, req.query.s)) throw new HttpError(404, 'NOT_FOUND', 'Card not found.');
    const card = cards.getCard(req.params.id);
    audit.log({ actorType: 'pharmacist', actorId: req.pharmacist.id, action: 'card.verify_view', entityType: 'card', entityId: card.id, patientId: card.patientId });
    res.json({ card: await cardDetail(card) });
  }));

  // ---------------------------------------------------------------- claims (pharmacist)
  app.post('/api/patients/:id/claims', P, route(async (req, res) => {
    const claim = claims.createClaim(req.params.id, actor(req), req.ip);
    res.status(201).json({ claim: { ...claim, qrSvg: await cards.qrSvg(claim.url) } });
  }));
  app.get('/api/claims/:id', P, route((req, res) => res.json({ claim: claims.claimStatus(req.params.id) })));
  app.post('/api/claims/:id/cancel', P, route((req, res) => res.json({ claim: claims.cancelClaim(req.params.id, actor(req)) })));

  // ---------------------------------------------------------------- claim (patient, public)
  const claimLimiter = rateLimit({ windowMs: 10 * 60_000, max: 30 });
  app.post('/api/claim/start', claimLimiter, route((req, res) => res.json(claims.start(req.body?.token, req.ip))));
  app.post('/api/claim/verify', claimLimiter, route((req, res) => res.json(claims.verifyIdentity(req.body?.token, req.body || {}, req.ip))));
  app.get('/api/claim/session', claims.requireClaimSession, route((req, res) => res.json(claims.sessionView(req.claim, String(req.query.lang || 'th')))));
  app.post('/api/claim/complete', claims.requireClaimSession, route(async (req, res) => res.json(await claims.complete(req.claim, req.body || {}, req.ip))));

  // ---------------------------------------------------------------- holder (patient device)
  const H = holders.requireHolder;
  app.get('/api/holder/card', H, route(async (req, res) => {
    const view = holders.view(req.holder, req.ip);
    if (view.snapshot) view.qrSvg = await cards.qrSvg(view.snapshot.verifyUrl);
    res.json({ ...view, wallet: { apple: apple.enabled(), google: google.enabled() } });
  }));
  app.get('/api/holder/card.pdf', H, route(async (req, res) => {
    const card = holders.requireActiveCard(req.holder);
    const pdf = await renderCardPdf(card.snapshot, { format: 'a4' });
    audit.log({ actorType: 'patient', actorId: `holder:${req.holder.id}`, action: 'holder.export_pdf', entityType: 'card', entityId: card.id, patientId: card.patientId });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="allergy-card-${card.serial}.pdf"` }).send(pdf);
  }));
  app.post('/api/holder/wallet/apple', H, route((req, res) => {
    const card = holders.requireActiveCard(req.holder);
    res.json(apple.prepare(card, req.holder, req.body || {}, req.ip));
  }));
  app.post('/api/holder/wallet/google', H, route(async (req, res) => {
    const card = holders.requireActiveCard(req.holder);
    res.json(await google.prepare(card, req.holder, req.body || {}, req.ip));
  }));
  app.post('/api/holder/withdraw', H, route(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(422, 'CONFIRMATION_REQUIRED', 'Please confirm the withdrawal.');
    await holders.withdraw(req.holder, req.ip);
    res.json({ ok: true });
  }));
  app.post('/api/holder/forget', H, route((req, res) => {
    db.prepare('UPDATE holders SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), req.holder.id);
    audit.log({ actorType: 'patient', actorId: `holder:${req.holder.id}`, action: 'holder.remove_device', entityType: 'card', entityId: req.holder.card_id });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- wallet web service
  app.use('/wallet/apple', apple.router);

  // ---------------------------------------------------------------- admin
  app.get('/api/admin/audit', P, auth.requireAdmin, route((req, res) => {
    const before = Number.parseInt(req.query.before || '0', 10) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare('SELECT * FROM audit_logs WHERE seq < ? ORDER BY seq DESC LIMIT 100').all(before);
    res.json({ entries: rows.map(decorateAudit), chain: audit.verifyChain() });
  }));
  app.post('/api/admin/retention/run', P, auth.requireAdmin, route(async (req, res) => {
    audit.log({ actorType: 'pharmacist', actorId: req.pharmacist.id, action: 'retention.manual_run' });
    res.json({ result: await retention.run() });
  }));

  // ---------------------------------------------------------------- public QR verification
  // Shows authenticity and status only. Clinical details require pharmacist sign-in.
  app.get('/v/:id', rateLimit({ windowMs: 60_000, max: 60 }), (req, res) => {
    const status = cards.publicStatus(req.params.id, String(req.query.s || ''));
    if (status) audit.log({ actorType: 'public', action: 'card.qr_scan', entityType: 'card', entityId: req.params.id, ip: req.ip, details: { status: status.status } });
    res.status(status ? 200 : 404).type('html').send(verifyPage(status, req.params.id, String(req.query.s || '')));
  });

  function verifyPage(s, id, sig) {
    const states = {
      active: ['ok', 'บัตรนี้ถูกต้องและยังมีผล', 'This card is authentic and active'],
      superseded: ['warn', 'มีบัตรฉบับใหม่กว่า โปรดสอบถามผู้ป่วย', 'A newer card has been issued — ask the patient'],
      revoked: ['bad', 'บัตรนี้ถูกยกเลิกแล้ว', 'This card has been revoked'],
    };
    const [tone, th, en] = s ? states[s.status] : ['bad', 'ไม่พบบัตร หรือ QR ไม่ถูกต้อง', 'Card not found or QR code is invalid'];
    const facility = escapeHtml(config.facility.nameTh) + ' / ' + escapeHtml(config.facility.nameEn);
    const signIn = s ? `<a class="btn btn-primary" href="/#/verify/${escapeHtml(id)}?s=${escapeHtml(sig)}">เข้าสู่ระบบเภสัชกรเพื่อดูรายละเอียด · Pharmacist sign-in for details</a>` : '';
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Card verification · PharmaTools</title><link rel="stylesheet" href="/css/app.css"></head>
<body class="public"><main class="public-wrap"><div class="verify-card verify-${tone}">
<div class="verify-icon" aria-hidden="true">${tone === 'ok' ? '✓' : '!'}</div>
<h1>${th}</h1><p class="muted">${en}</p>
${s ? `<dl class="kv"><dt>เลขที่บัตร · Card No.</dt><dd>${escapeHtml(s.serial)}</dd><dt>ชนิด · Type</dt><dd>${s.kind === 'physical' ? 'บัตรพิมพ์ · Printed' : 'ดิจิทัล · Digital'}</dd><dt>ออกบัตร · Issued</dt><dd>${escapeHtml(s.issuedAt.slice(0, 10))}</dd><dt>ผู้ออกบัตร · Issuer</dt><dd>${facility}</dd></dl>` : ''}
<p class="fine">หน้านี้แสดงเฉพาะสถานะของบัตร ไม่แสดงข้อมูลสุขภาพ ข้อมูลการแพ้ยาให้อ่านจากบัตรของผู้ป่วยหรือเข้าสู่ระบบโดยบุคลากรที่ได้รับอนุญาต<br>
This page confirms card status only and shows no health data. Read allergy details from the patient's card, or sign in as authorized staff.</p>
${signIn}</div></main></body></html>`;
  }

  // ---------------------------------------------------------------- static PWA
  app.use('/shared', express.static(path.join(ROOT, 'shared'), { maxAge: 0 }));
  app.get('/claim', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'claim.html')));
  app.get('/card', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'card.html')));
  app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0, index: 'index.html' }));

  // ---------------------------------------------------------------- errors
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Not found.')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON.' } });
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected error.' } });
  });

  return { app, db, auth, audit, patients, cards, claims, holders, apple, google, retention, keys };
}
