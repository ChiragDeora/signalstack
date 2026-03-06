/**
 * Server-side persistence for watch configs.
 * Survives process restarts so monitoring can auto-restore without the UI.
 */

import { WatchConfig } from './types';
import path from 'path';
import fs from 'fs/promises';

const DATA_DIR = path.join(process.cwd(), 'data');
const WATCHES_FILE = path.join(DATA_DIR, 'watches.json');

function watchKey(config: { userId?: string; symbol: string; timeframe: string }): string {
  const uid = config.userId ?? '';
  return `${uid}:${(config.symbol || '').toUpperCase()}:${config.timeframe || ''}`;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readWatches(): Promise<WatchConfig[]> {
  try {
    await ensureDir();
    const raw = await fs.readFile(WATCHES_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data as WatchConfig[];
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    console.warn('watchPersistence: read failed', e?.message);
    return [];
  }
}

async function writeWatches(configs: WatchConfig[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(WATCHES_FILE, JSON.stringify(configs, null, 0), 'utf-8');
}

export async function getAllWatches(): Promise<WatchConfig[]> {
  return readWatches();
}

export async function saveWatch(config: WatchConfig): Promise<void> {
  const key = watchKey(config);
  const all = await readWatches();
  const filtered = all.filter((c) => watchKey(c) !== key);
  filtered.push(config);
  await writeWatches(filtered);
}

export async function removeWatch(userId: string, symbol: string, timeframe?: string): Promise<void> {
  const upper = (symbol || '').toUpperCase();
  const all = await readWatches();
  const filtered = all.filter((c) => {
    if (c.userId !== userId) return true;
    if ((c.symbol || '').toUpperCase() !== upper) return true;
    if (timeframe != null && c.timeframe !== timeframe) return true;
    return false;
  });
  await writeWatches(filtered);
}
