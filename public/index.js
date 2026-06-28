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

// ---- proxied-page frame lifecycle ----------------------------------------
let currentFrame = null;
let currentUrl = null;

function ensureCloseButton() {
	if (document.getElementById("sj-close")) return;
	const btn = document.createElement("button");
	btn.id = "sj-close";
	btn.type = "button";
	btn.textContent = "✕ Close";
	btn.title = "Close the proxied page";
	btn.addEventListener("click", closeFrame);
	document.body.appendChild(btn);
}

function closeFrame() {
	document.getElementById("sj-frame")?.remove();
	document.getElementById("sj-close")?.remove();
	currentFrame = null;
	currentUrl = null;
}

function openFrame(url) {
	// Drop any previous frame so we never stack duplicate-id iframes.
	document.getElementById("sj-frame")?.remove();
	const frame = scramjet.createFrame();
	frame.frame.id = "sj-frame";
	// Helps the nested frame stay cross-origin isolated (needed for the engine).
	frame.frame.setAttribute("allow", "cross-origin-isolated");
	document.body.appendChild(frame.frame);
	ensureCloseButton();
	currentFrame = frame;
	currentUrl = url;

	// Watchdog: on mobile the frame can silently render blank (Scramjet's engine
	// failing). If it never reports a navigation, remove the blank frame and
	// explain why, instead of leaving a white screen.
	let progressed = false;
	const mark = () => {
		progressed = true;
	};
	// Any sign of life clears the watchdog, so we never close a working frame.
	frame.addEventListener("urlchange", mark);
	frame.frame.addEventListener("load", mark);
	frame.go(url);
	setTimeout(() => {
		if (!progressed && currentFrame === frame) {
			closeFrame();
			error.textContent = "The page didn't load through the proxy on this device.";
			errorCode.textContent =
				"No navigation after 12s — usually a mobile limitation: Scramjet's engine " +
				"fails silently on many phone browsers (a known upstream bug). It works on " +
				"desktop Chrome/Edge. Add ?debug=1 to the URL to see this device's capabilities.";
		}
	}, 12000);
}

// Called by the dashboard on an explicit (manual) backend switch: re-point the
// tunnel and reload the page that's open so the new backend actually applies.
ProxyNet.reloadActiveFrame = async () => {
	if (!currentFrame || !currentUrl) return;
	await setTransportTo(
		ProxyNet.getActiveWispUrl ? ProxyNet.getActiveWispUrl() : defaultWispUrl()
	);
	currentFrame.go(currentUrl);
};

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	error.textContent = "";
	errorCode.textContent = "";

	// Mobile reality check: the proxied frame needs cross-origin isolation +
	// SharedArrayBuffer (Scramjet's WASM engine). Many phone browsers (low-RAM
	// Android, in-app browsers, older iOS) don't provide them, so the frame
	// would render blank — say why instead of showing a white screen.
	if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
		error.textContent = "This device can't run the proxy engine.";
		errorCode.textContent =
			"crossOriginIsolated=" + self.crossOriginIsolated +
			", SharedArrayBuffer=" + (typeof SharedArrayBuffer !== "undefined") +
			". Both are required — works on desktop Chrome/Edge, but many phones " +
			"disable them. This is a limitation of the proxy engine, not your setup.";
		return;
	}

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
