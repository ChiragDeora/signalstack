# SignalStack — React Native (Expo) client

A native Android (and iOS) client that talks to the same Next.js backend used
by the PWA. No engine duplication: market polling, EMA / RSI math, alert
de-duplication, email, telegram and chart attachments all run on the server.
The phone just renders state and pushes config.

## What's inside

```
mobile/
├── App.tsx                  Clerk provider + SignedIn / SignedOut gate
├── app.json                 Expo config (channel, package, plugins)
├── eas.json                 EAS build profiles (preview = APK)
├── package.json
├── babel.config.js
├── tsconfig.json
└── src/
    ├── components/          LivePill, Spotlight, WatchRow, RsiMeter, Toggle, TimeframePills
    ├── lib/
    │   ├── api.ts           axios instance — base URL from app.json `extra.apiBaseUrl`
    │   ├── socket.ts        socket.io-client → /socket.io on the same host
    │   ├── push.ts          expo-notifications register / unregister
    │   ├── theme.ts         tokens + useTheme()
    │   ├── tokenCache.ts    SecureStore cache for Clerk
    │   └── types.ts
    └── screens/
        ├── SignInScreen.tsx  Email + password via Clerk Expo
        ├── HomeScreen.tsx    Live + Watchlist + bottom nav
        ├── ConfigScreen.tsx  EMA crossover, RSI signals, direction, monitor CTA
        ├── SearchSheet.tsx   Symbol search (NSE / NFO / BSE)
        └── ToolsScreen.tsx   Push enable, Telegram chat id, Sign out
```

The screens use only props the backend already exposes — `/api/monitor`,
`/api/user/watches`, `/api/user/config`, `/api/user/watchlist`,
`/api/fetch-price`, `/api/search-symbols/<exchange>`, `/api/user/telegram`,
`/api/mobile/push-subscribe`.

## One-time setup

1. Install dependencies:

   ```bash
   cd mobile
   npm install
   npx expo install   # snaps versions to the SDK's pinned ranges
   ```

2. Configure secrets in `app.json` → `expo.extra`:

   ```jsonc
   {
     "extra": {
       "apiBaseUrl": "https://signalstack-105d.onrender.com",   // your backend
       "clerkPublishableKey": "pk_live_...",                    // Clerk Frontend API key
       "eas": { "projectId": "..." }                            // run `eas init` to get this
     }
   }
   ```

   The mobile app uses Clerk's **publishable key** only. The server keeps
   `CLERK_SECRET_KEY`; the phone never sees it.

3. Run database migrations once:

   ```bash
   # In the project root
   supabase db push
   ```

   This applies the new `expo_push_tokens` table and the `profiles.telegram_chat_id`
   column.

4. Configure Expo project + EAS:

   ```bash
   npx eas-cli init           # creates the EAS projectId
   npx eas-cli build:configure
   ```

## Backend env vars

Add to the Next.js server (`.env`):

| Var                     | Required for         | Notes                                                                 |
|-------------------------|----------------------|-----------------------------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`    | Telegram alerts      | From `@BotFather`. The legacy `telegram_auth_bot_api` name also works. |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram "Connect" button | Optional. Random string — verifies webhook calls really come from Telegram. |
| `APP_PUBLIC_URL`        | Telegram "Connect" button | Optional. Your deployed HTTPS URL (Render sets `RENDER_EXTERNAL_URL` automatically). Used to register the webhook on boot. |
| (existing)              | Brevo, Clerk, Supabase, Angel One — unchanged. |

On boot, the server calls `/api/telegram/setup`, which registers `<APP_PUBLIC_URL>/api/telegram/webhook`
with Telegram. Once that's done, users tap **Connect Telegram** in the app's
Tools drawer, press **Start** in the chat that opens, and the bot links their
chat id automatically — no manual `getUpdates` lookup needed.

Expo Push API needs no key for tokens from the same Expo project, so there
is nothing extra to set for push.

## Run locally

```bash
cd mobile
npm run android   # boots Expo Go / dev client on a USB device or emulator
```

For push notifications you need a real device — the Android emulator and
iOS simulator cannot receive Expo push.

## Build an APK

```bash
cd mobile
npm run build:apk   # EAS Build, profile `preview`, distribution `internal`
```

EAS returns a URL when the build is done. Install on a phone:

```bash
adb install signalstack-preview.apk
```

For the Play Store, use `npm run build:aab` (production profile, AAB).

## How alerts reach the phone

```
Angel One → CrossoverService (server) ─┬─→ socket.io (in-app banner / state)
                                       ├─→ Brevo (email)
                                       ├─→ Telegram bot (DM to user)
                                       ├─→ Web Push   (PWA only)
                                       └─→ Expo Push  (mobile)
```

Per-user delivery is keyed on the Clerk `userId`. Each phone registers its
Expo push token via `POST /api/mobile/push-subscribe`; the server stores it
in `expo_push_tokens` and fans alerts out to every active token for the user
when a watch fires.

## Known scaffold gaps

- **App icon / splash** — replace `src/assets/icon.png` and
  `src/assets/splash.png` with your real assets. Without them, `expo prebuild`
  will warn.
- **Sign-up flow** — handled in the web app to keep the mobile scaffold thin.
  Existing accounts work via email + password sign-in.
- **In-app alert history** — the socket emits `alert:crossover` / `alert:rsi`
  but the scaffold renders only the live indicator state. Bolt on a screen
  for history when needed.

See `PRIVACY_POLICY.md` in the project root for the data policy that ships
with the app.
