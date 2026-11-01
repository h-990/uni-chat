// Setup script — generates ADMIN_PASSWORD_HASH and HMAC_SECRET
// Run: node setup.js <admin_password>

const crypto = require('crypto');

const adminUsername = 'Harsh';
const adminPassword = process.argv[2] || 'Harsh@9990';

async function main() {
  // Hash: SHA-256 of "username:<password>"
  const hash = crypto.createHash('sha256')
    .update(adminUsername.toLowerCase() + ':' + adminPassword)
    .digest('hex');

  // Random HMAC secret
  const hmacSecret = crypto.randomBytes(32).toString('hex');

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║           UNI-CHAT SETUP                          ║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log('║                                                    ║');
  console.log(`║  Admin Username: ${adminUsername.padEnd(35)}║`);
  console.log(`║  Admin Password: ${adminPassword.padEnd(35)}║`);
  console.log('║                                                    ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  console.log('Run these commands to set your secrets:\n');
  console.log(`  echo "${hash}" | npx wrangler secret put ADMIN_PASSWORD_HASH`);
  console.log(`  echo "${hmacSecret}" | npx wrangler secret put HMAC_SECRET\n`);

  console.log('For local development, create a .dev.vars file:\n');
  console.log(`  ADMIN_PASSWORD_HASH=${hash}`);
  console.log(`  HMAC_SECRET=${hmacSecret}\n`);

  // Write .dev.vars file
  const fs = require('fs');
  const devVars = `ADMIN_PASSWORD_HASH=${hash}\nHMAC_SECRET=${hmacSecret}\n`;
  fs.writeFileSync('.dev.vars', devVars);
  console.log('✅ .dev.vars file created automatically!\n');
  console.log('Now run: npm run dev\n');
}

main();
