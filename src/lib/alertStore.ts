// ============================================
// Alert Store - In-memory alert history
// ============================================

import { CrossoverAlert } from './types';

let alertHistory: CrossoverAlert[] = [];

export function addAlert(alert: CrossoverAlert): void {
  alertHistory.unshift(alert);
  if (alertHistory.length > 200) {
    alertHistory = alertHistory.slice(0, 200);
  }
  console.log(`💾 Alert stored: ${alert.crossoverType} ${alert.symbol} (total: ${alertHistory.length})`);
}

export function getAlerts(): CrossoverAlert[] {
  return alertHistory;
}

export function clearAlerts(): void {
  alertHistory = [];
}
