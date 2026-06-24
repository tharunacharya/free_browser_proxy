<h1 align="center">FreeBrowse</h1>

<p align="center">A free, self-hosted web proxy with a live connection meter and multi-backend auto-switching.</p>

---

FreeBrowse lets you open websites through a server you control. Enter a URL (or a
search term) and the page loads tunneled through your backend. It includes:

- **Live meter board** — latency, download/upload speed, and the exit country/IP/ISP that sites see.
- **Multi-backend auto-switching** — run it in several regions and it keeps the fastest one active.
- **One-click free deploy** on Render's free tier.

## Deploy

See **[DEPLOY.md](DEPLOY.md)** for step-by-step instructions (GitHub → Render, free, no credit card).

Quick version:

```bash
npm install
node src/index.js     # serves on $PORT (default 8080)
```

Requires **Node.js 16+**. Must be served over **HTTPS** (Render does this automatically)
because it uses a Service Worker.

## Honest limits

This is a **personal-use** proxy on a small free server. It handles reading-style
sites well (Wikipedia, news, blogs, docs). It will **not** work for Google/account
logins, YouTube, or sites behind Cloudflare or strict security headers — that's an
inherent limit of every web proxy, not a bug. Don't use it for streaming video.

## Configuration

- `public/backends.js` — list extra backends to switch between.
- `public/index.html` — branding and default search engine.
- `render.yaml` — deploy region and settings.

---

<sub>Built on the open-source <a href="https://github.com/MercuryWorkshop/scramjet">Scramjet</a>
proxy engine and <a href="https://github.com/MercuryWorkshop/wisp-js">wisp-js</a>.
Licensed under <a href="LICENSE">AGPL-3.0</a> — source is provided in this repository as required.</sub>
