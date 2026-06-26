import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
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

const fastify = Fastify({
	serverFactory: (handler) => {
		return createServer()
			.on("request", (req, res) => {
				res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
				res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
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
