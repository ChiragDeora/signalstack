/**
 * Single shared CrossoverService instance for the app.
 * Used by both monitor API (polling + alerts) and push-subscribe API (subscriptions).
 * Ensures push subscriptions are on the same instance that sends alerts.
 * Loads persisted push subscriptions on startup so they survive restarts.
 *
 * Stored on globalThis so the instance (and its running intervals) survives
 * Next.js dev-mode module reloads. Without this, API routes can silently
 * create a second CrossoverService while the original keeps running.
 */

import { CrossoverService } from './crossoverService';
import { getAllWatches } from './watchPersistence';
import {
  getAllPushSubscriptions,
  removePushSubscription as persistRemovePushSubscription,
} from './pushSubscriptionPersistence';
import { initAlertLog } from './alertLogger';

const g = globalThis as unknown as {
  __crossoverService?: CrossoverService | null;
  __crossoverServicePromise?: Promise<CrossoverService> | null;
};

export async function getOrCreateCrossoverService(): Promise<CrossoverService> {
  if (g.__crossoverService) return g.__crossoverService;
  if (g.__crossoverServicePromise) return g.__crossoverServicePromise;
  g.__crossoverServicePromise = (async () => {
    const io = (global as any).__io || null;
    const svc = new CrossoverService(io, {
      onSubscriptionExpired: (endpoint) => persistRemovePushSubscription(endpoint),
    });
    svc.initialize();
    // Make sure the xlsx alert log file exists before any alert tries to append
    await initAlertLog();
    const configs = await getAllWatches();
    await svc.restoreAllWatches(configs);
    const subs = await getAllPushSubscriptions();
    for (const sub of subs) {
      svc.addPushSubscription(sub, sub.userId);
    }
    if (subs.length > 0) {
      console.log(`🔔 Restored ${subs.length} push subscription(s)`);
    }
    g.__crossoverService = svc;
    return svc;
  })();
  return g.__crossoverServicePromise;
}
