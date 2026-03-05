# Deploy SignalStack with Node server (Socket.IO + real-time monitoring)

On **Vercel**, the app runs as serverless functions only. There is **no long-lived Node process**, so:

- Socket.IO returns **404** (no WebSocket server)
- Cron/interval jobs in `crossoverService` **don’t run**
- EMA warmup and live updates **never complete** → "Warming up EMA data..." stays forever

To get **real-time EMA data, crossover alerts, and push notifications**, deploy to a platform that runs your **custom Node server** (`server.js`).

**You don’t need both Vercel and Railway.** Use **one** deployment:
- **Railway (or Render/VPS)** → full app (Live, EMA, push). Point users to this URL.
- **Vercel only** → app works but stays “Offline” and EMA may not finish warming up; use only if you’re okay with that.

---

## Option A: Railway (recommended)

1. **Sign up** at [railway.app](https://railway.app) and create a new project.

2. **Deploy from GitHub**
   - Click **“New Project”** → **“Deploy from GitHub repo”**
   - Select your `ema-alert-nextjs` repo (and branch, e.g. `main`)

3. **Configure build and start**
   - The repo includes a **`railway.toml`** that sets **Build Command** to `npm run build` and **Start Command** to `npm run start`. If your service picks it up, you don’t need to set these in the dashboard.
   - Otherwise, in the service **Settings → Build / Deploy**, set:
     - **Build Command:** `npm run build`  
       (or `npm install && npm run build`)
     - **Start Command:** `npm run start`  
       **Important:** Do **not** use `next start`. You must run `npm run start` so that `node server.js` runs (Express + Socket.IO + Next.js).

4. **Environment variables**
   - In the same service → **Variables**, add the same vars you use locally (from `.env`), for example:
     - Clerk: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and Clerk redirect URLs pointing to your Railway URL (e.g. `https://your-app.up.railway.app`)
     - Angel One (or your data source): e.g. `ANGEL_ONE_API_KEY`, etc.
     - Optional push: `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
     - Optional email (Brevo SMTP): `BREVO_SMTP_USER`, `BREVO_SMTP_PASS` (and optionally `BREVO_ALERT_TO` = comma-separated emails for crossover alerts, `BREVO_FROM_EMAIL` for From address)
   - Railway sets `PORT` for you; your app already uses `process.env.PORT || 3000`.

5. **Deploy**
   - Push to the connected branch or click **Deploy**. After the build, Railway will run `npm run start` and keep the process running.

6. **Use the Railway URL**
   - Open the generated URL (e.g. `https://xxx.up.railway.app`). That’s the deployment where Socket.IO and monitoring run. Use this URL on your phone instead of the Vercel URL.
   - If the app shows **"Offline"**: make sure you’re on the **Railway** URL (not Vercel), that the start command is **`npm run start`**, and that the service is running. The client tries polling then WebSocket; check the browser console for `Socket connect_error` if it still fails.

7. **Railway: Deployment “successful” but app not loading?**
   - Railway routes traffic to **port 8080** (or whatever `PORT` it sets). The app uses `process.env.PORT`, so it will listen on the right port. You do **not** need to set `PORT` in Variables.
   - **Build Command** must be set so Next.js builds. In **Settings → Build**, set **Build Command** to `npm run build` (or `npm install && npm run build`). If this is missing, Railway may only run `npm install`, so there is no `.next` folder and the app will crash on start.
   - **Start Command** must be `npm run start` (runs `node server.js`). In **Settings → Deploy** (or **Settings → General**), set **Start Command** to `npm run start`. Do not use `next start` or leave blank if the default is wrong.
   - Check **Deploy logs** (Railway dashboard → your service → **Deployments** → latest → **View logs**). Look for errors like “Cannot find module”, “EADDRINUSE”, or “Error: Could not find a production build”. If you see “SignalStack ready” and “WebSocket server running”, the server started correctly.
   - To confirm the app is up: open `https://signalstack-production.up.railway.app/api/status`. If you get JSON with `"status":"running"`, the Node server is responding.

8. **PWA on Railway**
   - **Yes, PWA works on Railway.** The app is served over HTTPS (Railway provides it), and the manifest (`/manifest.json`) and service worker (`/sw.js`) are served from the same origin. No extra config needed. Install to home screen from the Railway URL and push/offline behaviour will work once the app is live.

9. **Brevo email (SMTP relay + notifications)**
   - Set **BREVO_SMTP_USER** (Brevo SMTP login email) and **BREVO_SMTP_PASS** (SMTP key from Brevo → SMTP & API). Optional: **BREVO_SMTP_HOST** (default `smtp-relay.brevo.com`), **BREVO_SMTP_PORT** (default `587`), **BREVO_FROM_EMAIL** (From address).
   - **Crossover alerts by email:** When a signed-in user is monitoring a symbol and a crossover fires, the alert is sent to **that user’s Clerk email** (no extra config). Optionally set **BREVO_ALERT_TO** (comma-separated emails) to also send every alert to those addresses (e.g. admins).
   - **Relay (send custom emails):** Signed-in users can POST to `/api/send-email` with `{ to, subject, text?, html? }` to send email via Brevo. Use this for contact forms or any app-triggered email.

---

## Option B: Render

1. Go to [render.com](https://render.com) → **New** → **Web Service**.

2. **Connect** your GitHub repo and select the same repo/branch.

3. **Settings**
   - **Runtime:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm run start`  
     (Again: **not** `next start` — you need `node server.js`.)

4. **Environment**
   - Add the same env vars as in Option A (Clerk, Angel One, VAPID, etc.).
   - Render sets `PORT`; your app uses it.

5. **Deploy** and use the Render URL (e.g. `https://signalstack.onrender.com`) for real-time behaviour.

---

## Option C: VPS (DigitalOcean, Linode, etc.)

1. **Server:** Create a Node-capable droplet/instance (e.g. Ubuntu 22.04).

2. **On the server:**
   ```bash
   # Clone repo (or use CI/CD to deploy)
   git clone https://github.com/YOUR_USER/ema-alert-nextjs.git
   cd ema-alert-nextjs

   # Env file
   cp .env.example .env   # or create .env and paste your vars
   nano .env              # add production values

   # Install and build
   npm ci
   npm run build

   # Run (use a process manager in production)
   npm run start
   ```

3. **Keep it running:** Use **pm2** so the server restarts on crash and on reboot:
   ```bash
   npm install -g pm2
   pm2 start npm --name "signalstack" -- run start
   pm2 save && pm2 startup
   ```

4. Put a **reverse proxy** (e.g. Nginx) or a tunnel in front if you want HTTPS and a domain.

---

## Checklist

| Item | Vercel | Railway / Render / VPS |
|------|--------|-------------------------|
| Next.js app (pages, API routes) | ✅ | ✅ |
| Custom server (`server.js`) | ❌ | ✅ |
| Socket.IO | ❌ 404 | ✅ |
| Cron/interval (monitoring) | ❌ | ✅ |
| EMA warmup + live updates | ❌ | ✅ |
| Push (with VAPID env vars) | ✅ if env set | ✅ |
| Email alerts (Brevo SMTP) | ❌ | ✅ if BREVO_* set |

**Summary:** For real-time monitoring and no more stuck "Warming up EMA data...", deploy to **Railway**, **Render**, or a **VPS** and use **`npm run start`** so `node server.js` runs. Use that app URL (not Vercel) on your father’s phone.
