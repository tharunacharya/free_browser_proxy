"use strict";
/**
 * FreeBrowse homepage helpers: theme, search-engine picker, bookmarks, history.
 * All state is local to the browser (localStorage) — nothing is sent anywhere.
 * Exposes window.FBHome.addHistory(url) for index.js to call on navigation.
 */
(function () {
	const FBHome = (window.FBHome = window.FBHome || {});
	const $ = (id) => document.getElementById(id);
	const load = (k, d) => {
		try {
			return JSON.parse(localStorage.getItem(k)) ?? d;
		} catch {
			return d;
		}
	};
	const save = (k, v) => {
		try {
			localStorage.setItem(k, JSON.stringify(v));
		} catch {}
	};

	const ENGINES = {
		duckduckgo: { label: "DuckDuckGo", tmpl: "https://duckduckgo.com/?q=%s" },
		google: { label: "Google", tmpl: "https://www.google.com/search?q=%s" },
		bing: { label: "Bing", tmpl: "https://www.bing.com/search?q=%s" },
		brave: { label: "Brave", tmpl: "https://search.brave.com/search?q=%s" },
		startpage: {
			label: "Startpage",
			tmpl: "https://www.startpage.com/sp/search?query=%s",
		},
	};

	// ---- theme ----------------------------------------------------------------
	function applyTheme(t) {
		document.documentElement.dataset.theme = t;
		const btn = $("fb-theme");
		if (btn) btn.textContent = t === "light" ? "🌙" : "☀️";
	}
	function initTheme() {
		let t = load("fb-theme", "dark");
		applyTheme(t);
		const btn = $("fb-theme");
		if (btn)
			btn.addEventListener("click", () => {
				t = document.documentElement.dataset.theme === "light" ? "dark" : "light";
				applyTheme(t);
				save("fb-theme", t);
			});
	}

	// ---- search engine --------------------------------------------------------
	function initEngine() {
		const sel = $("fb-engine");
		const hidden = $("sj-search-engine");
		if (!sel || !hidden) return;
		sel.innerHTML = "";
		for (const [key, e] of Object.entries(ENGINES)) {
			const o = document.createElement("option");
			o.value = key;
			o.textContent = e.label;
			sel.appendChild(o);
		}
		const cur = load("fb-engine", "duckduckgo");
		sel.value = ENGINES[cur] ? cur : "duckduckgo";
		hidden.value = ENGINES[sel.value].tmpl;
		sel.addEventListener("change", () => {
			hidden.value = ENGINES[sel.value].tmpl;
			save("fb-engine", sel.value);
		});
	}

	// ---- opening a site through the proxy -------------------------------------
	function openUrl(url) {
		const addr = $("sj-address");
		const form = $("sj-form");
		if (!addr || !form) return;
		addr.value = url;
		if (form.requestSubmit) form.requestSubmit();
		else form.dispatchEvent(new Event("submit", { cancelable: true }));
	}

	// ---- bookmarks ------------------------------------------------------------
	function renderBookmarks() {
		const box = $("fb-bookmarks");
		if (!box) return;
		const items = load("fb-bookmarks", []);
		box.innerHTML = "";
		if (!items.length) {
			box.innerHTML = `<p class="fb-empty">No bookmarks yet — type a site and hit ★ Save.</p>`;
			return;
		}
		items.forEach((b, i) => {
			const tile = document.createElement("div");
			tile.className = "fb-tile";
			tile.innerHTML =
				`<span class="fb-tile-label"></span>` +
				`<button class="fb-tile-x" title="Remove">×</button>`;
			tile.querySelector(".fb-tile-label").textContent = b.label || b.url;
			tile.querySelector(".fb-tile-label").title = b.url;
			tile.querySelector(".fb-tile-label").addEventListener("click", () =>
				openUrl(b.url)
			);
			tile.querySelector(".fb-tile-x").addEventListener("click", (e) => {
				e.stopPropagation();
				const arr = load("fb-bookmarks", []);
				arr.splice(i, 1);
				save("fb-bookmarks", arr);
				renderBookmarks();
			});
			box.appendChild(tile);
		});
	}
	function initBookmarks() {
		const btn = $("fb-save");
		if (btn)
			btn.addEventListener("click", () => {
				const addr = $("sj-address");
				const url = (addr && addr.value || "").trim();
				if (!url) return;
				const label = url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
				const arr = load("fb-bookmarks", []);
				if (!arr.some((b) => b.url === url)) {
					arr.push({ label, url });
					save("fb-bookmarks", arr);
					renderBookmarks();
				}
			});
		renderBookmarks();
	}

	// ---- history --------------------------------------------------------------
	function renderHistory() {
		const box = $("fb-history");
		if (!box) return;
		const items = load("fb-history", []);
		box.innerHTML = "";
		items.forEach((url) => {
			const chip = document.createElement("button");
			chip.className = "fb-chip";
			chip.textContent = url.replace(/^https?:\/\//, "").slice(0, 48);
			chip.title = url;
			chip.addEventListener("click", () => openUrl(url));
			box.appendChild(chip);
		});
		const clear = $("fb-history-clear");
		if (clear) clear.style.display = items.length ? "" : "none";
	}
	FBHome.addHistory = (url) => {
		if (!url || !/^https?:\/\//.test(url)) return;
		let arr = load("fb-history", []).filter((u) => u !== url);
		arr.unshift(url);
		arr = arr.slice(0, 8);
		save("fb-history", arr);
		renderHistory();
	};
	function initHistory() {
		const clear = $("fb-history-clear");
		if (clear)
			clear.addEventListener("click", () => {
				save("fb-history", []);
				renderHistory();
			});
		renderHistory();
	}

	function start() {
		initTheme();
		initEngine();
		initBookmarks();
		initHistory();
	}
	if (document.readyState === "loading")
		document.addEventListener("DOMContentLoaded", start);
	else start();
})();
