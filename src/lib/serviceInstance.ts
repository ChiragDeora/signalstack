// ============================================
// Service Singleton
// ============================================
// Provides a single instance of CrossoverService
// accessible from API routes and server.js.

import { CrossoverService } from './crossoverService';

let service: CrossoverService | null = null;

/**
 * Initialize the service with a Socket.IO server instance.
 * Call once from server.js on startup.
 */
export function initService(io: any): CrossoverService {
  if (!service) {
    service = new CrossoverService(io);
    service.initialize().catch((err) => {
      console.error('❌ Service initialization error:', err);
    });
    console.log('✅ CrossoverService singleton created');
  }
  return service;
}

/**
 * Get the service instance. Returns null if not initialized yet.
 * API routes use this to access the service.
 */
export function getService(): CrossoverService | null {
  return service;
}
