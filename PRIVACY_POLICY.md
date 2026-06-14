# SignalStack Privacy Policy

_Last updated: 14 June 2026_

This Privacy Policy describes how **SignalStack** ("we", "us", "our") collects,
uses, and protects your information when you use the web app (signalstack)
and the Android mobile app.

By using SignalStack you agree to the terms below. If you do not agree,
please stop using the service.

## 1. Who we are

SignalStack is a personal-use tool for monitoring NSE / BSE / NFO equity and
F&O instruments and producing EMA-crossover and RSI signal alerts. It is
operated by an independent developer and is not a registered investment
advisor, broker, or research analyst.

**SignalStack does not provide trading recommendations.** Alerts are
technical signals and must not be treated as investment advice.

Contact: chiragdeora984@gmail.com

## 2. Information we collect

### 2.1 Account information (via Clerk)

When you sign in we receive your **email address** and a **Clerk user id**
from Clerk Inc. (our authentication provider). We use your Clerk user id
to segregate the data you store in our database.

### 2.2 Watchlist and indicator configuration

We store in our database:

- Symbols you choose to watch (e.g. RELIANCE, NIFTY50)
- The timeframe(s) you pick for each watch
- EMA periods and RSI settings (period, overbought/oversold thresholds,
  signal-line length, enabled signal types)
- Direction preferences (bullish / bearish / both)
- The set of symbols on your watchlist (for UI restore)
- Push subscription endpoints (browser-issued, for sending you push
  notifications)
- Optional Telegram chat id (only if you choose to enable Telegram alerts)

### 2.3 Alert history

When the engine fires a crossover or RSI alert we store the alert payload
(symbol, indicator values, price, timestamp, source) so you can review
recent alerts inside the app.

### 2.4 Operational data

We log polling activity, fetch failures, and warmup status. These logs
do not contain personal information beyond the Clerk user id.

### 2.5 We do **not** collect

- Bank, brokerage, or trading account credentials
- Payment information
- Real names, phone numbers, or postal addresses (unless you provide them
  in support emails)
- Device identifiers beyond those required by the push notification
  protocols (FCM/APNs/Web Push)
- Cross-site advertising or analytics fingerprints

## 3. How we use your information

We use the information above strictly to operate the app:

- Authenticate your session and scope data to your account
- Poll market data from Angel One SmartAPI for the symbols you have asked
  us to watch
- Compute EMAs, RSI, and crossover/threshold signals
- Deliver alerts to you via in-app socket events, browser push, email
  (Brevo / Sendinblue), and Telegram (only if you have configured a chat id)
- Restore your monitoring state after a server restart so you do not
  re-configure every session
- Send a daily end-of-day summary email for symbols on your watchlist
  (open / high / close today; previous trading day's high / low)

We do not sell, rent, share, or trade your personal information with any
third party for marketing or any other purpose.

## 4. Third-party processors

To run the service we share the minimum required data with the following
processors:

| Processor | Purpose | Data shared |
|-----------|---------|-------------|
| Clerk Inc. | Authentication | Email, sign-in credentials |
| Supabase | Database / storage | Clerk user id, watch configs, alerts, push subs |
| Angel One SmartAPI | Market data | Symbol names you watch (no user id) |
| Brevo (Sendinblue) | Transactional email | Recipient email address, alert content |
| Web Push (browser vendor) | Push notifications | Push endpoint, alert content |
| Telegram Bot API | Telegram messages | Your Telegram chat id, alert content |
| Render.com / Railway | Hosting | All inbound HTTP traffic |

Each of these processors operates under its own privacy policy.

## 5. Retention

- Watchlist / indicator configs: kept until you remove the symbol or
  delete your account.
- Alert history: rolling window of the most recent ~100 alerts per user.
- Push subscriptions: kept until the browser invalidates them or you
  disable push.
- Telegram chat id: kept until you clear it from the Tools menu.
- Server logs: rotated automatically; not used for analytics or profiling.

## 6. Your rights

You can at any time:

- Remove a symbol from your watchlist (deletes its watch config)
- Disable push notifications from the Tools menu
- Remove the Telegram chat id from the Tools menu
- Request export or deletion of your data by emailing
  chiragdeora984@gmail.com

We will action deletion requests within 30 days.

## 7. Security

Data in transit is encrypted (HTTPS / WSS). Database access is restricted
by Supabase service-role keys held server-side only. Push notifications
are signed with VAPID. We do not run analytics scripts on the front-end.

That said, no online service is fully invulnerable. Use a strong, unique
password on your Clerk account.

## 8. Children

SignalStack is intended for users aged 18 and over. We do not knowingly
collect data from children under 13.

## 9. Disclaimer regarding financial signals

Alerts are derived purely from technical indicators on publicly traded
prices fetched from Angel One. They are provided for educational and
personal-monitoring purposes only. SignalStack and its developer accept
no liability for trading or investment decisions made on the basis of
alerts received through this service.

## 10. Changes to this policy

We may update this policy when functionality changes (e.g. when we add or
remove a processor). Material changes will be announced in the app and
the "Last updated" date above will be revised.

## 11. Contact

Questions, deletion requests, or feedback:

**chiragdeora984@gmail.com**
