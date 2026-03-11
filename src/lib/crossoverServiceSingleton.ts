/**
 * Single shared CrossoverService instance for the app.
 * Used by both monitor API (polling + alerts) and push-subscribe API (subscriptions).
 * Ensures push subscriptions are on the same instance that sends alerts.
 * Loads persisted push subscriptions on startup so they survive restarts.
 */

import { CrossoverService } from './crossoverService';
import { getAllWatches } from './watchPersistence';
import {
  getAllPushSubscriptions,
  removePushSubscription as persistRemovePushSubscription,
} from './pushSubscriptionPersistence';

let service: CrossoverService | null = null;
let restorePromise: Promise<CrossoverService> | null = null;

export async function getOrCreateCrossoverService(): Promise<CrossoverService> {
  if (service) return service;
  if (restorePromise) return restorePromise;
  restorePromise = (async () => {
    const io = (global as any).__io || null;
    const svc = new CrossoverService(io, {
      onSubscriptionExpired: (endpoint) => persistRemovePushSubscription(endpoint),
    });
    svc.initialize();
    const configs = await getAllWatches();
    await svc.restoreAllWatches(configs);
    const subs = await getAllPushSubscriptions();
    for (const sub of subs) {
      svc.addPushSubscription(sub, sub.userId);
    }
    if (subs.length > 0) {
      console.log(`🔔 Restored ${subs.length} push subscription(s)`);
    }
    service = svc;
    return svc;
  })();
  return restorePromise;
}
