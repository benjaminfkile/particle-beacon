// The HTTP surface (particle-beacon.md 4): GET /api/health for the platform's
// probe and POST /webhook for the Particle webhook. The webhook checks the
// bearer secret in constant time, reads a bounded body, normalizes it, keeps
// per-node statistics, answers Particle, and only then hands an accepted fix
// to onFix. Every other route is a 404.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BeaconLogger, LocationBody } from "beacon-library";
import { normalize, summarizePayload, type FixMeta, type NormalizeReason } from "./particle/normalize.js";

export interface HealthProbe {
  configLoaded: boolean;
  leaderPolledOnce: boolean;
}

export interface WebhookStats {
  requestsTotal: number;
  accepted: number;
  rejectedAuth: number;
  badBody: number;
  ignoredEvents: number;
  otherDevice: number;
  noPayload: number;
  noLock: number;
  invalid: number;
  duplicates: number;
  lastReceivedAt: string | null;
  lastAcceptedAt: string | null;
  lastReason: string | null;
  lastDeviceId: string | null;
  lastEvent: string | null;
  lastReqId: number | null;
  lastTriggers: string[];
  lastMeta: FixMeta | null;
  lastPayload: unknown;
}

export interface AcceptedFix {
  fix: LocationBody;
  meta: FixMeta;
  key: string;
  receivedAtMs: number;
}

export interface HttpServerOptions {
  port: number;
  secret: string;
  deviceId: string | null;
  probe: () => HealthProbe;
  onFix: (f: AcceptedFix) => void;
  /** A pino logger satisfies this; debug lines are written when the logger has debug. */
  log: BeaconLogger & { debug?(fields: Record<string, unknown>, msg: string): void };
  now?: () => number;
  maxBodyBytes?: number;
}

export interface HttpServer {
  port(): number;
  close(): Promise<void>;
  stats(): WebhookStats;
}

const DEFAULT_MAX_BODY_BYTES = 65_536;
const DRAIN_TIMEOUT_MS = 2000;
const AUTH_WARN_INTERVAL_MS = 60_000;
const BODY_PREVIEW_CHARS = 80;

type ReasonCounter = "ignoredEvents" | "otherDevice" | "noPayload" | "noLock" | "invalid" | "duplicates";

const REASON_COUNTERS: Record<NormalizeReason, ReasonCounter> = {
  "ignored event": "ignoredEvents",
  "other device": "otherDevice",
  "no payload": "noPayload",
  "no gps lock": "noLock",
  "no usable position": "invalid",
  duplicate: "duplicates",
};

function emptyStats(): WebhookStats {
  return {
    requestsTotal: 0,
    accepted: 0,
    rejectedAuth: 0,
    badBody: 0,
    ignoredEvents: 0,
    otherDevice: 0,
    noPayload: 0,
    noLock: 0,
    invalid: 0,
    duplicates: 0,
    lastReceivedAt: null,
    lastAcceptedAt: null,
    lastReason: null,
    lastDeviceId: null,
    lastEvent: null,
    lastReqId: null,
    lastTriggers: [],
    lastMeta: null,
    lastPayload: null,
  };
}

function errorBody(code: string, message: string): object {
  return { code, message, details: null, requestId: "" };
}

/** Writes a JSON answer with no-store; `done` runs once the answer is flushed to the socket. */
function sendJson(
  res: ServerResponse,
  status: number,
  body: object,
  done?: () => void,
  extraHeaders: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text)),
    ...extraHeaders,
  });
  if (done) res.end(text, done);
  else res.end(text);
}

/** True when the header is exactly `Bearer <secret>`, compared in constant time. */
export function bearerMatches(header: string | undefined, secret: string): boolean {
  const given = Buffer.from(header ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  if (given.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(given, expected);
}

/** The payload object of a webhook body in either shape, for the stats summary. */
function payloadOf(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return null;
  const raw = (body as Record<string, unknown>).payload ?? (body as Record<string, unknown>).data;
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * After a 413 the rest of the request body is read and discarded so the
 * client receives the answer before the connection closes (a socket closed
 * with unread bytes resets the connection and the client never sees the
 * status). The drain is bounded: the socket is destroyed once another
 * `maxBytes` arrive or after two seconds, whichever comes first.
 */
function drainThenClose(req: IncomingMessage, maxBytes: number): void {
  const socket = req.socket;
  let drained = 0;
  const finish = () => {
    clearTimeout(timer);
    if (!socket.destroyed) socket.end();
  };
  const timer = setTimeout(() => {
    if (!socket.destroyed) socket.destroy();
  }, DRAIN_TIMEOUT_MS);
  req.on("data", (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > maxBytes && !socket.destroyed) {
      clearTimeout(timer);
      socket.destroy();
    }
  });
  req.on("end", finish);
  req.on("error", finish);
  req.resume();
}

/** Reads the body into a string, or null when it exceeds maxBytes. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

export function startHttpServer(opts: HttpServerOptions): HttpServer {
  const now = opts.now ?? Date.now;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = opts.log;
  const stats = emptyStats();
  let lastKey: string | null = null;
  let lastAuthWarnAt: number | null = null;
  let suppressedAuthWarns = 0;

  function warnBadSecret(): void {
    const t = now();
    if (lastAuthWarnAt !== null && t - lastAuthWarnAt < AUTH_WARN_INTERVAL_MS) {
      suppressedAuthWarns += 1;
      return;
    }
    log.warn(
      { rejectedAuth: stats.rejectedAuth, suppressed: suppressedAuthWarns },
      "webhook rejected: bad secret",
    );
    lastAuthWarnAt = t;
    suppressedAuthWarns = 0;
  }

  function handleHealth(res: ServerResponse): void {
    const p = opts.probe();
    if (p.configLoaded && p.leaderPolledOnce) sendJson(res, 200, { status: "ok" });
    else sendJson(res, 503, errorBody("unavailable", "starting up"));
  }

  function handleJson(res: ServerResponse, body: unknown, receivedAtMs: number): void {
    const result = normalize(body, { receivedAtMs, deviceId: opts.deviceId, lastKey });
    stats.lastReceivedAt = new Date(receivedAtMs).toISOString();

    if (!result.ok) {
      stats[REASON_COUNTERS[result.reason]] += 1;
      stats.lastReason = result.reason;
      stats.lastDeviceId = result.deviceId;
      stats.lastEvent = result.event;
      log.info(
        { reason: result.reason, event: result.event, deviceId: result.deviceId },
        "webhook body not accepted",
      );
      sendJson(res, 200, { ok: true, accepted: false, reason: result.reason });
      return;
    }

    const { fix, meta, key } = result;
    lastKey = key;
    stats.accepted += 1;
    stats.lastReason = null;
    stats.lastDeviceId = meta.deviceId;
    stats.lastEvent = meta.event;
    stats.lastAcceptedAt = stats.lastReceivedAt;
    stats.lastReqId = meta.reqId;
    stats.lastTriggers = [...meta.triggers];
    stats.lastMeta = meta;
    stats.lastPayload = summarizePayload(payloadOf(body));
    log.debug?.(
      {
        deviceId: meta.deviceId,
        reqId: meta.reqId,
        lat: fix.lat,
        lng: fix.lng,
        speedMps: fix.speedMps,
        accuracyM: fix.accuracyM,
      },
      "webhook fix accepted",
    );
    sendJson(res, 200, { ok: true, accepted: true }, () => {
      try {
        opts.onFix({ fix, meta, key, receivedAtMs });
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "onFix threw");
      }
    });
  }

  async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    stats.requestsTotal += 1;

    if (!bearerMatches(req.headers.authorization, opts.secret)) {
      stats.rejectedAuth += 1;
      warnBadSecret();
      sendJson(res, 401, errorBody("unauthenticated", "bad or missing bearer token"));
      return;
    }

    const text = await readBody(req, maxBodyBytes);
    if (text === null) {
      log.warn({ maxBodyBytes }, "webhook body too large");
      sendJson(
        res,
        413,
        errorBody("payload_too_large", `body exceeds ${maxBodyBytes} bytes`),
        () => drainThenClose(req, maxBodyBytes),
        { Connection: "close" },
      );
      return;
    }

    const receivedAtMs = now();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      stats.badBody += 1;
      log.warn({ preview: text.slice(0, BODY_PREVIEW_CHARS) }, "webhook body not JSON");
      sendJson(res, 200, { ok: true, note: "body was not valid JSON; ignored" });
      return;
    }
    handleJson(res, body, receivedAtMs);
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/api/health") {
      handleHealth(res);
    } else if (req.method === "POST" && path === "/webhook") {
      handleWebhook(req, res).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "webhook request failed");
        if (!res.headersSent) sendJson(res, 500, errorBody("internal_error", "internal error"));
        else res.destroy();
      });
    } else {
      sendJson(res, 404, errorBody("not_found", "no such route"));
    }
  });
  server.listen(opts.port);

  return {
    port(): number {
      const addr = server.address();
      return addr !== null && typeof addr === "object" ? (addr as AddressInfo).port : opts.port;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
    },
    stats(): WebhookStats {
      return {
        ...stats,
        lastTriggers: [...stats.lastTriggers],
        lastMeta: stats.lastMeta === null ? null : { ...stats.lastMeta, triggers: [...stats.lastMeta.triggers] },
      };
    },
  };
}
