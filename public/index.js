"use strict";
/**
 * @type {HTMLFormElement}
 */
const form = document.getElementById("sj-form");
/**
 * @type {HTMLInputElement}
 */
const address = document.getElementById("sj-address");
/**
 * @type {HTMLInputElement}
 */
const searchEngine = document.getElementById("sj-search-engine");
/**
 * @type {HTMLParagraphElement}
 */
const error = document.getElementById("sj-error");
/**
 * @type {HTMLPreElement}
 */
const errorCode = document.getElementById("sj-error-code");

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
	files: {
		wasm: "/scram/scramjet.wasm.wasm",
		all: "/scram/scramjet.all.js",
		sync: "/scram/scramjet.sync.js",
	},
});

scramjet.init();

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

// Shared with dashboard.js. The dashboard decides WHICH backend is active and
// calls setTransportTo() to re-point the tunnel; here we own the BareMux
// connection and apply it. Re-applying only when the target changes.
const ProxyNet = (window.ProxyNet = window.ProxyNet || {});
let appliedWisp = null;

function defaultWispUrl() {
	return (
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/"
	);
}

async function setTransportTo(wispUrl) {
	const target = wispUrl || defaultWispUrl();
	if (appliedWisp === target) return;
	await connection.setTransport("/libcurl/index.mjs", [{ websocket: target }]);
	appliedWisp = target;
}
ProxyNet.setTransportTo = setTransportTo;

// ---- proxied-page frame lifecycle + navigation toolbar -------------------
let currentFrame = null;
let currentUrl = null;
let spinnerTimer = null;

function showSpinner() {
	let s = document.getElementById("sj-spinner");
	if (!s) {
		s = document.createElement("div");
		s.id = "sj-spinner";
		s.innerHTML = '<div class="sj-ring"></div>';
		document.body.appendChild(s);
	}
	s.style.display = "flex";
	clearTimeout(spinnerTimer);
	spinnerTimer = setTimeout(hideSpinner, 15000); // never hang forever
}
function hideSpinner() {
	clearTimeout(spinnerTimer);
	const s = document.getElementById("sj-spinner");
	if (s) s.style.display = "none";
}

function setBarUrl(u) {
	const el = document.getElementById("sj-bar-url");
	if (el && document.activeElement !== el) el.value = u || "";
}

// back/forward aren't formally documented on the frame, so try the method then
// fall back to the proxied document's own history; either may be a no-op.
function tryNav(dir) {
	if (!currentFrame) return;
	try {
		if (typeof currentFrame[dir] === "function") currentFrame[dir]();
		else currentFrame.frame.contentWindow?.history?.[dir]();
		showSpinner();
	} catch {}
}

function ensureBar() {
	if (document.getElementById("sj-bar")) return;
	const bar = document.createElement("div");
	bar.id = "sj-bar";
	bar.innerHTML =
		'<button class="sj-btn" data-act="home" title="Home">⌂</button>' +
		'<button class="sj-btn" data-act="back" title="Back">←</button>' +
		'<button class="sj-btn" data-act="forward" title="Forward">→</button>' +
		'<button class="sj-btn" data-act="reload" title="Reload">⟳</button>' +
		'<input id="sj-bar-url" type="text" spellcheck="false" autocomplete="off" />' +
		'<button class="sj-btn close" data-act="close" title="Close">✕</button>';
	document.body.appendChild(bar);

	bar.addEventListener("click", (e) => {
		const act = e.target && e.target.dataset ? e.target.dataset.act : null;
		if (!act) return;
		if (act === "home" || act === "close") closeFrame();
		else if (act === "back") tryNav("back");
		else if (act === "forward") tryNav("forward");
		else if (act === "reload" && currentFrame) {
			try {
				if (typeof currentFrame.reload === "function") currentFrame.reload();
				else currentFrame.go(currentUrl);
				showSpinner();
			} catch {}
		}
	});

	bar.querySelector("#sj-bar-url").addEventListener("keydown", (e) => {
		if (e.key !== "Enter" || !currentFrame) return;
		const u = search(e.target.value, searchEngine.value);
		showSpinner();
		currentFrame.go(u);
	});
}

function openFrame(url) {
	// Drop any previous frame so we never stack duplicate-id iframes.
	document.getElementById("sj-frame")?.remove();
	ensureBar();
	const frame = scramjet.createFrame();
	frame.frame.id = "sj-frame";
	document.body.appendChild(frame.frame);
	currentFrame = frame;
	currentUrl = url;
	setBarUrl(url);
	showSpinner();

	// Track in-frame navigations: update the address bar + history, hide spinner.
	if (typeof frame.addEventListener === "function") {
		frame.addEventListener("urlchange", (e) => {
			if (e && e.url) {
				currentUrl = e.url;
				setBarUrl(e.url);
				if (window.FBHome) window.FBHome.addHistory(e.url);
			}
			hideSpinner();
		});
	}
	frame.frame.addEventListener("load", hideSpinner);

	frame.go(url);
}

function closeFrame() {
	document.getElementById("sj-frame")?.remove();
	document.getElementById("sj-bar")?.remove();
	hideSpinner();
	document.getElementById("sj-spinner")?.remove();
	currentFrame = null;
	currentUrl = null;
}

// Called by the dashboard on an explicit (manual) backend switch: re-point the
// tunnel and reload the page that's open so the new backend actually applies.
ProxyNet.reloadActiveFrame = async () => {
	if (!currentFrame || !currentUrl) return;
	await setTransportTo(
		ProxyNet.getActiveWispUrl ? ProxyNet.getActiveWispUrl() : defaultWispUrl()
	);
	showSpinner();
	currentFrame.go(currentUrl);
};

form.addEventListener("submit", async (event) => {
	event.preventDefault();

	try {
		await registerSW();
	} catch (err) {
		error.textContent = "Failed to register service worker.";
		errorCode.textContent = err.toString();
		throw err;
	}

	const url = search(address.value, searchEngine.value);

	// Tunnel through whichever backend the dashboard has selected (fastest, by
	// default), falling back to this server if the dashboard isn't loaded.
	const wispUrl =
		(ProxyNet.getActiveWispUrl && ProxyNet.getActiveWispUrl()) ||
		defaultWispUrl();
	await setTransportTo(wispUrl);

	openFrame(url);
});
