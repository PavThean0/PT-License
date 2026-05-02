/**
 * LICENSE SERVER
 * Deploy this on YOUR VPS (e.g. Contabo).
 * Clients call POST /api/validate with { licenseKey, machineId, ip }
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
app.use(express.json());

// ✅ ADD THIS LINE BACK
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;

// ✅ then this works
const LICENSES_FILE = path.join(DATA_DIR, 'licenses.json');

// ─── LOAD / SAVE ──────────────────────────────────────────
function loadLicenses() {
  if (!fs.existsSync(LICENSES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf8')); }
  catch(e) { return {}; }
}
function saveLicenses(data) {
  fs.writeFileSync(LICENSES_FILE, JSON.stringify(data, null, 2));
}

// ─── GENERATE LICENSE KEY UTIL ─────────────────────────────
// Run: node server.js --gen <customerName>
if (process.argv[2] === '--gen') {
  const name = process.argv[3] || 'unknown';
  const key  = 'PT-' + crypto.randomBytes(12).toString('hex').toUpperCase();
  const licenses = loadLicenses();
  licenses[key] = {
    owner:      name,
    createdAt:  new Date().toISOString(),
    expiresAt:  null,          // null = never expires
    machineId:  null,          // locked on first use
    active:     true
  };
  saveLicenses(licenses);
  console.log(`\n✅ License created for "${name}":\n   ${key}\n`);
  process.exit(0);
}

// ─── VALIDATE ENDPOINT ────────────────────────────────────
app.post('/api/validate', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!licenseKey || !machineId) {
    return res.json({ valid: false, reason: 'Missing fields' });
  }

  const licenses = loadLicenses();
  const lic      = licenses[licenseKey];

  if (!lic)          return res.json({ valid: false, reason: 'Invalid license key' });
  if (!lic.active)   return res.json({ valid: false, reason: 'License revoked' });

  // Check expiry
  if (lic.expiresAt && new Date() > new Date(lic.expiresAt)) {
    return res.json({ valid: false, reason: 'License expired' });
  }

  // Lock to first machine
  if (!lic.machineId) {
    lic.machineId  = machineId;
    lic.lockedAt   = new Date().toISOString();
    lic.lockedIp   = ip;
    licenses[licenseKey] = lic;
    saveLicenses(licenses);
    console.log(`🔒 Locked "${licenseKey}" → machine ${machineId} (${ip})`);
  } else if (lic.machineId !== machineId) {
    console.warn(`⚠️  Machine mismatch for "${licenseKey}": expected ${lic.machineId}, got ${machineId} (${ip})`);
    return res.json({ valid: false, reason: 'License bound to another machine' });
  }

  // Log access
  lic.lastSeen   = new Date().toISOString();
  lic.lastIp     = ip;
  licenses[licenseKey] = lic;
  saveLicenses(licenses);

  console.log(`✅ "${licenseKey}" validated for ${lic.owner} (${ip})`);
  return res.json({ valid: true, owner: lic.owner });
});



app.get('/api/admin/licenses', (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  res.json(loadLicenses());
});

app.post('/api/admin/revoke', (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { key } = req.body;
  const licenses = loadLicenses();
  if (!licenses[key]) return res.status(404).json({ error: 'Not found' });
  licenses[key].active = false;
  saveLicenses(licenses);
  res.json({ ok: true });
});

app.post('/api/admin/reset-machine', (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { key } = req.body;
  const licenses = loadLicenses();
  if (!licenses[key]) return res.status(404).json({ error: 'Not found' });
  licenses[key].machineId = null;
  saveLicenses(licenses);
  res.json({ ok: true, message: 'Machine lock reset' });
});

app.post('/api/admin/set-expiry', (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { key, expiresAt } = req.body;
  if (typeof expiresAt === 'undefined') return res.status(400).json({ error: 'expiresAt required (ISO string or null)' });
  if (expiresAt !== null && isNaN(Date.parse(expiresAt))) return res.status(400).json({ error: 'Invalid date. Use ISO 8601 e.g. 2026-06-01T00:00:00.000Z' });
  const licenses = loadLicenses();
  if (!licenses[key]) return res.status(404).json({ error: 'License not found' });
  licenses[key].expiresAt = expiresAt;
  saveLicenses(licenses);
  console.log('Expiry set for ' + key + ': ' + (expiresAt || 'lifetime'));
  res.json({ ok: true, key, expiresAt: licenses[key].expiresAt });
});

app.post('/api/admin/gen', (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { owner, expiresAt } = req.body;
  if (!owner) return res.status(400).json({ error: 'owner required' });
  const key = 'PT-' + crypto.randomBytes(12).toString('hex').toUpperCase();
  const licenses = loadLicenses();
  licenses[key] = {
    owner,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
    machineId: null,
    active: true
  };
  saveLicenses(licenses);
  console.log('Key created for ' + owner + ': ' + key);
  res.json({ ok: true, key, owner, expiresAt: expiresAt || null });
});

// ─── START ────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🔑 License server running on port ${PORT}`);
  console.log(`   Generate key: node server.js --gen "CustomerName"`);
});
