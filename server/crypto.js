import crypto from 'node:crypto';

/** Derives purpose-specific keys from the master key (HKDF-SHA256). */
export function deriveKeys(masterKeyB64) {
  const ikm = Buffer.from(masterKeyB64, 'base64');
  const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
  return {
    enc: derive('pharmatools/enc/v1'),
    index: derive('pharmatools/index/v1'),
    sign: derive('pharmatools/sign/v1'),
    pseudo: derive('pharmatools/pseudonym/v1'),
  };
}

/** AES-256-GCM encryption of a JSON value. `aad` binds the ciphertext to its row. */
export function encryptJSON(value, key, aad = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptJSON(blob, key, aad = '') {
  if (!blob) return null;
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1') throw new Error('Unsupported ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8'));
}

/** Deterministic keyed index so identifiers can be looked up without storing them in clear. */
export function blindIndex(value, key) {
  const normalized = String(value).trim().toUpperCase().replace(/[\s-]/g, '');
  return crypto.createHmac('sha256', key).update(normalized).digest('hex');
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const uuid = () => crypto.randomUUID();

export function hmac(value, key, length = 16) {
  return crypto.createHmac('sha256', key).update(value).digest().subarray(0, length).toString('base64url');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const candidate = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'base64url'));
}
