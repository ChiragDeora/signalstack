# Per-User Persistent State Plan

## Problem
All UI state (symbol, EMAs, timeframe, alerts, monitoring status) is lost on page refresh. No user isolation — Socket.IO broadcasts to everyone.

## Solution: localStorage + per-user server state + Socket.IO rooms

### 1. Frontend: localStorage persistence
- Generate a `userId` (UUID) on first visit, stored in localStorage
- Persist to localStorage: symbol, timeframe, emas[], trackBullish, trackBearish, currency
- Restore from localStorage on mount

### 2. Frontend: Hydrate from server on mount
- Fetch alerts from `GET /api/alerts?userId=xxx`
- Fetch monitoring status from `GET /api/monitor?userId=xxx`
- Restore isMonitoring, monitorStatus, emaValues if monitoring is still active

### 3. Server: Per-user alert storage (JSON file)
- alertStore becomes per-user: `Map<userId, alerts[]>`
- Persist to `data/alerts.json` on disk (survives server restart)
- API accepts userId param

### 4. Server: Per-user monitoring + Socket.IO rooms
- WatchConfig gets `userId` field
- CrossoverService tracks userId per watch, emits to `user:${userId}` room
- server.js: on connection, client sends userId, joins their room
- Frontend: send userId in Socket.IO auth, only receives own events

### Files to modify
- `src/components/EMAAlertSystem.tsx` — localStorage + hydration + userId
- `src/lib/alertStore.ts` — per-user, file-backed
- `src/lib/crossoverService.ts` — userId scoping, Socket.IO rooms
- `src/lib/types.ts` — add userId to WatchConfig
- `src/app/api/alerts/route.ts` — accept userId
- `src/app/api/monitor/route.ts` — accept userId, return per-user status
- `server.js` — Socket.IO room handling
