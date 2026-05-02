/**
 * LICENSE SERVER — Railway-safe version
 *
 * DEPLOY STEPS:
 * 1. Push this file + railway.json to Railway
 * 2. Set env vars in Railway dashboard:
 *      ADMIN_SECRET=your_secret_here
 *      LICENSES_SEED={}          ← keep as empty JSON, explained below
 * 3. (Optional but recommended) Add a Railway Volume mounted at /data
 *    Then set: RAILWAY_VOLUME_MOUNT_PATH=/data
 *
 * WITHOUT a volume: licenses survive restarts but reset on redeploy.
 * WITH a volume: licenses persist forever across deploys.
 *
 * GENERATE A LICENSE (HTTP — works on Railway):
 *   curl -X POST https://your-app.railway.app/api/admin/gen \
 *     -H "Content-Type: application/json" \
 *     -H "x-admin-secret: YOUR_SECRET" \
 *     -d '{"owner":"CustomerName"}'
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'PavThean@260705@admin';

// DATA_DIR priority:
//   1. Railway Volume (persistent across deploys) ← BEST
//   2. /tmp (writable on Railway, resets on redeploy) ← OK for testing
//   3. __dirname fallback (local dev only)
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (process.env.RAILWAY_ENVIRONMENT ? '/tmp' : __dirname);

const LICENSES_FILE = path.join(DATA_DIR, 'licenses.json');

console.log(`📁 Data dir: ${DATA_DIR}`);
console.log(`📄 Licenses file: ${LICENSES_FILE}`);

// ─── SEED LICENSES FROM ENV ───────────────────────────────
// If you have licenses pre-created (e.g. from a backup), set
// LICENSES_SEED env var to the full JSON object string.
// On first boot, they'll be written to disk if file doesn't exist.
function seedFromEnv() {
  if (fs.existsSync(LICENSES_FILE)) return; // don't overwrite existing
  const seed = process.env.LICENSES_SEED;
  if (!seed) return;
  try {
    const parsed = JSON.parse(seed);
    fs.writeFileSync(LICENSES_FILE, JSON.stringify(parsed, null, 2));
    console.log('✅ Seeded licenses from LICENSES_SEED env var');
  } catch (e) {
    console.error('⚠️  LICENSES_SEED is invalid JSON, skipped:', e.message);
  }
}

// ─── LOAD / SAVE ──────────────────────────────────────────
function loadLicenses() {
  if (!fs.existsSync(LICENSES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf8')); }
  catch (e) {
    console.error('Failed to parse licenses.json:', e.message);
    return {};
  }
}

function saveLicenses(data) {
  try {
    fs.writeFileSync(LICENSES_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('❌ Failed to save licenses.json:', e.message);
    console.error('   Make sure DATA_DIR is writable. On Railway, add a Volume or use /tmp.');
    throw e;
  }
}

// ─── BOOT ─────────────────────────────────────────────────
seedFromEnv();

// ─── GENERATE VIA CLI (local dev only) ────────────────────
if (process.argv[2] === '--gen') {
  const name = process.argv[3] || 'unknown';
  const key  = 'PT-' + crypto.randomBytes(12).toString('hex').toUpperCase();
  const licenses = loadLicenses();
  licenses[key] = {
    owner:     name,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    machineId: null,
    active:    true
  };
  saveLicenses(licenses);
  console.log(`\n✅ License created for "${name}":\n   ${key}\n`);
  process.exit(0);
}

// ─── MIDDLEWARE: log all requests ─────────────────────────
app.use((req, _res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} — ${ip}`);
  next();
});

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'PavThean License Server' });
});

// ─── VALIDATE ENDPOINT ────────────────────────────────────
app.post('/api/validate', (req, res) => {
  const { licenseKey, machineId } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!licenseKey || !machineId) {
    return res.json({ valid: false, reason: 'Missing fields' });
  }

  let licenses;
  try {
    licenses = loadLicenses();
  } catch (e) {
    return res.status(500).json({ valid: false, reason: 'Server storage error' });
  }

  const lic = licenses[licenseKey];

  if (!lic)        return res.json({ valid: false, reason: 'Invalid license key' });
  if (!lic.active) return res.json({ valid: false, reason: 'License revoked' });

  if (lic.expiresAt && new Date() > new Date(lic.expiresAt)) {
    return res.json({ valid: false, reason: 'License expired' });
  }

  // Lock to machine on first use
  if (!lic.machineId) {
    lic.machineId = machineId;
    lic.lockedAt  = new Date().toISOString();
    lic.lockedIp  = ip;
    console.log(`🔒 License ${licenseKey} locked to machine ${machineId}`);
  } else if (lic.machineId !== machineId) {
    console.log(`⛔ Machine mismatch for ${licenseKey}: got ${machineId}, expected ${lic.machineId}`);
    return res.json({ valid: false, reason: 'License bound to another machine' });
  }

  lic.lastSeen = new Date().toISOString();
  lic.lastIp   = ip;
  licenses[licenseKey] = lic;

  try {
    saveLicenses(licenses);
  } catch (e) {
    // Don't block valid clients if save fails — just warn
    console.error('⚠️  Could not persist lastSeen update:', e.message);
  }

  return res.json({ valid: true, owner: lic.owner });
});

// ─── ADMIN: list all licenses ─────────────────────────────
app.get('/api/admin/licenses', (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });
  res.json(loadLicenses());
});

// ─── ADMIN: generate license ──────────────────────────────
app.post('/api/admin/gen', (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });

  const { owner, expiresAt } = req.body;
  if (!owner) return res.status(400).json({ error: 'owner required' });

  if (expiresAt && isNaN(Date.parse(expiresAt)))
    return res.status(400).json({ error: 'Invalid expiresAt. Use ISO 8601 e.g. 2026-12-31T00:00:00.000Z' });

  const key = 'PT-' + crypto.randomBytes(12).toString('hex').toUpperCase();
  const licenses = loadLicenses();
  licenses[key] = {
    owner,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
    machineId: null,
    active:    true
  };
  saveLicenses(licenses);
  console.log(`✅ Key created for ${owner}: ${key}`);
  res.json({ ok: true, key, owner, expiresAt: expiresAt || null });
});

// ─── ADMIN: revoke license ────────────────────────────────
app.post('/api/admin/revoke', (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });

  const { key } = req.body;
  const licenses = loadLicenses();
  if (!licenses[key]) return res.status(404).json({ error: 'Not found' });
  licenses[key].active = false;
  saveLicenses(licenses);
  res.json({ ok: true });
});

// ─── ADMIN: reset machine lock ────────────────────────────
app.post('/api/admin/reset-machine', (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });

  const { key } = req.body;
  const licenses = loadLicenses();
  if (!licenses[key]) return res.status(404).json({ error: 'Not found' });
  licenses[key].machineId = null;
  saveLicenses(licenses);
  res.json({ ok: true, message: 'Machine lock reset' });
});

// ─── ADMIN: set expiry ────────────────────────────────────
app.post('/api/admin/set-expiry', (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });

  const { key, expiresAt } = req.body;
  if (typeof expiresAt === 'undefined')
    return res.status(400).json({ error: 'expiresAt required (ISO string or null)' });
  if (expiresAt !== null && isNaN(Date.parse(expiresAt)))
    return res.status(400).json({ error: 'Invalid date. Use ISO 8601 e.g. 2026-06-01T00:00:00.000Z' });

  const licenses = loadLicenses();
  if (!licenses[key]) return res.status(404).json({ error: 'License not found' });
  licenses[key].expiresAt = expiresAt;
  saveLicenses(licenses);
  console.log(`📅 Expiry set for ${key}: ${expiresAt || 'lifetime'}`);
  res.json({ ok: true, key, expiresAt: licenses[key].expiresAt });
});

// ─── ADMIN: activate license ──────────────────────────────
app.post('/api/admin/activate', (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });

  const { key } = req.body;
  const licenses = loadLicenses();
  if (!licenses[key]) return res.status(404).json({ error: 'Not found' });
  licenses[key].active = true;
  saveLicenses(licenses);
  res.json({ ok: true });
});

// ─── START ────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🔑 License server running on port ${PORT}`);
  console.log(`\nGenerate key (local): node server.js --gen "CustomerName"`);
  console.log(`Generate key (HTTP):  POST /api/admin/gen with x-admin-secret header\n`);
});