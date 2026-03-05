'use client';

import { useEffect } from 'react';

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          console.log('✅ Service Worker registered (scope:', reg.scope, ')');
        })
        .catch((err) => {
          console.warn('⚠️ Service Worker registration failed:', err);
        });
    }
  }, []);

  return null;
}
