# Deploying FreeBrowse (free, public)

This is a [Scramjet](https://github.com/MercuryWorkshop/scramjet) web proxy with a
rebranded landing page, pre-configured to deploy on **Render's free tier**.

> **Honest expectations.** This is a *personal-use* proxy. It handles reading-style
> sites well (Wikipedia, blogs, docs, news). It will **not** work for Google/account
> logins, YouTube, or Cloudflare-protected sites — that's an inherent limit of every
> web proxy, not a bug. Don't use it for streaming video: it routes every byte through
> your tiny free server and will exhaust the bandwidth.

---

## Step 1 — Put this code in your own GitHub repo

You need this on GitHub so Render can build it. From inside this folder:

```bash
# 1. Create an EMPTY repo on github.com first (no README), e.g. "freebrowse".
#    Then point this local repo at it and push:
git remote add origin https://github.com/<your-username>/freebrowse.git
git push -u origin main
```

The first push opens a browser login (Git Credential Manager) — sign in to GitHub once.

## Step 2 — Deploy on Render (no credit card)

1. Go to **https://render.com** and **sign up with your GitHub account**.
2. Dashboard → **New +** → **Blueprint**.
3. Select your `freebrowse` repo. Render reads `render.yaml` and pre-fills everything.
4. Click **Apply**. Wait for the first build + deploy (a few minutes).
5. Open the assigned URL: `https://freebrowse-XXXX.onrender.com` — that's your live proxy.

> **If Blueprint isn't offered:** use **New + → Web Service** instead, pick the repo, and set:
> - Runtime: **Node**
> - Build Command: `npm install`
> - Start Command: `node src/index.js`
> - Instance Type: **Free**
> - Env var `NODE_VERSION` = `22`

## Step 3 — (Optional) Stop it from sleeping

The free instance sleeps after 15 min idle (~30–60s cold start on the next visit).
To reduce that, create a free monitor on **https://cron-job.org** or **UptimeRobot**
that sends an HTTP request to your URL every ~10 minutes.

---

## Speed, switching & the meter board

The site has a floating **meter board** (bottom-right) showing live **latency**,
**download/upload speed**, and the **exit country / IP / ISP** that websites see.

To actually get *faster* you need something to switch between. The biggest wins:

1. **Deploy in a region near you.** `render.yaml` defaults to **Singapore**
   (closest for India). Change `region:` (singapore | frankfurt | oregon | ohio |
   virginia) if you're elsewhere — this is the #1 latency factor.
2. **Keep it awake** (Step 3 above) — cold starts are the worst slowdown.
3. **Add more backends and let it auto-pick the fastest.** Deploy this same repo a
   second/third time in *different* regions (each as its own Render service with a
   distinct `REGION_LABEL`), then list their URLs in [`public/backends.js`](public/backends.js):
   ```js
   window.PROXY_BACKENDS = [
     { label: "Frankfurt", url: "https://your-eu-app.onrender.com" },
     { label: "Ohio (US)", url: "https://your-us-app.onrender.com" },
   ];
   ```
   The dashboard pings each, and in **Auto** mode keeps the fastest one active.
   Click any backend to switch manually (reloads the open page through it).

> Honest note: switching between equally-tiny free servers makes the proxy
> *resilient and self-optimizing*, not blazing. One small free instance has a hard
> ceiling (0.1 CPU). Region + keep-alive matter more than the number of backends.

## Notes & gotchas

- **Use Chrome or Edge.** The proxy relies on a Service Worker, which needs HTTPS —
  Render provides that automatically on `*.onrender.com`.
- **Don't rename the Render service to contain "proxy."** Render has suspended
  proxy-*named* projects. The Blueprint uses a neutral name on purpose.
- **Free-tier limits:** 512 MB RAM, 0.1 CPU, 100 GB/month bandwidth.
- **License:** AGPL-3.0 (from upstream Scramjet). Keep `LICENSE` and source available.
- **Customize:** edit `public/index.html` for branding; change the search engine in the
  hidden `#sj-search-engine` input; commit and `git push` — Render auto-redeploys.
