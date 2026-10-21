import crypto from 'node:crypto';
import { googleConfigured } from '../config.js';
import { uuid } from '../crypto.js';
import { nowIso } from '../db.js';
import { HttpError } from '../http.js';
import { ct, certaintyText, formatDate, manifestationsText, patientName, severityText, statusText, typeText } from '../../shared/cardText.js';

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export function signJwtRS256(payload, privateKeyPem, header = {}) {
  const head = b64url({ alg: 'RS256', typ: 'JWT', ...header });
  const body = b64url(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKeyPem).toString('base64url');
  return `${head}.${body}.${sig}`;
}

// REST resource names per pass type. Health information may only be issued
// through a pass type that Google has approved for the issuer account; the
// operator selects it with GOOGLE_WALLET_PASS_TYPE and attests approval with
// GOOGLE_WALLET_HEALTH_PASS_APPROVED=true.
const PASS_TYPES = {
  generic: { classPath: 'genericClass', objectPath: 'genericObject', jwtKey: 'genericObjects' },
};

/** Builds the Google Wallet object. Like the Apple pass, it omits national ID, HN and DOB. */
export function buildGoogleObject({ snapshot, walletPass, config, revoked }) {
  const issuer = config.google.issuerId;
  const lang = snapshot?.language === 'en' ? 'en' : snapshot?.language === 'bi' ? 'bi' : 'th';
  const short = lang === 'bi' ? 'en' : lang;
  const langTag = short === 'th' ? 'th' : 'en';
  const lv = (value) => ({ defaultValue: { language: langTag, value } });
  const obj = {
    id: `${issuer}.${walletPass.id}`,
    classId: `${issuer}.${config.google.classSuffix}`,
    state: revoked ? 'INACTIVE' : 'ACTIVE',
    hexBackgroundColor: '#b01c2e',
    cardTitle: lv(short === 'th' ? config.facility.nameTh : config.facility.nameEn),
    header: lv(ct('title', short)),
  };
  if (config.google.logoUrl) obj.logo = { sourceUri: { uri: config.google.logoUrl } };
  if (revoked || !snapshot) {
    return { ...obj, subheader: lv(ct('status', short)), header: lv(ct('revoked', short)), textModulesData: [] };
  }
  const discreet = Boolean(walletPass.discreet);
  obj.subheader = lv(discreet ? ct('title', short) : patientName(snapshot.patient, short));
  if (discreet) obj.header = lv(ct('title', short));
  else obj.header = lv(snapshot.entries.map((e) => e.drugGeneric).join(', '));
  obj.barcode = { type: 'QR_CODE', value: snapshot.verifyUrl, alternateText: snapshot.serial };
  obj.textModulesData = [
    ...snapshot.entries.map((e, i) => ({
      id: `entry${i}`,
      header: `${e.drugGeneric} — ${typeText(e.reactionType, lang)} · ${certaintyText(e.certainty, lang)}`,
      body: [
        `${ct('reaction', lang)}: ${manifestationsText(e.manifestations, lang)}`,
        `${ct('severity', lang)}: ${severityText(e.severity, lang)}`,
        `${ct('status', lang)}: ${statusText(e.clinicalStatus, lang)}`,
        `${ct('assessed', lang)}: ${formatDate(e.assessmentDate, short)}`,
        e.verifiedBy ? `${ct('verifiedBy', lang)}: ${e.verifiedBy.name}` : '',
      ].filter(Boolean).join('\n'),
    })),
    { id: 'contact', header: ct('emergency', lang), body: `${config.facility.nameEn} ${config.facility.phone}` },
  ];
  return obj;
}

export function createGoogleWallet(db, config, audit, cards, fetchImpl = globalThis.fetch) {
  const enabled = () => googleConfigured(config);
  const type = () => PASS_TYPES[config.google.passType] ?? PASS_TYPES.generic;
  let cachedToken = null;

  async function accessToken() {
    if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;
    const sa = config.google.serviceAccount;
    const now = Math.floor(Date.now() / 1000);
    const assertion = signJwtRS256({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
      aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    }, sa.private_key);
    const res = await fetchImpl(sa.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`Google OAuth failed (${res.status})`);
    const json = await res.json();
    cachedToken = { value: json.access_token, exp: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return cachedToken.value;
  }

  async function api(method, pathName, body) {
    const res = await fetchImpl(`${config.google.apiBase}/${pathName}`, {
      method, headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  async function ensureClass() {
    const id = `${config.google.issuerId}.${config.google.classSuffix}`;
    const got = await api('GET', `${type().classPath}/${id}`);
    if (got.ok) return;
    if (got.status !== 404) throw new Error(`Google Wallet class lookup failed (${got.status})`);
    const created = await api('POST', type().classPath, { id, multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES' });
    if (!created.ok) throw new Error(`Google Wallet class creation failed (${created.status})`);
  }

  /** Creates the object server-side, then returns a "skinny" save JWT that references it by ID only. */
  async function prepare(card, holder, { confirm, discreet }, ip) {
    if (!enabled()) throw new HttpError(503, 'GOOGLE_WALLET_UNAVAILABLE', 'Google Wallet is not available at this facility yet.');
    if (confirm !== true) throw new HttpError(422, 'CONFIRMATION_REQUIRED', 'Please confirm before adding the card to Google Wallet.');
    const id = uuid();
    const now = nowIso();
    const wp = { id, discreet: discreet ? 1 : 0 };
    await ensureClass();
    const object = buildGoogleObject({ snapshot: card.snapshot, walletPass: wp, config, revoked: false });
    const res = await api('POST', type().objectPath, object);
    if (!res.ok) throw new HttpError(502, 'GOOGLE_WALLET_ERROR', 'Google Wallet is temporarily unavailable. Please use the web card or PDF.');
    db.prepare(`INSERT INTO wallet_passes (id, card_id, platform, serial_number, google_object_id, discreet, status, confirmed_at, created_at, updated_at, update_tag)
      VALUES (?,?, 'google', ?,?,?, 'active', ?,?,?,?)`).run(id, card.id, uuid(), object.id, wp.discreet, now, now, now, Date.now());
    db.prepare("INSERT INTO consents (id, patient_id, card_id, scope, version, method, granted_at) VALUES (?,?,?, 'wallet_google', ?, 'patient_self', ?)")
      .run(uuid(), card.patientId, card.id, config.consentVersion, now);
    const sa = config.google.serviceAccount;
    const jwt = signJwtRS256({
      iss: sa.client_email, aud: 'google', typ: 'savetowallet', iat: Math.floor(Date.now() / 1000),
      origins: config.google.origins.length ? config.google.origins : [config.publicBaseUrl],
      payload: { [type().jwtKey]: [{ id: object.id }] },
    }, sa.private_key);
    audit.log({ actorType: 'patient', actorId: `holder:${holder.id}`, action: 'wallet.google.confirmed', entityType: 'wallet_pass', entityId: id, patientId: card.patientId, ip, details: { discreet: Boolean(discreet) } });
    return { saveUrl: `https://pay.google.com/gp/v/save/${jwt}` };
  }

  async function onCardChange(card, event) {
    if (!enabled()) return;
    const passes = db.prepare("SELECT * FROM wallet_passes WHERE card_id = ? AND platform = 'google' AND status = 'active'").all(card.id);
    for (const wp of passes) {
      const revoked = event === 'revoke';
      const object = buildGoogleObject({ snapshot: revoked ? null : card.snapshot, walletPass: wp, config, revoked });
      const res = await api('PUT', `${type().objectPath}/${wp.google_object_id}`, object);
      if (!res.ok) throw new Error(`Google Wallet update failed (${res.status})`);
      db.prepare('UPDATE wallet_passes SET status = ?, updated_at = ?, update_tag = ? WHERE id = ?').run(revoked ? 'revoked' : 'active', nowIso(), Date.now(), wp.id);
      audit.log({ actorType: 'system', action: `wallet.google.${event}`, entityType: 'wallet_pass', entityId: wp.id, patientId: card.patientId });
    }
  }

  return { enabled, prepare, onCardChange };
}
