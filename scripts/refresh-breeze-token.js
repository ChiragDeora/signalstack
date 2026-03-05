#!/usr/bin/env node
// ============================================
// Breeze Session Token Auto-Refresher
// ============================================
// Uses Playwright to headlessly log into ICICI Direct,
// extract the session token from the OAuth redirect URL,
// and write it back to .env so the app can reconnect.
//
// Required env vars (set once, never expire):
//   BREEZE_API_KEY        - from api.icicidirect.com
//   BREEZE_SECRET_KEY     - from api.icicidirect.com
//   BREEZE_ICICI_USER     - your ICICI Direct user ID
//   BREEZE_ICICI_PASS     - your ICICI Direct password
//   BREEZE_ICICI_DOB      - your date of birth (DD/MM/YYYY) used as TOTP fallback
//   BREEZE_TOTP_SECRET    - (optional) base32 TOTP secret for 2FA automation
//
// Usage:
//   node scripts/refresh-breeze-token.js
//
// The script exits with code 0 on success, 1 on failure.
// On success it prints the new session token to stdout.

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---- TOTP helper (no external deps) ----
// RFC 6238 TOTP using only Node built-ins
function generateTOTP(base32Secret) {
  try {
    // Decode base32
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const secret = base32Secret.toUpperCase().replace(/=+$/, '');
    let bits = '';
    for (const char of secret) {
      const idx = alphabet.indexOf(char);
      if (idx === -1) continue;
      bits += idx.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    const key = Buffer.from(bytes);

    // HMAC-SHA1
    const crypto = require('crypto');
    const counter = Math.floor(Date.now() / 1000 / 30);
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();

    // Dynamic truncation
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)
    ) % 1_000_000;

    return code.toString().padStart(6, '0');
  } catch {
    return null;
  }
}

// ---- .env updater ----
function updateEnvFile(envPath, key, value) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

// ---- Main ----
async function refreshBreezeToken() {
  // Load env
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

  const apiKey      = process.env.BREEZE_API_KEY;
  const userId      = process.env.BREEZE_ICICI_USER;
  const password    = process.env.BREEZE_ICICI_PASS;
  const dob         = process.env.BREEZE_ICICI_DOB;   // DD/MM/YYYY — used if no TOTP
  const totpSecret  = process.env.BREEZE_TOTP_SECRET; // optional

  if (!apiKey || !userId || !password) {
    console.error('❌ Missing required env vars: BREEZE_API_KEY, BREEZE_ICICI_USER, BREEZE_ICICI_PASS');
    process.exit(1);
  }

  const loginUrl = `https://api.icicidirect.com/apiuser/login?api_key=${encodeURIComponent(apiKey)}`;
  console.log('🔐 Starting Breeze token refresh...');
  console.log(`🌐 Login URL: ${loginUrl}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let sessionToken = null;

  try {
    // Intercept the redirect that contains the session token
    page.on('response', async (response) => {
      const url = response.url();
      // The redirect after login looks like:
      // https://api.icicidirect.com/apiuser/login?api_key=...&apisession=SESSION_TOKEN
      const match = url.match(/[?&]apisession=([^&]+)/);
      if (match) {
        sessionToken = decodeURIComponent(match[1]);
        console.log('✅ Session token captured from redirect');
      }
    });

    // Also watch for URL changes (some flows use navigation)
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      const match = url.match(/[?&]apisession=([^&]+)/);
      if (match) {
        sessionToken = decodeURIComponent(match[1]);
        console.log('✅ Session token captured from navigation');
      }
    });

    // Step 1: Navigate to login page
    console.log('📄 Loading login page...');
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Step 2: Fill user ID
    await page.waitForSelector('input[name="userId"], input[id="userId"], input[placeholder*="User"], input[type="text"]', { timeout: 15_000 });
    const userInput = page.locator('input[name="userId"], input[id="userId"]').first();
    await userInput.fill(userId);
    console.log('✏️  Filled user ID');

    // Step 3: Fill password
    const passInput = page.locator('input[type="password"]').first();
    await passInput.fill(password);
    console.log('✏️  Filled password');

    // Step 4: Submit login form
    const loginBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Submit")').first();
    await loginBtn.click();
    console.log('🖱️  Clicked login button');

    // Step 5: Handle 2FA — TOTP or DOB
    await page.waitForTimeout(3000);

    // Check if there's a TOTP / OTP input
    const otpInput = page.locator('input[name="otp"], input[id="otp"], input[placeholder*="OTP"], input[placeholder*="TOTP"], input[maxlength="6"]').first();
    const otpVisible = await otpInput.isVisible().catch(() => false);

    if (otpVisible) {
      let otpValue = null;

      if (totpSecret) {
        otpValue = generateTOTP(totpSecret);
        console.log(`🔑 Generated TOTP: ${otpValue}`);
      } else if (dob) {
        // ICICI sometimes accepts DOB (DDMMYYYY) as the OTP on first login
        otpValue = dob.replace(/\//g, '');
        console.log(`📅 Using DOB as OTP: ${otpValue}`);
      }

      if (otpValue) {
        await otpInput.fill(otpValue);
        const otpSubmit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Verify")').first();
        await otpSubmit.click();
        console.log('🖱️  Submitted OTP');
      } else {
        console.error('❌ OTP required but neither BREEZE_TOTP_SECRET nor BREEZE_ICICI_DOB is set');
        await browser.close();
        process.exit(1);
      }
    }

    // Wait up to 15s for the session token to appear
    const deadline = Date.now() + 15_000;
    while (!sessionToken && Date.now() < deadline) {
      await page.waitForTimeout(500);
      // Also check current URL
      const currentUrl = page.url();
      const match = currentUrl.match(/[?&]apisession=([^&]+)/);
      if (match) {
        sessionToken = decodeURIComponent(match[1]);
      }
    }

    if (!sessionToken) {
      // Last attempt: look for token in page content
      const bodyText = await page.content();
      const match = bodyText.match(/apisession['":\s]+([A-Za-z0-9_\-]{20,})/);
      if (match) {
        sessionToken = match[1];
        console.log('✅ Session token extracted from page content');
      }
    }

  } catch (err) {
    console.error('❌ Browser automation error:', err.message);
    await browser.close();
    process.exit(1);
  }

  await browser.close();

  if (!sessionToken) {
    console.error('❌ Failed to extract session token. Check credentials or 2FA setup.');
    process.exit(1);
  }

  // Write token to .env
  const envPath = path.resolve(__dirname, '../.env');
  updateEnvFile(envPath, 'BREEZE_SESSION_TOKEN', sessionToken);
  console.log(`✅ BREEZE_SESSION_TOKEN updated in .env`);
  console.log(`🔑 Token: ${sessionToken}`);

  // Print token so server.js can capture it via stdout
  process.stdout.write(sessionToken);
  process.exit(0);
}

refreshBreezeToken().catch((err) => {
  console.error('❌ Unhandled error:', err);
  process.exit(1);
});
