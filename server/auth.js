import { hashPassword, randomToken, sha256, uuid, verifyPassword } from './crypto.js';
import { addMinutes, nowIso } from './db.js';
import { HttpError } from './http.js';

// Fixed dummy hash so unknown usernames take as long as wrong passwords.
const DUMMY_HASH = hashPassword('not-a-real-password');

export function createAuth(db, config, audit) {
  const byUsername = db.prepare('SELECT * FROM pharmacists WHERE username = ? AND active = 1');
  const byId = db.prepare('SELECT * FROM pharmacists WHERE id = ? AND active = 1');
  const insertSession = db.prepare('INSERT INTO sessions (token_hash, pharmacist_id, created_at, expires_at) VALUES (?,?,?,?)');
  const getSession = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?');
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');

  const publicView = (p) => ({ id: p.id, username: p.username, displayName: p.display_name, licenseNo: p.license_no, role: p.role });

  function createPharmacist({ username, password, displayName, licenseNo, role = 'pharmacist' }) {
    if (!username || !password || password.length < 10) throw new Error('Username and a password of at least 10 characters are required.');
    if (!displayName || !licenseNo) throw new Error('Display name and professional license number are required.');
    const id = uuid();
    db.prepare('INSERT INTO pharmacists (id, username, display_name, license_no, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, username.trim().toLowerCase(), displayName.trim(), licenseNo.trim(), role, hashPassword(password), nowIso());
    return id;
  }

  function login(username, password, ip) {
    const p = byUsername.get(String(username || '').trim().toLowerCase());
    const ok = verifyPassword(password || '', p ? p.password_hash : DUMMY_HASH) && Boolean(p);
    if (!ok) {
      audit.log({ actorType: 'pharmacist', actorId: p?.id ?? null, action: 'auth.login_failed', ip });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
    }
    const token = randomToken();
    insertSession.run(sha256(token), p.id, nowIso(), addMinutes(config.sessionTtlHours * 60));
    audit.log({ actorType: 'pharmacist', actorId: p.id, action: 'auth.login', ip });
    return { token, pharmacist: publicView(p) };
  }

  function logout(token) {
    if (token) deleteSession.run(sha256(token));
  }

  /** Express middleware: requires a valid pharmacist bearer token. */
  function requirePharmacist(req, _res, next) {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    const session = m && getSession.get(sha256(m[1]), nowIso());
    const p = session && byId.get(session.pharmacist_id);
    if (!p) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in required.'));
    req.pharmacist = publicView(p);
    req.sessionToken = m[1];
    next();
  }

  function requireAdmin(req, _res, next) {
    if (req.pharmacist?.role !== 'admin') return next(new HttpError(403, 'FORBIDDEN', 'Administrator role required.'));
    next();
  }

  /** Step-up re-authentication for sensitive actions (verification, revocation, erasure). */
  function confirmPassword(pharmacistId, password) {
    const p = byId.get(pharmacistId);
    if (!p || !verifyPassword(password || '', p.password_hash)) {
      throw new HttpError(403, 'REAUTH_FAILED', 'Password confirmation failed.');
    }
    return publicView(p);
  }

  return { createPharmacist, login, logout, requirePharmacist, requireAdmin, confirmPassword, publicView, byId: (id) => byId.get(id) };
}
