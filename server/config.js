import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const bool = (v) => v === '1' || v === 'true';

function readOptional(file) {
  if (!file) return null;
  return fs.readFileSync(path.resolve(file), 'utf8');
}

/**
 * Loads runtime configuration. In production a MASTER_KEY must be supplied;
 * in development a key is generated once and persisted under DATA_DIR so that
 * encrypted data survives restarts.
 */
export function loadConfig(env = process.env, overrides = {}) {
  const production = env.NODE_ENV === 'production';
  const dataDir = path.resolve(env.DATA_DIR || 'data');
  const dbPath = overrides.dbPath ?? env.DB_PATH ?? path.join(dataDir, 'pharmatools.db');

  let masterKey = overrides.masterKey ?? env.MASTER_KEY;
  if (!masterKey) {
    if (production) throw new Error('MASTER_KEY is required in production (32+ random bytes, base64).');
    if (dbPath === ':memory:') {
      masterKey = crypto.randomBytes(32).toString('base64');
    } else {
      fs.mkdirSync(dataDir, { recursive: true });
      const keyFile = path.join(dataDir, 'dev-master.key');
      if (!fs.existsSync(keyFile)) {
        fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
        console.warn(`[config] Generated development MASTER_KEY at ${keyFile}. Never use this in production.`);
      }
      masterKey = fs.readFileSync(keyFile, 'utf8').trim();
    }
  }
  if (Buffer.from(masterKey, 'base64').length < 32) throw new Error('MASTER_KEY must decode to at least 32 bytes.');

  const port = int(env.PORT, 3000);
  const config = {
    production,
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    trustProxy: bool(env.TRUST_PROXY),
    dataDir,
    dbPath,
    masterKey,
    demoSeed: !production && bool(env.DEMO_SEED),

    sessionTtlHours: int(env.SESSION_TTL_HOURS, 8),
    claimTtlMinutes: int(env.CLAIM_TTL_MINUTES, 10),
    claimMaxAttempts: int(env.CLAIM_MAX_ATTEMPTS, 5),
    claimSessionTtlMinutes: int(env.CLAIM_SESSION_TTL_MINUTES, 15),
    walletDownloadTtlSeconds: int(env.WALLET_DOWNLOAD_TTL_SECONDS, 120),

    // PDPA retention controls (days). Align with your facility's records policy.
    recordRetentionDays: int(env.RECORD_RETENTION_DAYS, 1825),
    claimPurgeDays: int(env.CLAIM_PURGE_DAYS, 7),
    auditRetentionDays: int(env.AUDIT_RETENTION_DAYS, 3650),
    holderInactiveDays: int(env.HOLDER_INACTIVE_DAYS, 730),
    consentVersion: env.CONSENT_VERSION || '2026-10',
    // Four-eyes principle: the verifier must differ from the last editor.
    requireIndependentReviewer: bool(env.REQUIRE_INDEPENDENT_REVIEWER),

    facility: {
      nameTh: env.FACILITY_NAME_TH || 'โรงพยาบาลตัวอย่าง',
      nameEn: env.FACILITY_NAME_EN || 'Example Hospital',
      phone: env.FACILITY_PHONE || '02-000-0000',
    },

    apple: {
      passTypeId: env.APPLE_PASS_TYPE_ID || '',
      teamId: env.APPLE_TEAM_ID || '',
      certPem: overrides.appleCertPem ?? readOptional(env.APPLE_PASS_CERT_PEM),
      keyPem: overrides.appleKeyPem ?? readOptional(env.APPLE_PASS_KEY_PEM),
      keyPassphrase: env.APPLE_PASS_KEY_PASSPHRASE || undefined,
      wwdrPem: overrides.appleWwdrPem ?? readOptional(env.APPLE_WWDR_CERT_PEM),
      apnsEnabled: bool(env.APPLE_APNS_ENABLED),
      apnsHost: env.APPLE_APNS_HOST || 'https://api.push.apple.com',
    },

    google: {
      issuerId: env.GOOGLE_WALLET_ISSUER_ID || '',
      classSuffix: env.GOOGLE_WALLET_CLASS_SUFFIX || 'drug_allergy_card',
      serviceAccount: (() => {
        const raw = overrides.googleServiceAccount ?? readOptional(env.GOOGLE_SERVICE_ACCOUNT_JSON);
        return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      })(),
      // The operator must attest that the issuer account has been approved by
      // Google for a private/health pass. Without it the integration stays off.
      healthPassApproved: bool(env.GOOGLE_WALLET_HEALTH_PASS_APPROVED),
      passType: env.GOOGLE_WALLET_PASS_TYPE || 'generic',
      origins: (env.GOOGLE_WALLET_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
      logoUrl: env.GOOGLE_WALLET_LOGO_URL || '',
      apiBase: env.GOOGLE_WALLET_API_BASE || 'https://walletobjects.googleapis.com/walletobjects/v1',
    },
    ...overrides.extra,
  };
  return config;
}

export function appleConfigured(c) {
  const a = c.apple;
  return Boolean(a.passTypeId && a.teamId && a.certPem && a.keyPem && a.wwdrPem);
}

export function googleConfigured(c) {
  const g = c.google;
  return Boolean(g.issuerId && g.serviceAccount && g.healthPassApproved);
}
