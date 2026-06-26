import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

// Wisp Configuration: Refer to the documentation at https://www.npmjs.com/package/@mercuryworkshop/wisp-js

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	hostname_blacklist: [/example\.com/],
	dns_servers: ["1.1.1.3", "1.0.0.3"],
});

// ---------------------------------------------------------------------------
// Optional access gate. Set ACCESS_PIN in the environment to require a PIN
// before anyone can use the proxy (protects bandwidth + reduces the abuse that
// gets free hosts suspended). Leave it unset and the site stays fully open.
const ACCESS_PIN = (process.env.ACCESS_PIN || "").trim();
const GATE_ON = ACCESS_PIN.length > 0;
const COOKIE_NAME = "fb_access";
const accessToken = GATE_ON
	? createHash("sha256")
			.update(`fb:${ACCESS_PIN}:${process.env.COOKIE_SECRET || ACCESS_PIN}`)
			.digest("hex")
	: "";
if (GATE_ON && ACCESS_PIN.length < 8)
	console.warn(
		"[FreeBrowse] ACCESS_PIN is short — use a long, random value (10+ chars) to resist brute force."
	);

function parseCookies(header) {
	const out = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const i = part.indexOf("=");
		if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
}
function hasAccess(req) {
	if (!GATE_ON) return true;
	return parseCookies(req.headers.cookie)[COOKIE_NAME] === accessToken;
}

// Tiny in-memory fixed-window rate limiter (per instance).
const rlBuckets = new Map();
function rateLimit(key, max, windowMs) {
	const now = Date.now();
	let e = rlBuckets.get(key);
	if (!e || now > e.reset) {
		e = { n: 0, reset: now + windowMs };
		rlBuckets.set(key, e);
	}
	e.n++;
	if (rlBuckets.size > 5000)
		for (const [k, v] of rlBuckets) if (now > v.reset) rlBuckets.delete(k);
	return e.n <= max;
}
function clientIp(req) {
	const xff = req.headers["x-forwarded-for"];
	if (xff) {
		// Use the LAST hop (added by the trusted edge proxy); the leftmost value
		// is client-supplied and therefore spoofable.
		const parts = String(xff).split(",");
		return parts[parts.length - 1].trim();
	}
	return req.ip || "unknown";
}

const fastify = Fastify({
	serverFactory: (handler) => {
		return createServer()
			.on("request", (req, res) => {
				res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
				res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (GATE_ON && !hasAccess(req)) return socket.end();
				if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
				else socket.end();
			});
	},
});

fastify.register(fastifyStatic, {
	root: publicPath,
	decorateReply: true,
});

fastify.register(fastifyStatic, {
	root: scramjetPath,
	prefix: "/scram/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: libcurlPath,
	prefix: "/libcurl/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: baremuxPath,
	prefix: "/baremux/",
	decorateReply: false,
});

// ---------------------------------------------------------------------------
// Dashboard / measurement API
// Powers the on-site meter board (latency, link speed, egress country/IP) and
// lets the client probe OTHER backends, so CORS + CORP are opened on /api/*.
// A human-friendly name for this backend (set REGION_LABEL per deployment).
const REGION_LABEL =
	process.env.REGION_LABEL || process.env.RENDER_REGION || "this server";

// Allow the speed test to receive a binary upload body without erroring.
// Custom parsers bypass Fastify's default bodyLimit, so cap it manually.
const UPLOAD_LIMIT = 1_500_000;
fastify.addContentTypeParser(
	"application/octet-stream",
	(req, payload, done) => {
		let size = 0;
		let finished = false;
		const finish = (err, val) => {
			if (finished) return;
			finished = true;
			done(err, val);
		};
		payload.on("data", (chunk) => {
			size += chunk.length;
			if (size > UPLOAD_LIMIT) {
				payload.destroy();
				finish(new Error("payload too large"));
			}
		});
		payload.on("end", () => finish(null, { size }));
		payload.on("error", (err) => finish(err));
	}
);

// Rate limiting + optional access gate (runs before every route).
fastify.addHook("onRequest", (req, reply, done) => {
	// CORS preflights carry no data/cookies — let them reach the OPTIONS route.
	if (req.method === "OPTIONS") return done();

	const path = req.url.split("?")[0];

	if (path.startsWith("/api/")) {
		if (!rateLimit("api:" + clientIp(req), 80, 10000))
			return reply.code(429).send({ error: "rate limited" });
	}

	if (GATE_ON && !hasAccess(req)) {
		// Unlock page + low-sensitivity, rate-limited measurement endpoints stay
		// open, so cross-backend latency/geo probing still works against gated
		// peers. The actual proxy tunnel (/wisp/) and pages remain gated.
		if (
			path === "/unlock" ||
			path === "/favicon.ico" ||
			path === "/robots.txt" ||
			path === "/api/ping" ||
			path === "/api/ipinfo"
		)
			return done();
		if ((req.headers.accept || "").includes("text/html"))
			return reply.code(302).header("location", "/unlock").send();
		return reply.code(401).send({ error: "locked" });
	}
	done();
});

// CORS / CORP for all /api/* responses (needed for cross-backend probing under COEP).
fastify.addHook("onRequest", (req, reply, done) => {
	if (req.url.startsWith("/api/")) {
		reply.header("Access-Control-Allow-Origin", "*");
		reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
		reply.header("Access-Control-Allow-Headers", "*");
		reply.header("Cross-Origin-Resource-Policy", "cross-origin");
		reply.header("Cache-Control", "no-store");
	}
	done();
});

fastify.options("/api/*", (req, reply) => reply.code(204).send());

// Latency probe — tiny, cheap; the client times the round-trip.
fastify.get("/api/ping", (req, reply) => {
	reply.send({ ok: true, t: Date.now(), region: REGION_LABEL });
});

// Egress IP + geolocation (what target sites see). Cached for 10 min.
let ipInfoCache = null;
let ipInfoCacheAt = 0;
fastify.get("/api/ipinfo", async (req, reply) => {
	const now = Date.now();
	if (ipInfoCache && now - ipInfoCacheAt < 10 * 60 * 1000) {
		return reply.send(ipInfoCache);
	}
	try {
		const r = await fetch(
			"http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,isp,query",
			{ signal: AbortSignal.timeout(5000) }
		);
		const d = await r.json();
		ipInfoCache = {
			region: REGION_LABEL,
			ip: d.query || null,
			country: d.country || null,
			countryCode: d.countryCode || null,
			city: d.city || null,
			area: d.regionName || null,
			isp: d.isp || null,
		};
		ipInfoCacheAt = now;
		return reply.send(ipInfoCache);
	} catch {
		return reply
			.code(502)
			.send({ region: REGION_LABEL, error: "ipinfo unavailable" });
	}
});

// Download speed test — slices a pre-generated incompressible pad (cap 2 MB).
// One shared buffer avoids per-request CPU and blunts request-flood abuse.
const SPEEDTEST_MAX = 2_000_000;
const speedtestPad = randomBytes(SPEEDTEST_MAX);
fastify.get("/api/speedtest", (req, reply) => {
	let bytes = parseInt(req.query?.bytes ?? "1500000", 10);
	if (!Number.isFinite(bytes) || bytes <= 0) bytes = 1500000;
	bytes = Math.min(bytes, SPEEDTEST_MAX);
	reply
		.header("Content-Type", "application/octet-stream")
		.send(speedtestPad.subarray(0, bytes));
});

// Upload speed test — drains the body and reports the byte count.
fastify.post("/api/speedtest", (req, reply) => {
	const bytes =
		(req.body && req.body.size) ||
		Number(req.headers["content-length"] || 0);
	reply.send({ ok: true, bytes });
});

// Access gate pages.
fastify.get("/unlock", (req, reply) => {
	if (!GATE_ON) return reply.code(302).header("location", "/").send();
	return reply.type("text/html").sendFile("unlock.html");
});
fastify.post("/unlock", async (req, reply) => {
	if (!GATE_ON) return reply.send({ ok: true });
	// Per-IP AND global caps, so a spoofed X-Forwarded-For can't lift the limit.
	if (
		!rateLimit("unlock:" + clientIp(req), 6, 60000) ||
		!rateLimit("unlock:global", 30, 60000)
	)
		return reply.code(429).send({ ok: false, error: "too many attempts" });
	const pin = req.body && typeof req.body.pin === "string" ? req.body.pin : "";
	const submitted = createHash("sha256")
		.update(`fb:${pin}:${process.env.COOKIE_SECRET || ACCESS_PIN}`)
		.digest("hex");
	const ok =
		submitted.length === accessToken.length &&
		timingSafeEqual(Buffer.from(submitted), Buffer.from(accessToken));
	if (ok) {
		// Only mark the cookie Secure when actually served over HTTPS, otherwise
		// the browser silently drops it and the unlock loops forever over HTTP.
		const secure =
			(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
		reply.header(
			"Set-Cookie",
			`${COOKIE_NAME}=${accessToken}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=2592000`
		);
		return reply.send({ ok: true });
	}
	await new Promise((r) => setTimeout(r, 300)); // slow brute force
	return reply.code(401).send({ ok: false });
});

// Keep the proxy out of search engines.
fastify.get("/robots.txt", (req, reply) => {
	reply.type("text/plain").send("User-agent: *\nDisallow: /\n");
});

fastify.setNotFoundHandler((res, reply) => {
	return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
	const address = fastify.server.address();

	// by default we are listening on 0.0.0.0 (every interface)
	// we just need to list a few
	console.log("Listening on:");
	console.log(`\thttp://localhost:${address.port}`);
	console.log(`\thttp://${hostname()}:${address.port}`);
	console.log(
		`\thttp://${
			address.family === "IPv6" ? `[${address.address}]` : address.address
		}:${address.port}`
	);
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function shutdown(signal) {
	console.log(`${signal} received: closing HTTP server`);
	const force = setTimeout(() => process.exit(1), 10000);
	force.unref();
	try {
		await fastify.close();
	} catch (err) {
		console.error("Error during shutdown", err);
	} finally {
		process.exit(0);
	}
}

let port = parseInt(process.env.PORT || "");

if (isNaN(port)) port = 8080;

fastify.listen({ port, host: "0.0.0.0" }).catch((err) => {
	fastify.log.error(err);
	console.error(err);
	process.exit(1);
});
