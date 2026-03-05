/**
 * VAPID key loading and optional auto-generation for Web Push.
 * Aligns with https://blog.openreplay.com/implementing-push-notifications-web-push-api/
 * - Prefer env: NEXT_PUBLIC_VAPID_PUBLIC_KEY (or VAPID_PUBLIC_KEY), VAPID_PRIVATE_KEY, VAPID_SUBJECT
 * - Else load from .vapid-keys.json (auto-generated if missing)
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_SUBJECT = 'mailto:chiragdeora984@gmail.com';
const VAPID_KEYS_FILE = '.vapid-keys.json';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let cached: VapidKeys | null | undefined = undefined;

function keysFilePath(): string {
  return path.join(process.cwd(), VAPID_KEYS_FILE);
}

/** Vercel/serverless has read-only fs; skip file read/write and auto-generate there. */
function isReadOnlyFs(): boolean {
  return !!process.env.VERCEL;
}

function loadFromFile(): VapidKeys | null {
  if (isReadOnlyFs()) return null;
  try {
    const raw = fs.readFileSync(keysFilePath(), 'utf-8');
    const data = JSON.parse(raw) as { publicKey?: string; privateKey?: string; subject?: string };
    if (data.publicKey && data.privateKey) {
      return {
        publicKey: data.publicKey,
        privateKey: data.privateKey,
        subject: data.subject || DEFAULT_SUBJECT,
      };
    }
  } catch {
    // file missing or invalid
  }
  return null;
}

function generateAndPersist(): VapidKeys | null {
  if (isReadOnlyFs()) return null;
  try {
    const webpush = require('web-push');
    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    const keys: VapidKeys = {
      publicKey,
      privateKey,
      subject: DEFAULT_SUBJECT,
    };
    fs.writeFileSync(
      keysFilePath(),
      JSON.stringify(keys, null, 2),
      { mode: 0o600 }
    );
    console.log('✅ VAPID keys auto-generated and saved to', VAPID_KEYS_FILE);
    return keys;
  } catch (e) {
    console.warn('⚠️  Could not auto-generate VAPID keys:', (e as Error).message);
    return null;
  }
}

/**
 * Returns VAPID keys from env, then from .vapid-keys.json, or generates and persists new keys.
 * Use this on the server only (Node).
 */
export function getVapidKeys(): VapidKeys | null {
  if (cached !== undefined) return cached;

  const publicKey =
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || DEFAULT_SUBJECT;

  if (publicKey && privateKey) {
    cached = { publicKey, privateKey, subject };
    return cached;
  }

  cached = loadFromFile();
  if (cached) return cached;

  cached = generateAndPersist();
  return cached;
}

export function isVapidConfigured(): boolean {
  return getVapidKeys() !== null;
}
