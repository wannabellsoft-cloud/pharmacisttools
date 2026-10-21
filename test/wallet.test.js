import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import forge from 'node-forge';
import { startServer, PATIENT, RECORD } from './helpers.js';
import { readZip } from '../server/services/zip.js';

function selfSigned(cn, issuer) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Math.floor(Math.random() * 1e9));
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : [{ name: 'commonName', value: cn }]);
  cert.setExtensions([{ name: 'basicConstraints', cA: !issuer }]);
  cert.sign(issuer ? issuer.keys.privateKey : keys.privateKey, forge.md.sha256.create());
  return { keys, cert, certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

const googleKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const googleCalls = [];
async function fakeGoogleFetch(url, opts = {}) {
  googleCalls.push({ url: String(url), method: opts.method, body: opts.body ? String(opts.body) : null });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (String(url).includes('oauth2')) return json(200, { access_token: 'test-token', expires_in: 3600 });
  if (opts.method === 'GET') return json(404, {});
  return json(200, {});
}

let t;
let token;
let wwdr;
before(async () => {
  wwdr = selfSigned('Test WWDR');
  const passCert = selfSigned('Pass Type ID: pass.test.allergy', wwdr);
  t = await startServer({
    env: { APPLE_PASS_TYPE_ID: 'pass.test.allergy', APPLE_TEAM_ID: 'TEAM123456', GOOGLE_WALLET_ISSUER_ID: '3388000000000000000', GOOGLE_WALLET_HEALTH_PASS_APPROVED: 'true' },
    overrides: {
      appleCertPem: passCert.certPem, appleKeyPem: passCert.keyPem, appleWwdrPem: wwdr.certPem,
      googleServiceAccount: { client_email: 'wallet@test.iam.gserviceaccount.com', private_key: googleKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' },
    },
    fetchImpl: fakeGoogleFetch,
  });
  token = await t.login();
});
after(() => t.close());

async function holderFor(hn) {
  const p = await t.call('POST', '/api/patients', { token, body: { ...PATIENT, hn } });
  const pid = p.body.patient.id;
  const r = await t.call('POST', `/api/patients/${pid}/records`, { token, body: RECORD });
  await t.call('POST', `/api/records/${r.body.record.id}/verify`, { token, body: { password: 'alice-password', attest: true } });
  const claim = await t.call('POST', `/api/patients/${pid}/claims`, { token });
  const tok = new URL(claim.body.claim.url).hash.replace('#t=', '');
  const s = (await t.call('POST', '/api/claim/verify', { body: { token: tok, dob: PATIENT.dob, idLast4: '1811' } })).body.session;
  const done = await t.call('POST', '/api/claim/complete', { auth: `Claim ${s}`, body: { consents: { health_data_processing: true, digital_card: true }, language: 'bi' } });
  return { pid, recordId: r.body.record.id, cardId: done.body.cardId, holder: `Holder ${done.body.holderToken}` };
}

test('Apple Wallet: confirmation, signed .pkpass, minimal content, updates and revocation', async () => {
  const h = await holderFor('APL-1');
  assert.equal((await t.call('POST', '/api/holder/wallet/apple', { auth: h.holder, body: {} })).status, 422, 'explicit confirmation required');
  const prep = await t.call('POST', '/api/holder/wallet/apple', { auth: h.holder, body: { confirm: true, discreet: false } });
  assert.equal(prep.status, 200);

  const dl = await t.call('GET', prep.body.downloadUrl, { raw: true });
  assert.equal(dl.headers.get('content-type'), 'application/vnd.apple.pkpass');
  const files = readZip(Buffer.from(await dl.arrayBuffer()));
  assert.equal((await t.call('GET', prep.body.downloadUrl)).status, 410, 'download link is single-use');

  const manifest = JSON.parse(files['manifest.json']);
  for (const [name, sha1] of Object.entries(manifest)) {
    assert.equal(crypto.createHash('sha1').update(files[name]).digest('hex'), sha1, `manifest hash for ${name}`);
  }
  const pass = JSON.parse(files['pass.json']);
  assert.equal(pass.passTypeIdentifier, 'pass.test.allergy');
  assert.equal(pass.sharingProhibited, true);
  assert.equal(pass.voided, false);
  assert.ok(pass.barcodes[0].message.includes(`/v/${h.cardId}?s=`));
  const passText = JSON.stringify(pass);
  assert.ok(passText.includes('Amoxicillin'));
  for (const secret of ['1103702071811', '1811', '6512345', 'APL-1', '1985']) assert.ok(!passText.includes(secret), `pass leaked ${secret}`);

  // Detached PKCS#7 signature over manifest.json, verified with OpenSSL when available.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkpass-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), files['manifest.json']);
  fs.writeFileSync(path.join(dir, 'signature'), files.signature);
  fs.writeFileSync(path.join(dir, 'ca.pem'), wwdr.certPem);
  try {
    execFileSync('openssl', ['smime', '-verify', '-binary', '-inform', 'DER', '-in', path.join(dir, 'signature'), '-content', path.join(dir, 'manifest.json'), '-CAfile', path.join(dir, 'ca.pem'), '-purpose', 'any', '-out', '/dev/null'], { stdio: 'pipe' });
  } catch (err) {
    if (err.code !== 'ENOENT') assert.fail(`signature did not verify: ${err.stderr}`);
  }

  // PassKit web service: register, list updates, fetch latest.
  const auth = `ApplePass ${pass.authenticationToken}`;
  const regPath = `/wallet/apple/v1/devices/device-1/registrations/pass.test.allergy/${pass.serialNumber}`;
  assert.equal((await t.call('POST', regPath, { auth: 'ApplePass wrong', body: { pushToken: 'push-1' } })).status, 401);
  assert.equal((await t.call('POST', regPath, { auth, body: { pushToken: 'push-1' } })).status, 201);
  const since = (await t.call('GET', '/wallet/apple/v1/devices/device-1/registrations/pass.test.allergy')).body.lastUpdated;
  assert.equal((await t.call('GET', `/wallet/apple/v1/devices/device-1/registrations/pass.test.allergy?passesUpdatedSince=${since}`)).status, 204);

  // Clinical update -> re-verify -> refresh card -> pass reported as updated.
  await t.call('PUT', `/api/records/${h.recordId}`, { token, body: { severity: 'life_threatening' } });
  assert.equal((await t.call('POST', `/api/cards/${h.cardId}/refresh`, { token })).status, 409, 'cannot push unverified data');
  await t.call('POST', `/api/records/${h.recordId}/verify`, { token, body: { password: 'alice-password', attest: true } });
  await new Promise((r) => setTimeout(r, 5));
  const refreshed = await t.call('POST', `/api/cards/${h.cardId}/refresh`, { token });
  assert.equal(refreshed.body.card.version, 2);
  const updates = await t.call('GET', `/wallet/apple/v1/devices/device-1/registrations/pass.test.allergy?passesUpdatedSince=${since}`);
  assert.deepEqual(updates.body.serialNumbers, [pass.serialNumber]);
  const latest = await t.call('GET', `/wallet/apple/v1/passes/pass.test.allergy/${pass.serialNumber}`, { auth, raw: true });
  const latestPass = JSON.parse(readZip(Buffer.from(await latest.arrayBuffer()))['pass.json']);
  assert.ok(JSON.stringify(latestPass).includes('Life-threatening'));

  // Revocation voids the pass and strips clinical content.
  await t.call('POST', `/api/cards/${h.cardId}/revoke`, { token, body: { password: 'alice-password' } });
  const revokedRes = await t.call('GET', `/wallet/apple/v1/passes/pass.test.allergy/${pass.serialNumber}`, { auth, raw: true });
  const revokedPass = JSON.parse(readZip(Buffer.from(await revokedRes.arrayBuffer()))['pass.json']);
  assert.equal(revokedPass.voided, true);
  assert.ok(!JSON.stringify(revokedPass).includes('Amoxicillin'));
});

test('Google Wallet: object created server-side, skinny JWT, revocation', async () => {
  const h = await holderFor('GGL-1');
  assert.equal((await t.call('POST', '/api/holder/wallet/google', { auth: h.holder, body: { confirm: false } })).status, 422);
  const prep = await t.call('POST', '/api/holder/wallet/google', { auth: h.holder, body: { confirm: true, discreet: true } });
  assert.equal(prep.status, 200);
  const jwt = prep.body.saveUrl.split('/save/')[1];
  const [, payloadB64, sig] = jwt.split('.');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url'));
  assert.equal(payload.typ, 'savetowallet');
  assert.deepEqual(Object.keys(payload.payload.genericObjects[0]), ['id'], 'JWT references the object by ID only');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(jwt.split('.').slice(0, 2).join('.')), googleKey.publicKey, Buffer.from(sig, 'base64url')));
  const created = googleCalls.find((c) => c.method === 'POST' && c.url.endsWith('/genericObject'));
  const obj = JSON.parse(created.body);
  assert.equal(obj.state, 'ACTIVE');
  assert.ok(!created.body.includes('Somying'), 'discreet mode hides the name on the front');
  for (const secret of ['1103702071811', '6512345', '1985']) assert.ok(!created.body.includes(secret));

  await t.call('POST', `/api/cards/${h.cardId}/revoke`, { token, body: { password: 'alice-password' } });
  const put = googleCalls.filter((c) => c.method === 'PUT').at(-1);
  assert.equal(JSON.parse(put.body).state, 'INACTIVE');
});

test('Google Wallet stays disabled until health-pass approval is attested', async () => {
  t.config.google.healthPassApproved = false;
  const h = await holderFor('GGL-2');
  assert.equal((await t.call('POST', '/api/holder/wallet/google', { auth: h.holder, body: { confirm: true } })).status, 503);
  t.config.google.healthPassApproved = true;
});
