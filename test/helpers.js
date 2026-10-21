import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

export async function startServer({ env = {}, overrides = {}, fetchImpl } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', ...env }, { dbPath: ':memory:', ...overrides });
  const ctx = createApp(config, { fetchImpl });
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicBaseUrl = base;
  ctx.auth.createPharmacist({ username: 'alice', password: 'alice-password', displayName: 'ภก. อลิซ', licenseNo: 'ภ.11111', role: 'admin' });
  ctx.auth.createPharmacist({ username: 'bob', password: 'bob-password1', displayName: 'ภก. บ็อบ', licenseNo: 'ภ.22222' });

  async function call(method, path, { body, token, auth, raw } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    if (auth) headers.authorization = auth;
    const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  async function login(username = 'alice', password = 'alice-password') {
    const r = await call('POST', '/api/auth/login', { body: { username, password } });
    return r.body.token;
  }

  return { ctx, config, base, call, login, close: () => new Promise((r) => server.close(r)) };
}

export const PATIENT = {
  hn: '6512345', nationalId: '1-1037-02071-81-1', firstNameTh: 'สมหญิง', lastNameTh: 'ใจดี',
  firstNameEn: 'Somying', lastNameEn: 'Jaidee', dob: '1985-04-12', sex: 'F',
};

export const RECORD = {
  drugGeneric: 'Amoxicillin', drugBrand: 'Amoxil', drugClass: 'Penicillins', reactionType: 'allergy',
  manifestations: ['urticaria', 'angioedema'], reactionNote: 'ลมพิษทั่วตัว', severity: 'severe',
  clinicalStatus: 'active', assessmentDate: '2026-10-20',
  naranjoAnswers: { q1: 'yes', q2: 'yes', q3: 'yes', q4: 'yes', q5: 'no', q6: 'unknown', q7: 'unknown', q8: 'yes', q9: 'yes', q10: 'yes' },
};

/** Creates a patient with one verified record and returns ids. */
export async function verifiedPatient(t, token) {
  const p = await t.call('POST', '/api/patients', { token, body: PATIENT });
  const r = await t.call('POST', `/api/patients/${p.body.patient.id}/records`, { token, body: RECORD });
  await t.call('POST', `/api/records/${r.body.record.id}/verify`, { token, body: { password: 'alice-password', attest: true } });
  return { patientId: p.body.patient.id, recordId: r.body.record.id };
}
