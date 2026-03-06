/**
 * Server-side persistence for push notification subscriptions.
 * Survives process restarts so push alerts work after deploy without re-enabling.
 */

import { PushSubscriptionData } from './types';
import path from 'path';
import fs from 'fs/promises';

const DATA_DIR = path.join(process.cwd(), 'data');
const SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readSubscriptions(): Promise<PushSubscriptionData[]> {
  try {
    await ensureDir();
    const raw = await fs.readFile(SUBS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data as PushSubscriptionData[];
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    console.warn('pushSubscriptionPersistence: read failed', e?.message);
    return [];
  }
}

async function writeSubscriptions(subs: PushSubscriptionData[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(SUBS_FILE, JSON.stringify(subs, null, 0), 'utf-8');
}

export async function getAllPushSubscriptions(): Promise<PushSubscriptionData[]> {
  return readSubscriptions();
}

export async function savePushSubscription(sub: PushSubscriptionData): Promise<void> {
  const all = await readSubscriptions();
  const filtered = all.filter((s) => s.endpoint !== sub.endpoint);
  filtered.push(sub);
  await writeSubscriptions(filtered);
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  const all = await readSubscriptions();
  const filtered = all.filter((s) => s.endpoint !== endpoint);
  await writeSubscriptions(filtered);
}
