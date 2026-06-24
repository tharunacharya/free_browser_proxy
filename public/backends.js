"use strict";
/**
 * Proxy backends the dashboard can switch between.
 *
 * The site you're currently on is ALWAYS added automatically — you don't need
 * to list it here. Add EXTRA backends below as you deploy them (e.g. the same
 * repo deployed to another Render region, or another free host). The dashboard
 * pings each one, shows its latency, and in "Auto" mode picks the fastest.
 *
 * Each entry: { label: "Friendly name", url: "https://your-backend.onrender.com" }
 *   - url = the base https:// URL of that deployment (no trailing slash needed)
 *   - the backend must be running THIS app (it exposes /wisp/ and /api/*)
 *
 * Example (uncomment and edit once you have more deployments):
 */
window.PROXY_BACKENDS = [
	// { label: "Singapore", url: "https://free-browser-proxy.onrender.com" },
	// { label: "Frankfurt", url: "https://free-browser-proxy-eu.onrender.com" },
	// { label: "Ohio (US)", url: "https://free-browser-proxy-us.onrender.com" },
];
