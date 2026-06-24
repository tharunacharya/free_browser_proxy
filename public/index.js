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
	document.body.appendChild(frame.frame);
	ensureCloseButton();
	currentFrame = frame;
	currentUrl = url;
	frame.go(url);
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
