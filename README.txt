# PT License Server — Deploy Guide
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Deploy on your VPS (e.g. Contabo Singapore)

### 1. Upload this folder to your VPS
```
scp -r PT-LicenseServer/ user@your-vps-ip:/home/user/
```

### 2. Install dependencies
```
cd PT-LicenseServer
npm install
```

### 3. Set admin secret (important!)
```
export ADMIN_SECRET=your_strong_secret_here
```
Or edit the server.js line:  const ADMIN_SECRET = 'changeme123';

### 4. Run (recommended: use PM2 to keep it alive)
```
npm install -g pm2
pm2 start server.js --name pt-license
pm2 save
pm2 startup
```

### 5. Point a domain at your VPS and set up HTTPS (recommended)
Use nginx + certbot (Let's Encrypt) as a reverse proxy on port 443 → 4000.

### 6. Update client
In the client's server.js, change:
  const LICENSE_SERVER_URL = 'https://YOUR_LICENSE_SERVER_DOMAIN/api/validate';
to your actual domain, then re-obfuscate.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Managing licenses

### Generate a new license key for a customer
```
node server.js --gen "CustomerName"
```
Output example:  PT-A3F9B2C1D4E5F6A7B8C9D0E1

### View all licenses (admin API)
```
curl -H "x-admin-secret: your_secret" https://yourdomain.com/api/admin/licenses
```

### Revoke a license
```
curl -X POST -H "x-admin-secret: your_secret" \
  -H "Content-Type: application/json" \
  -d '{"key":"PT-XXXX"}' \
  https://yourdomain.com/api/admin/revoke
```

### Reset machine lock (customer changed PC)
```
curl -X POST -H "x-admin-secret: your_secret" \
  -H "Content-Type: application/json" \
  -d '{"key":"PT-XXXX"}' \
  https://yourdomain.com/api/admin/reset-machine
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## How it works
- First time a customer uses a key → machine ID is locked to their hardware
- If they try to use the same key on another PC → rejected
- You can reset the lock anytime (e.g. if they buy a new PC)
- Revoked keys are permanently blocked
- All activity is logged in licenses.json
