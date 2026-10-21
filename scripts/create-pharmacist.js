// Usage: npm run create-pharmacist -- <username> "<display name>" <license no> [admin]
// The password is read from the PHARMACIST_PASSWORD environment variable or prompted.
import readline from 'node:readline/promises';
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { createAudit } from '../server/audit.js';
import { createAuth } from '../server/auth.js';
import { deriveKeys } from '../server/crypto.js';

const [username, displayName, licenseNo, role] = process.argv.slice(2);
if (!username || !displayName || !licenseNo) {
  console.error('Usage: npm run create-pharmacist -- <username> "<display name>" <license no> [admin]');
  process.exit(1);
}
let password = process.env.PHARMACIST_PASSWORD;
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Password (min 10 chars): ');
  rl.close();
}
const config = loadConfig();
const db = openDatabase(config.dbPath);
const audit = createAudit(db, deriveKeys(config.masterKey));
const auth = createAuth(db, config, audit);
const id = auth.createPharmacist({ username, password, displayName, licenseNo, role: role === 'admin' ? 'admin' : 'pharmacist' });
audit.log({ actorType: 'system', action: 'pharmacist.create', entityType: 'pharmacist', entityId: id });
console.log(`Created pharmacist ${username} (${id}).`);
