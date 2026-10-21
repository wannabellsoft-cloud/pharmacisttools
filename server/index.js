import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const ctx = createApp(config);

if (config.demoSeed) {
  const exists = ctx.db.prepare('SELECT COUNT(*) AS n FROM pharmacists').get().n > 0;
  if (!exists) {
    ctx.auth.createPharmacist({ username: 'demo', password: 'demo-pharmacist', displayName: 'ภก. ทดสอบ ระบบ', licenseNo: 'ภ.00000', role: 'admin' });
    ctx.auth.createPharmacist({ username: 'reviewer', password: 'demo-reviewer', displayName: 'ภญ. ตรวจสอบ ยา', licenseNo: 'ภ.00001' });
    console.log('[seed] Demo pharmacists created: demo / demo-pharmacist (admin), reviewer / demo-reviewer');
  }
}

ctx.retention.start();
ctx.app.listen(config.port, () => {
  console.log(`PharmaTools listening on ${config.publicBaseUrl} (port ${config.port})`);
});
