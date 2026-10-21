import fs from 'node:fs';
import http2 from 'node:http2';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import forge from 'node-forge';
import { appleConfigured } from '../config.js';
import { decryptJSON, encryptJSON, randomToken, safeEqual, sha256, uuid } from '../crypto.js';
import { addMinutes, nowIso } from '../db.js';
import { HttpError, route } from '../http.js';
import { createZip } from './zip.js';
import { ct, certaintyText, formatDate, manifestationsText, patientName, severityText, statusText, typeText } from '../../shared/cardText.js';

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'pass');
const IMAGES = ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png'];

/** Builds pass.json. Content is deliberately minimal: no national ID, HN or date of birth. */
export function buildPassJson({ snapshot, walletPass, authToken, config, revoked }) {
  const lang = snapshot?.language === 'en' ? 'en' : snapshot?.language === 'bi' ? 'bi' : 'th';
  const short = lang === 'bi' ? 'en' : lang;
  const base = {
    formatVersion: 1,
    passTypeIdentifier: config.apple.passTypeId,
    teamIdentifier: config.apple.teamId,
    serialNumber: walletPass.serial_number,
    organizationName: short === 'th' ? config.facility.nameTh : config.facility.nameEn,
    description: 'Drug allergy card',
    logoText: ct('title', short),
    foregroundColor: 'rgb(255,255,255)',
    labelColor: 'rgb(254,226,226)',
    backgroundColor: 'rgb(176,28,46)',
    sharingProhibited: true,
    suppressStripShine: true,
  };
  if (config.publicBaseUrl.startsWith('https://') || !config.production) {
    base.webServiceURL = `${config.publicBaseUrl}/wallet/apple`;
    base.authenticationToken = authToken;
  }

  if (revoked || !snapshot) {
    return {
      ...base,
      voided: true,
      generic: {
        primaryFields: [{ key: 'status', label: ct('status', short), value: ct('revoked', short) }],
        backFields: [{ key: 'contact', label: ct('emergency', short), value: `${config.facility.nameTh} / ${config.facility.nameEn} ${config.facility.phone}` }],
      },
    };
  }

  const discreet = Boolean(walletPass.discreet);
  const entries = snapshot.entries;
  const drugs = entries.map((e) => e.drugGeneric).join(', ');
  const anyConfirmed = entries.some((e) => e.certainty === 'confirmed');
  const anySuspected = entries.some((e) => e.certainty === 'suspected');
  const certaintySummary = [anyConfirmed && certaintyText('confirmed', short), anySuspected && certaintyText('suspected', short)].filter(Boolean).join(' + ');

  const backFields = entries.map((e, i) => ({
    key: `entry${i}`,
    label: `${e.drugGeneric}${e.drugBrand ? ` (${e.drugBrand})` : ''} — ${typeText(e.reactionType, lang)} · ${certaintyText(e.certainty, lang)}`,
    value: [
      `${ct('reaction', lang)}: ${manifestationsText(e.manifestations, lang)}${e.reactionNote ? ` — ${e.reactionNote}` : ''}`,
      `${ct('severity', lang)}: ${severityText(e.severity, lang)}`,
      `${ct('status', lang)}: ${statusText(e.clinicalStatus, lang)}`,
      `${ct('assessed', lang)}: ${formatDate(e.assessmentDate, short)}`,
      e.verifiedBy ? `${ct('verifiedBy', lang)}: ${e.verifiedBy.name} (${ct('license', short)} ${e.verifiedBy.licenseNo})` : '',
    ].filter(Boolean).join('\n'),
  }));
  backFields.push(
    { key: 'patient', label: ct('name', lang), value: patientName(snapshot.patient, lang) },
    { key: 'serial', label: ct('serial', lang), value: snapshot.serial },
    { key: 'contact', label: ct('emergency', lang), value: `${short === 'th' ? config.facility.nameTh : config.facility.nameEn} ${config.facility.phone}` },
    { key: 'privacy', label: 'PDPA', value: short === 'th' ? 'บัตรนี้มีข้อมูลสุขภาพซึ่งเป็นข้อมูลส่วนบุคคลอ่อนไหว โปรดเก็บรักษาอย่างปลอดภัย' : 'This pass contains sensitive health data. Keep your device secured.' },
  );

  return {
    ...base,
    voided: false,
    barcodes: [{ format: 'PKBarcodeFormatQR', message: snapshot.verifyUrl, messageEncoding: 'iso-8859-1', altText: snapshot.serial }],
    generic: {
      headerFields: [{ key: 'count', label: ct('drug', short), value: String(entries.length) }],
      primaryFields: [{ key: 'drugs', label: ct('drug', short), value: discreet ? (short === 'th' ? 'ดูรายละเอียดด้านหลัง' : 'See pass details') : drugs }],
      secondaryFields: [
        ...(discreet ? [] : [{ key: 'name', label: ct('name', short), value: patientName(snapshot.patient, short) }]),
        { key: 'certainty', label: ct('status', short), value: certaintySummary },
      ],
      auxiliaryFields: [
        { key: 'assessed', label: ct('assessed', short), value: formatDate(snapshot.assessmentDate, short) },
        { key: 'verifier', label: ct('verifiedBy', short), value: snapshot.verifiedBy?.name ?? '' },
      ],
      backFields,
    },
  };
}

/** Signs and zips a pass. Returns the .pkpass bytes. */
export function signPkpass(passJson, config) {
  const files = [{ name: 'pass.json', data: Buffer.from(JSON.stringify(passJson)) }];
  for (const img of IMAGES) {
    const p = path.join(ASSET_DIR, img);
    if (fs.existsSync(p)) files.push({ name: img, data: fs.readFileSync(p) });
  }
  const manifest = {};
  for (const f of files) manifest[f.name] = crypto.createHash('sha1').update(f.data).digest('hex');
  const manifestBuf = Buffer.from(JSON.stringify(manifest));

  const cert = forge.pki.certificateFromPem(config.apple.certPem);
  const wwdr = forge.pki.certificateFromPem(config.apple.wwdrPem);
  const key = config.apple.keyPassphrase
    ? forge.pki.decryptRsaPrivateKey(config.apple.keyPem, config.apple.keyPassphrase)
    : forge.pki.privateKeyFromPem(config.apple.keyPem);
  if (!key) throw new Error('Unable to read the pass signing key.');

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestBuf.toString('binary'));
  p7.addCertificate(cert);
  p7.addCertificate(wwdr);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  const signature = Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');

  files.push({ name: 'manifest.json', data: manifestBuf }, { name: 'signature', data: signature });
  return createZip(files);
}

export function createAppleWallet(db, keys, config, audit, cards) {
  const enabled = () => appleConfigured(config);
  const tokenAad = (id) => `applepass:${id}`;

  function passById(id) {
    return db.prepare("SELECT * FROM wallet_passes WHERE id = ? AND platform = 'apple'").get(id);
  }

  function render(wp) {
    const card = cards.getCard(wp.card_id);
    const revoked = wp.status !== 'active' || card.status !== 'active' || !card.snapshot;
    const authToken = decryptJSON(wp.auth_token_enc, keys.enc, tokenAad(wp.id));
    return signPkpass(buildPassJson({ snapshot: card.snapshot, walletPass: wp, authToken, config, revoked }), config);
  }

  /** Called after the patient explicitly confirms. Returns a one-time download URL. */
  function prepare(card, holder, { confirm, discreet }, ip) {
    if (!enabled()) throw new HttpError(503, 'APPLE_WALLET_UNAVAILABLE', 'Apple Wallet is not available at this facility yet.');
    if (confirm !== true) throw new HttpError(422, 'CONFIRMATION_REQUIRED', 'Please confirm before adding the card to Apple Wallet.');
    const id = uuid();
    const now = nowIso();
    const authToken = randomToken(24);
    db.prepare(`INSERT INTO wallet_passes (id, card_id, platform, serial_number, auth_token_enc, discreet, status, confirmed_at, created_at, updated_at, update_tag)
      VALUES (?,?, 'apple', ?,?,?, 'active', ?,?,?,?)`).run(id, card.id, uuid(), encryptJSON(authToken, keys.enc, tokenAad(id)), discreet ? 1 : 0, now, now, now, Date.now());
    db.prepare("INSERT INTO consents (id, patient_id, card_id, scope, version, method, granted_at) VALUES (?,?,?, 'wallet_apple', ?, 'patient_self', ?)")
      .run(uuid(), card.patientId, card.id, config.consentVersion, now);
    const dl = randomToken(24);
    db.prepare('INSERT INTO download_tokens (token_hash, wallet_pass_id, expires_at) VALUES (?,?,?)').run(sha256(dl), id, addMinutes(config.walletDownloadTtlSeconds / 60));
    audit.log({ actorType: 'patient', actorId: `holder:${holder.id}`, action: 'wallet.apple.confirmed', entityType: 'wallet_pass', entityId: id, patientId: card.patientId, ip, details: { discreet: Boolean(discreet) } });
    return { downloadUrl: `/wallet/apple/download/${dl}` };
  }

  /** Card change listener: marks passes updated and pushes to registered devices. */
  async function onCardChange(card, event) {
    const passes = db.prepare("SELECT * FROM wallet_passes WHERE card_id = ? AND platform = 'apple' AND status = 'active'").all(card.id);
    if (!passes.length) return;
    const now = nowIso();
    for (const wp of passes) {
      db.prepare('UPDATE wallet_passes SET updated_at = ?, update_tag = ?, status = ? WHERE id = ?').run(now, Date.now(), event === 'revoke' ? 'revoked' : 'active', wp.id);
      audit.log({ actorType: 'system', action: `wallet.apple.${event}`, entityType: 'wallet_pass', entityId: wp.id, patientId: card.patientId });
      const regs = db.prepare('SELECT push_token FROM apple_registrations WHERE serial_number = ?').all(wp.serial_number);
      for (const r of regs) await push(r.push_token);
    }
  }

  function push(pushToken) {
    if (!config.apple.apnsEnabled || !enabled()) return Promise.resolve(false);
    return new Promise((resolve) => {
      const client = http2.connect(config.apple.apnsHost, { cert: config.apple.certPem, key: config.apple.keyPem, passphrase: config.apple.keyPassphrase });
      client.on('error', () => resolve(false));
      const req = client.request({ ':method': 'POST', ':path': `/3/device/${pushToken}`, 'apns-topic': config.apple.passTypeId, 'content-type': 'application/json' });
      req.on('response', (h) => {
        if (h[':status'] === 410) db.prepare('DELETE FROM apple_registrations WHERE push_token = ?').run(pushToken);
        resolve(h[':status'] === 200);
      });
      req.on('close', () => client.close());
      req.end('{}');
    });
  }

  // ---- Apple Wallet web service (PassKit) -----------------------------------
  const router = express.Router();

  router.get('/download/:token', route((req, res) => {
    const row = db.prepare('SELECT * FROM download_tokens WHERE token_hash = ?').get(sha256(req.params.token));
    if (!row || row.used_at || row.expires_at < nowIso()) throw new HttpError(410, 'DOWNLOAD_EXPIRED', 'This download link has expired.');
    db.prepare('UPDATE download_tokens SET used_at = ? WHERE token_hash = ?').run(nowIso(), row.token_hash);
    const wp = passById(row.wallet_pass_id);
    const buf = render(wp);
    audit.log({ actorType: 'patient', action: 'wallet.apple.download', entityType: 'wallet_pass', entityId: wp.id, ip: req.ip });
    res.set({ 'Content-Type': 'application/vnd.apple.pkpass', 'Content-Disposition': 'attachment; filename="allergy-card.pkpass"' }).send(buf);
  }));

  function passAuth(req) {
    const m = /^ApplePass (.+)$/.exec(req.get('authorization') || '');
    const wp = db.prepare("SELECT * FROM wallet_passes WHERE serial_number = ? AND platform = 'apple'").get(req.params.serial);
    if (!m || !wp || req.params.passTypeId !== config.apple.passTypeId) return null;
    const token = decryptJSON(wp.auth_token_enc, keys.enc, tokenAad(wp.id));
    return safeEqual(token, m[1]) ? wp : null;
  }

  router.post('/v1/devices/:device/registrations/:passTypeId/:serial', express.json(), route((req, res) => {
    const wp = passAuth(req);
    if (!wp) return res.sendStatus(401);
    const pushToken = String(req.body?.pushToken || '');
    if (!pushToken) return res.sendStatus(400);
    const exists = db.prepare('SELECT 1 FROM apple_registrations WHERE device_library_id = ? AND pass_type_id = ? AND serial_number = ?').get(req.params.device, req.params.passTypeId, req.params.serial);
    db.prepare('INSERT OR REPLACE INTO apple_registrations (device_library_id, pass_type_id, serial_number, push_token, created_at) VALUES (?,?,?,?,?)')
      .run(req.params.device, req.params.passTypeId, req.params.serial, pushToken, nowIso());
    audit.log({ actorType: 'device', action: 'wallet.apple.register', entityType: 'wallet_pass', entityId: wp.id });
    res.sendStatus(exists ? 200 : 201);
  }));

  router.delete('/v1/devices/:device/registrations/:passTypeId/:serial', route((req, res) => {
    const wp = passAuth(req);
    if (!wp) return res.sendStatus(401);
    db.prepare('DELETE FROM apple_registrations WHERE device_library_id = ? AND pass_type_id = ? AND serial_number = ?').run(req.params.device, req.params.passTypeId, req.params.serial);
    audit.log({ actorType: 'device', action: 'wallet.apple.unregister', entityType: 'wallet_pass', entityId: wp.id });
    res.sendStatus(200);
  }));

  router.get('/v1/devices/:device/registrations/:passTypeId', route((req, res) => {
    const since = Number.parseInt(req.query.passesUpdatedSince || '0', 10) || 0;
    const rows = db.prepare(`SELECT wp.serial_number, wp.update_tag FROM apple_registrations r
      JOIN wallet_passes wp ON wp.serial_number = r.serial_number
      WHERE r.device_library_id = ? AND r.pass_type_id = ? AND wp.update_tag > ?`).all(req.params.device, req.params.passTypeId, since);
    if (!rows.length) return res.sendStatus(204);
    res.json({ serialNumbers: rows.map((r) => r.serial_number), lastUpdated: String(Math.max(...rows.map((r) => r.update_tag))) });
  }));

  router.get('/v1/passes/:passTypeId/:serial', route((req, res) => {
    const wp = passAuth(req);
    if (!wp) return res.sendStatus(401);
    const ims = req.get('if-modified-since');
    if (ims && new Date(ims).getTime() >= Math.floor(new Date(wp.updated_at).getTime() / 1000) * 1000) return res.sendStatus(304);
    audit.log({ actorType: 'device', action: 'wallet.apple.fetch', entityType: 'wallet_pass', entityId: wp.id });
    res.set({ 'Content-Type': 'application/vnd.apple.pkpass', 'Last-Modified': new Date(wp.updated_at).toUTCString() }).send(render(wp));
  }));

  router.post('/v1/log', express.json(), (req, res) => {
    const logs = Array.isArray(req.body?.logs) ? req.body.logs.slice(0, 20) : [];
    if (logs.length) audit.log({ actorType: 'device', action: 'wallet.apple.device_log', details: { count: logs.length, first: String(logs[0]).slice(0, 160) } });
    res.sendStatus(200);
  });

  return { enabled, prepare, onCardChange, render, router };
}
