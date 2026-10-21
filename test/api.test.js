import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, PATIENT, RECORD, verifiedPatient } from './helpers.js';

let t;
let token;
before(async () => {
  t = await startServer();
  token = await t.login();
});
after(() => t.close());

test('rejects unauthenticated access and bad credentials', async () => {
  assert.equal((await t.call('GET', '/api/patients')).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'alice', password: 'nope' } })).status, 401);
});

test('patient identifiers are encrypted at rest', async () => {
  const p = await t.call('POST', '/api/patients', { token, body: { ...PATIENT, hn: 'ENC-1' } });
  assert.equal(p.status, 201);
  const row = t.ctx.db.prepare('SELECT * FROM patients WHERE id = ?').get(p.body.patient.id);
  assert.ok(!row.data_enc.includes('สมหญิง'));
  assert.ok(!row.data_enc.includes('1103702071811'));
  assert.ok(!JSON.stringify(row).includes('ENC-1'));
  const found = await t.call('GET', '/api/patients?hn=ENC-1', { token });
  assert.equal(found.body.patients.length, 1);
  assert.equal(found.body.patients[0].nationalId, undefined);
});

test('Naranjo never auto-confirms; confirmation needs evidence', async () => {
  const p = await t.call('POST', '/api/patients', { token, body: { ...PATIENT, hn: 'NAR-1' } });
  const definite = { ...RECORD, naranjoAnswers: { q1: 'yes', q2: 'yes', q3: 'yes', q4: 'yes', q5: 'no', q6: 'no', q7: 'yes', q8: 'yes', q9: 'yes', q10: 'yes' } };
  const r = await t.call('POST', `/api/patients/${p.body.patient.id}/records`, { token, body: definite });
  assert.equal(r.status, 201);
  assert.equal(r.body.record.naranjo.category, 'definite');
  assert.equal(r.body.record.certainty, 'suspected');
  assert.equal(r.body.record.reviewStatus, 'pending_review');

  const bad = await t.call('PUT', `/api/records/${r.body.record.id}`, { token, body: { certainty: 'confirmed' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.errors.some((e) => e.code === 'CONFIRMATION_BASIS_REQUIRED'));

  const ok = await t.call('PUT', `/api/records/${r.body.record.id}`, { token, body: { certainty: 'confirmed', confirmationBasis: ['skin_test'], confirmationNote: 'Positive skin prick test' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.record.certainty, 'confirmed');
});

test('cards require pharmacist verification; edits reset verification', async () => {
  const p = await t.call('POST', '/api/patients', { token, body: { ...PATIENT, hn: 'VER-1' } });
  const pid = p.body.patient.id;
  const r = await t.call('POST', `/api/patients/${pid}/records`, { token, body: RECORD });
  const rid = r.body.record.id;

  let issue = await t.call('POST', `/api/patients/${pid}/cards/physical`, { token, body: { language: 'bi', format: 'id1', consent: true } });
  assert.equal(issue.status, 409);
  assert.ok(issue.body.error.reasons.includes('PENDING_REVIEW'));
  assert.equal((await t.call('POST', `/api/patients/${pid}/claims`, { token })).status, 409);

  assert.equal((await t.call('POST', `/api/records/${rid}/verify`, { token, body: { password: 'wrong', attest: true } })).status, 403);
  assert.equal((await t.call('POST', `/api/records/${rid}/verify`, { token, body: { password: 'alice-password' } })).status, 422);
  const v = await t.call('POST', `/api/records/${rid}/verify`, { token, body: { password: 'alice-password', attest: true } });
  assert.equal(v.body.record.reviewStatus, 'verified');

  assert.equal((await t.call('POST', `/api/patients/${pid}/cards/physical`, { token, body: { language: 'bi', format: 'id1' } })).status, 422, 'consent required');
  issue = await t.call('POST', `/api/patients/${pid}/cards/physical`, { token, body: { language: 'bi', format: 'id1', consent: true } });
  assert.equal(issue.status, 201);
  const cardId = issue.body.card.id;
  assert.equal(issue.body.card.snapshot.entries[0].certainty, 'suspected');
  assert.ok(issue.body.card.snapshot.verifyUrl.includes(`/v/${cardId}?s=`));

  await t.call('PUT', `/api/records/${rid}`, { token, body: { severity: 'life_threatening' } });
  const bundle = await t.call('GET', `/api/patients/${pid}`, { token });
  assert.equal(bundle.body.records[0].reviewStatus, 'pending_review');
  assert.equal(bundle.body.cards[0].outdated, true);

  const pdf = await t.call('GET', `/api/cards/${cardId}/pdf?format=a4`, { token, raw: true });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal((await pdf.arrayBuffer()).byteLength > 1000, true);
});

test('public QR page exposes status only, never clinical data', async () => {
  const { patientId } = await verifiedPatient(t, token).catch(() => ({}));
  const pid = patientId ?? (await t.call('GET', '/api/patients?hn=6512345', { token })).body.patients[0].id;
  const issue = await t.call('POST', `/api/patients/${pid}/cards/physical`, { token, body: { language: 'th', format: 'a4', consent: true } });
  const url = new URL(issue.body.card.snapshot.verifyUrl);
  const page = await t.call('GET', url.pathname + url.search);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('This card is authentic and active'));
  for (const secret of ['Amoxicillin', 'สมหญิง', 'Somying', '6512345', '1811', '1985']) assert.ok(!page.text.includes(secret), `leaked ${secret}`);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await t.call('GET', url.pathname + '?s=forged')).status, 404);

  // Re-issuing supersedes the old printed card.
  await t.call('POST', `/api/patients/${pid}/cards/physical`, { token, body: { language: 'th', format: 'a4', consent: true } });
  assert.ok((await t.call('GET', url.pathname + url.search)).text.includes('newer card'));
});

test('digital claim: identity verification, lockout, consent, holder access, revocation', async () => {
  const p = await t.call('POST', '/api/patients', { token, body: { ...PATIENT, hn: 'DIG-1' } });
  const pid = p.body.patient.id;
  const r = await t.call('POST', `/api/patients/${pid}/records`, { token, body: RECORD });
  await t.call('POST', `/api/records/${r.body.record.id}/verify`, { token, body: { password: 'alice-password', attest: true } });

  const claim = await t.call('POST', `/api/patients/${pid}/claims`, { token });
  assert.equal(claim.status, 201);
  assert.ok(claim.body.claim.qrSvg.startsWith('<svg'));
  const claimToken = new URL(claim.body.claim.url).hash.replace('#t=', '');
  assert.ok(!claim.body.claim.url.includes('?'), 'token must be in the fragment');

  const start = await t.call('POST', '/api/claim/start', { body: { token: claimToken } });
  assert.equal(start.status, 200);
  assert.ok(!JSON.stringify(start.body).includes('Somying'));

  const wrong = await t.call('POST', '/api/claim/verify', { body: { token: claimToken, dob: '1985-04-12', idLast4: '0000' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.attemptsRemaining, 4);

  const ok = await t.call('POST', '/api/claim/verify', { body: { token: claimToken, dob: '1985-04-12', idLast4: '1811' } });
  assert.equal(ok.status, 200);
  const session = ok.body.session;
  // Token is single-use once verified.
  assert.equal((await t.call('POST', '/api/claim/verify', { body: { token: claimToken, dob: '1985-04-12', idLast4: '1811' } })).status, 404);

  const view = await t.call('GET', '/api/claim/session', { auth: `Claim ${session}` });
  assert.equal(view.body.snapshot.entries[0].drugGeneric, 'Amoxicillin');

  assert.equal((await t.call('POST', '/api/claim/complete', { auth: `Claim ${session}`, body: { consents: { digital_card: true } } })).status, 422);
  const done = await t.call('POST', '/api/claim/complete', { auth: `Claim ${session}`, body: { consents: { health_data_processing: true, digital_card: true }, language: 'th' } });
  assert.equal(done.status, 200);
  const holder = `Holder ${done.body.holderToken}`;
  assert.equal((await t.call('GET', '/api/claim/session', { auth: `Claim ${session}` })).status, 401, 'session ends after completion');

  const card = await t.call('GET', '/api/holder/card', { auth: holder });
  assert.equal(card.body.status, 'active');
  assert.equal(card.body.snapshot.kind, 'digital');
  const status = await t.call('GET', `/api/claims/${claim.body.claim.id}`, { token });
  assert.equal(status.body.claim.status, 'completed');

  // Wallet requires explicit confirmation and configured issuers.
  assert.equal((await t.call('POST', '/api/holder/wallet/apple', { auth: holder, body: { confirm: true } })).status, 503);

  const revoke = await t.call('POST', `/api/cards/${done.body.cardId}/revoke`, { token, body: { password: 'alice-password', reason: 'test' } });
  assert.equal(revoke.body.card.status, 'revoked');
  const after = await t.call('GET', '/api/holder/card', { auth: holder });
  assert.equal(after.body.status, 'revoked');
  assert.equal(after.body.snapshot, undefined);
});

test('claim locks after max attempts and expires', async () => {
  const p = await t.call('POST', '/api/patients', { token, body: { ...PATIENT, hn: 'LOCK-1' } });
  const pid = p.body.patient.id;
  const r = await t.call('POST', `/api/patients/${pid}/records`, { token, body: RECORD });
  await t.call('POST', `/api/records/${r.body.record.id}/verify`, { token, body: { password: 'alice-password', attest: true } });
  const claim = await t.call('POST', `/api/patients/${pid}/claims`, { token });
  const tok = new URL(claim.body.claim.url).hash.replace('#t=', '');
  let last;
  for (let i = 0; i < 5; i++) last = await t.call('POST', '/api/claim/verify', { body: { token: tok, dob: '2000-01-01', idLast4: '1811' } });
  assert.equal(last.status, 423);
  assert.equal((await t.call('POST', '/api/claim/start', { body: { token: tok } })).status, 404);

  const claim2 = await t.call('POST', `/api/patients/${pid}/claims`, { token });
  const tok2 = new URL(claim2.body.claim.url).hash.replace('#t=', '');
  t.ctx.db.prepare("UPDATE claims SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(claim2.body.claim.id);
  assert.equal((await t.call('POST', '/api/claim/start', { body: { token: tok2 } })).status, 404);
});

test('consent withdrawal revokes and deletes digital card content', async () => {
  const p = await t.call('POST', '/api/patients', { token, body: { ...PATIENT, hn: 'WD-1' } });
  const pid = p.body.patient.id;
  const r = await t.call('POST', `/api/patients/${pid}/records`, { token, body: RECORD });
  await t.call('POST', `/api/records/${r.body.record.id}/verify`, { token, body: { password: 'alice-password', attest: true } });
  const claim = await t.call('POST', `/api/patients/${pid}/claims`, { token });
  const tok = new URL(claim.body.claim.url).hash.replace('#t=', '');
  const s = (await t.call('POST', '/api/claim/verify', { body: { token: tok, dob: '1985-04-12', idLast4: '1811' } })).body.session;
  const done = await t.call('POST', '/api/claim/complete', { auth: `Claim ${s}`, body: { consents: { health_data_processing: true, digital_card: true } } });
  const holder = `Holder ${done.body.holderToken}`;
  assert.equal((await t.call('POST', '/api/holder/withdraw', { auth: holder, body: { confirm: true } })).status, 200);
  const row = t.ctx.db.prepare('SELECT status, snapshot_enc FROM cards WHERE id = ?').get(done.body.cardId);
  assert.equal(row.status, 'revoked');
  assert.equal(row.snapshot_enc, null);
  const consents = await t.call('GET', `/api/patients/${pid}/consents`, { token });
  assert.ok(consents.body.consents.filter((c) => c.card_id === done.body.cardId).every((c) => c.withdrawn_at));
});

test('independent reviewer setting and erasure', async () => {
  t.config.requireIndependentReviewer = true;
  const p = await t.call('POST', '/api/patients', { token, body: { ...PATIENT, hn: 'FOUR-1' } });
  const pid = p.body.patient.id;
  const r = await t.call('POST', `/api/patients/${pid}/records`, { token, body: RECORD });
  assert.equal((await t.call('POST', `/api/records/${r.body.record.id}/verify`, { token, body: { password: 'alice-password', attest: true } })).status, 403);
  const bob = await t.login('bob', 'bob-password1');
  assert.equal((await t.call('POST', `/api/records/${r.body.record.id}/verify`, { token: bob, body: { password: 'bob-password1', attest: true } })).status, 200);
  t.config.requireIndependentReviewer = false;

  assert.equal((await t.call('POST', `/api/patients/${pid}/erase`, { token, body: { password: 'alice-password' } })).status, 200);
  const row = t.ctx.db.prepare('SELECT data_enc, erased_at FROM patients WHERE id = ?').get(pid);
  assert.equal(row.data_enc, null);
  assert.ok(row.erased_at);
  assert.equal((await t.call('POST', `/api/patients/${pid}/records`, { token, body: RECORD })).status, 410);
});

test('audit log is hash-chained and PII-free', async () => {
  const res = await t.call('GET', '/api/admin/audit', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.chain.ok, true);
  const dump = JSON.stringify(t.ctx.db.prepare('SELECT * FROM audit_logs').all());
  for (const secret of ['สมหญิง', 'Somying', '1103702071811', 'Amoxicillin', '1985-04-12']) assert.ok(!dump.includes(secret), `audit leaked ${secret}`);
  t.ctx.db.prepare("UPDATE audit_logs SET action = 'tampered' WHERE seq = 3").run();
  assert.equal(t.ctx.audit.verifyChain().ok, false);
  const bob = await t.login('bob', 'bob-password1');
  assert.equal((await t.call('GET', '/api/admin/audit', { token: bob })).status, 403);
});

test('retention job purges expired claims and erases patients past retention', async () => {
  const { patientId } = await verifiedPatient(t, token).catch(async () => {
    const p = await t.call('POST', '/api/patients', { token, body: { ...PATIENT, hn: 'RET-1' } });
    return { patientId: p.body.patient.id };
  });
  t.ctx.db.prepare("UPDATE patients SET retain_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(patientId);
  const result = await t.ctx.retention.run();
  assert.ok(result.patientsErased >= 1);
  assert.equal(t.ctx.db.prepare('SELECT data_enc FROM patients WHERE id = ?').get(patientId).data_enc, null);
});
