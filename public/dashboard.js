"use strict";
/**
 * FreeBrowse meter board + multi-backend switcher.
 *
 * - Builds the list of backends (this site + anything in PROXY_BACKENDS).
 * - Pings each one and shows latency; in "Auto" mode it keeps the fastest active.
 * - Measures link speed (down/up) to the active backend.
 * - Shows the egress IP + country/city/ISP that target sites actually see.
 *
 * It cooperates with index.js via a shared window.ProxyNet:
 *   index.js provides  ProxyNet.setTransportTo(wispUrl)
 *   this file provides  ProxyNet.getActiveBaseUrl() / getActiveWispUrl()
 */
(function () {
	const ProxyNet = (window.ProxyNet = window.ProxyNet || {});

	// ---- backend list ---------------------------------------------------------
	const normBase = (u) => String(u).replace(/\/+$/, "");
	const here = { label: "This server", url: normBase(location.origin), here: true };
	const extra = (Array.isArray(window.PROXY_BACKENDS) ? window.PROXY_BACKENDS : [])
		.filter((b) => b && b.url)
		.map((b) => ({ label: b.label || b.url, url: normBase(b.url) }));
	// de-dupe (don't list the current origin twice)
	const seen = new Set([here.url]);
	const backends = [here];
	for (const b of extra) if (!seen.has(b.url)) (seen.add(b.url), backends.push(b));

	// ---- state ----------------------------------------------------------------
	const state = {
		active: 0,
		mode: "auto", // "auto" | "manual"
		latency: backends.map(() => null), // ms
		geo: backends.map(() => null),
		geoLoading: backends.map(() => false),
		speed: { down: null, up: null, at: 0 },
		testing: false,
	};

	// ---- helpers --------------------------------------------------------------
	function wispFromBase(base) {
		try {
			const u = new URL(base);
			const scheme = u.protocol === "https:" ? "wss" : "ws";
			return `${scheme}://${u.host}/wisp/`;
		} catch {
			return null;
		}
	}
	function flag(cc) {
		if (!cc || cc.length !== 2) return "🌐";
		return String.fromCodePoint(
			...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))
		);
	}
	const fmtMs = (v) => (v == null ? "—" : Math.round(v) + " ms");
	const fmtMbps = (v) => (v == null ? "—" : (v < 10 ? v.toFixed(1) : Math.round(v)) + " Mbps");
	const latClass = (v) =>
		v == null ? "bad" : v < 120 ? "good" : v < 300 ? "ok" : "bad";

	ProxyNet.getActiveBaseUrl = () => backends[state.active].url;
	ProxyNet.getActiveWispUrl = () => wispFromBase(backends[state.active].url);

	// ---- measurement ----------------------------------------------------------
	async function pingOnce(base) {
		const t0 = performance.now();
		try {
			const r = await fetch(`${base}/api/ping?_=${t0}`, {
				cache: "no-store",
				signal: AbortSignal.timeout(4000),
			});
			if (!r.ok) return null;
			await r.json();
			return performance.now() - t0;
		} catch {
			return null;
		}
	}
	async function ping(base) {
		const a = await pingOnce(base);
		const b = await pingOnce(base);
		const vals = [a, b].filter((x) => x != null);
		return vals.length ? Math.min(...vals) : null;
	}

	let booted = false;
	async function probeAll() {
		await Promise.all(
			backends.map(async (b, i) => {
				state.latency[i] = await ping(b.url);
			})
		);
		render();
		if (!booted) {
			// First probe: activate the fastest exactly once (runs geo + speed).
			booted = true;
			const f = fastestIndex();
			setActive(f === -1 ? 0 : f, { silent: false });
		} else if (state.mode === "auto") {
			maybeAutoSwitch();
		}
	}

	function fastestIndex() {
		let best = -1;
		for (let i = 0; i < backends.length; i++) {
			if (state.latency[i] == null) continue;
			if (best === -1 || state.latency[i] < state.latency[best]) best = i;
		}
		return best;
	}

	function maybeAutoSwitch() {
		const f = fastestIndex();
		if (f === -1 || f === state.active) return;
		const cur = state.latency[state.active];
		// hysteresis: only steal if clearly (>=25%) faster, to avoid flapping
		if (cur == null || state.latency[f] <= cur * 0.75) {
			setActive(f, { silent: true });
		}
	}

	async function fetchGeo(i) {
		if (state.geoLoading[i]) return; // avoid duplicate in-flight /api/ipinfo
		state.geoLoading[i] = true;
		try {
			const r = await fetch(`${backends[i].url}/api/ipinfo`, {
				cache: "no-store",
				signal: AbortSignal.timeout(6000),
			});
			state.geo[i] = await r.json();
		} catch {
			state.geo[i] = null;
		} finally {
			state.geoLoading[i] = false;
		}
		render();
	}

	async function speedTest(base) {
		if (state.testing) return;
		state.testing = true;
		render();
		// download ~1.5 MB
		try {
			const N = 1_500_000;
			const t0 = performance.now();
			const r = await fetch(`${base}/api/speedtest?bytes=${N}&_=${t0}`, {
				cache: "no-store",
				signal: AbortSignal.timeout(20000),
			});
			const buf = await r.arrayBuffer();
			const secs = (performance.now() - t0) / 1000;
			state.speed.down = secs > 0 ? (buf.byteLength * 8) / secs / 1e6 : null;
		} catch {
			state.speed.down = null;
		}
		// upload ~0.75 MB
		try {
			const M = 750_000;
			const payload = new Blob([new Uint8Array(M)], {
				type: "application/octet-stream",
			});
			const t0 = performance.now();
			await fetch(`${base}/api/speedtest`, {
				method: "POST",
				body: payload,
				cache: "no-store",
				signal: AbortSignal.timeout(20000),
			});
			const secs = (performance.now() - t0) / 1000;
			state.speed.up = secs > 0 ? (M * 8) / secs / 1e6 : null;
		} catch {
			state.speed.up = null;
		}
		state.speed.at = Date.now();
		state.testing = false;
		render();
	}

	function setActive(i, opts = {}) {
		state.active = i;
		// re-point the proxy transport so the next page load uses this backend
		if (ProxyNet.setTransportTo) {
			Promise.resolve(ProxyNet.setTransportTo(ProxyNet.getActiveWispUrl())).catch(
				() => {}
			);
		}
		render();
		if (!state.geo[i]) fetchGeo(i);
		// Run a speed test on explicit switches; on silent auto-switches only if
		// the last test is stale (>30s) — keeps free-tier bandwidth use low.
		if (!opts.silent || Date.now() - state.speed.at > 30000) {
			speedTest(backends[i].url);
		}
	}

	// ---- UI --------------------------------------------------------------------
	const root = document.createElement("div");
	root.id = "fb-dash";
	root.innerHTML = `
<style>
 #fb-dash{position:fixed;right:16px;bottom:16px;z-index:2147483000;
   font-family:"Segoe UI",system-ui,sans-serif;color:#e8ecf6}
 #fb-badge{display:flex;align-items:center;gap:10px;cursor:pointer;
   background:rgba(13,18,38,.92);border:1px solid rgba(255,255,255,.14);
   border-radius:999px;padding:8px 14px;box-shadow:0 10px 30px rgba(0,0,0,.45);
   backdrop-filter:blur(8px);font-size:13px;white-space:nowrap}
 #fb-badge .pulse{width:9px;height:9px;border-radius:50%;background:#3ddc84;
   box-shadow:0 0 10px #3ddc84}
 #fb-badge .pulse.bad{background:#ff7b7b;box-shadow:0 0 10px #ff7b7b}
 #fb-badge .pulse.ok{background:#ffcf5c;box-shadow:0 0 10px #ffcf5c}
 #fb-badge b{font-weight:600}
 #fb-badge .sep{opacity:.35}
 #fb-panel{display:none;width:320px;margin-top:10px;
   background:rgba(13,18,38,.97);border:1px solid rgba(255,255,255,.14);
   border-radius:16px;padding:14px;box-shadow:0 20px 50px rgba(0,0,0,.55);
   backdrop-filter:blur(10px)}
 #fb-dash.open #fb-panel{display:block}
 #fb-panel h4{margin:2px 0 10px;font-size:13px;letter-spacing:.04em;
   text-transform:uppercase;color:#9aa6c2}
 .fb-row{display:flex;justify-content:space-between;align-items:center;
   font-size:13px;margin:6px 0}
 .fb-meters{display:flex;gap:8px;margin:8px 0 12px}
 .fb-meter{flex:1;background:rgba(255,255,255,.05);border-radius:10px;padding:8px 10px}
 .fb-meter .k{font-size:11px;color:#9aa6c2}
 .fb-meter .v{font-size:17px;font-weight:700}
 .fb-bk{display:flex;justify-content:space-between;align-items:center;
   padding:7px 9px;border-radius:9px;cursor:pointer;border:1px solid transparent}
 .fb-bk:hover{background:rgba(255,255,255,.05)}
 .fb-bk.active{background:rgba(110,168,254,.15);border-color:rgba(110,168,254,.5)}
 .fb-bk .lat{font-variant-numeric:tabular-nums;font-size:12px}
 .lat.good{color:#3ddc84}.lat.ok{color:#ffcf5c}.lat.bad{color:#ff7b7b}
 .fb-geo{font-size:12px;color:#c8d2ee;background:rgba(255,255,255,.04);
   border-radius:10px;padding:9px 11px;margin:4px 0 10px;line-height:1.5}
 .fb-geo .cc{font-size:15px}
 .fb-actions{display:flex;gap:8px;margin-top:6px}
 .fb-btn{flex:1;border:0;border-radius:9px;padding:8px;font-size:12px;font-weight:600;
   cursor:pointer;background:rgba(255,255,255,.08);color:#e8ecf6}
 .fb-btn:hover{background:rgba(255,255,255,.14)}
 .fb-btn.pri{background:linear-gradient(135deg,#6ea8fe,#8b5cf6);color:#0b1020}
 .fb-mode{font-size:11px;color:#9aa6c2}
 .fb-mode b{color:#6ea8fe}
 .fb-x{cursor:pointer;color:#9aa6c2;font-size:14px}
 @media (max-width:600px){#fb-dash{right:8px;bottom:8px}#fb-panel{width:calc(100vw - 24px)}}
</style>
<div id="fb-badge" title="Connection meter — click for details">
  <span class="pulse" id="fb-pulse"></span>
  <span id="fb-badge-region">…</span>
  <span class="sep">·</span>
  <b id="fb-badge-lat">—</b>
  <span class="sep">·</span>
  <span>↓ <b id="fb-badge-down">—</b></span>
</div>
<div id="fb-panel">
  <div class="fb-row" style="margin-bottom:8px">
    <h4 style="margin:0">Connection</h4>
    <span class="fb-x" id="fb-close">✕</span>
  </div>
  <div class="fb-meters">
    <div class="fb-meter"><div class="k">Download</div><div class="v" id="fb-down">—</div></div>
    <div class="fb-meter"><div class="k">Upload</div><div class="v" id="fb-up">—</div></div>
    <div class="fb-meter"><div class="k">Latency</div><div class="v" id="fb-lat">—</div></div>
  </div>
  <div class="fb-geo" id="fb-geo">Locating exit node…</div>
  <h4>Backends <span class="fb-mode" id="fb-mode"></span></h4>
  <div id="fb-list"></div>
  <div class="fb-actions">
    <button class="fb-btn pri" id="fb-test">Test speed</button>
    <button class="fb-btn" id="fb-auto">Auto: ON</button>
  </div>
</div>`;
	function mount() {
		document.body.appendChild(root);
		root.querySelector("#fb-badge").onclick = () => root.classList.toggle("open");
		root.querySelector("#fb-close").onclick = (e) => {
			e.stopPropagation();
			root.classList.remove("open");
		};
		root.querySelector("#fb-test").onclick = () =>
			speedTest(backends[state.active].url);
		root.querySelector("#fb-auto").onclick = () => {
			state.mode = state.mode === "auto" ? "manual" : "auto";
			if (state.mode === "auto") maybeAutoSwitch();
			render();
		};
	}

	function render() {
		if (!root.isConnected) return;
		const a = state.active;
		const lat = state.latency[a];
		root.querySelector("#fb-pulse").className = "pulse " + latClass(lat);
		root.querySelector("#fb-badge-region").textContent = backends[a].label;
		root.querySelector("#fb-badge-lat").textContent = fmtMs(lat);
		root.querySelector("#fb-badge-down").textContent =
			state.testing ? "…" : fmtMbps(state.speed.down);
		root.querySelector("#fb-down").textContent =
			state.testing ? "testing…" : fmtMbps(state.speed.down);
		root.querySelector("#fb-up").textContent = fmtMbps(state.speed.up);
		root.querySelector("#fb-lat").textContent = fmtMs(lat);

		const g = state.geo[a];
		root.querySelector("#fb-geo").innerHTML = g
			? `<span class="cc">${flag(g.countryCode)}</span> <b>${g.country || "Unknown"}</b>` +
			  (g.city ? ` · ${g.city}` : "") +
			  `<br>Exit IP: <b>${g.ip || "—"}</b>` +
			  (g.isp ? `<br>Network: ${g.isp}` : "")
			: "Exit node location unavailable.";

		root.querySelector("#fb-mode").innerHTML =
			state.mode === "auto" ? "· <b>auto-fastest</b>" : "· manual";
		root.querySelector("#fb-auto").textContent =
			"Auto: " + (state.mode === "auto" ? "ON" : "OFF");

		const list = root.querySelector("#fb-list");
		list.innerHTML = "";
		backends.forEach((b, i) => {
			const row = document.createElement("div");
			row.className = "fb-bk" + (i === a ? " active" : "");
			row.innerHTML =
				`<span>${b.label}</span>` +
				`<span class="lat ${latClass(state.latency[i])}">${fmtMs(state.latency[i])}</span>`;
			row.onclick = () => {
				state.mode = "manual";
				setActive(i);
				// Apply immediately to the page that's open (if any).
				if (ProxyNet.reloadActiveFrame) ProxyNet.reloadActiveFrame();
			};
			list.appendChild(row);
		});
	}

	// ---- boot ------------------------------------------------------------------
	function start() {
		mount();
		render();
		probeAll(); // first probe activates the fastest backend
		setInterval(probeAll, 8000);
	}
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", start);
	} else {
		start();
	}
})();
