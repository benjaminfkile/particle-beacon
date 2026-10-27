// Tests for the HTTP surface against a real listener on port 0: the health
// probe, the bearer check, the body limit, the JSON and non-JSON paths, the
// statistics, that the answer reaches the client before onFix runs, and that
// no log line carries the secret or the body.
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { startHttpServer, type AcceptedFix, type HealthProbe, type HttpServer } from "../src/http.js";

type Json = Record<string, any>;

interface LogEntry {
  level: string;
  fields: Record<string, unknown>;
  msg: string;
}

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-10-27T20:30:00.000Z");
const fixtureText = readFileSync(new URL("./fixtures/particle-loc.json", import.meta.url), "utf8");

function fixture(): Json {
  return JSON.parse(fixtureText) as Json;
}

function defaultFormat(body: Json): Json {
  return {
    event: body.event,
    data: JSON.stringify(body.payload),
    coreid: body.deviceId,
    published_at: body.publishedAt,
  };
}

function capturingLogger() {
  const entries: LogEntry[] = [];
  const at = (level: string) => (fields: Record<string, unknown>, msg: string) => {
    entries.push({ level, fields, msg });
  };
  return { entries, log: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } };
}

interface Harness {
  server: HttpServer;
  url: string;
  probe: HealthProbe;
  fixes: AcceptedFix[];
  logs: LogEntry[];
  clock: { ms: number };
}

let servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

function start(onFix?: (f: AcceptedFix) => void): Harness {
  const probe: HealthProbe = { configLoaded: false, leaderPolledOnce: false };
  const fixes: AcceptedFix[] = [];
  const { entries, log } = capturingLogger();
  const clock = { ms: NOW_MS };
  const server = startHttpServer({
    port: 0,
    secret: SECRET,
    deviceId: null,
    probe: () => probe,
    onFix: onFix ?? ((f) => fixes.push(f)),
    log,
    now: () => clock.ms,
  });
  servers.push(server);
  return { server, url: "", probe, fixes, logs: entries, clock };
}

async function listening(h: Harness): Promise<Harness> {
  for (let i = 0; i < 100 && h.server.port() === 0; i++) await new Promise((r) => setTimeout(r, 5));
  h.url = `http://127.0.0.1:${h.server.port()}`;
  return h;
}

async function post(h: Harness, body: string, auth: string | null = `Bearer ${SECRET}`) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth !== null) headers.Authorization = auth;
  const res = await fetch(`${h.url}/webhook`, { method: "POST", headers, body });
  return { res, json: (await res.json()) as Json };
}

describe("GET /api/health", () => {
  it("answers 503 until the config is loaded and the leader polled once, then 200", async () => {
    const h = await listening(start());
    let res = await fetch(`${h.url}/api/health`);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ code: "unavailable", message: "starting up", details: null, requestId: "" });

    h.probe.configLoaded = true;
    res = await fetch(`${h.url}/api/health`);
    expect(res.status).toBe(503);
    await res.body?.cancel();

    h.probe.leaderPolledOnce = true;
    res = await fetch(`${h.url}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /webhook", () => {
  it("accepts only the right bearer and counts every rejection", async () => {
    const h = await listening(start());
    const wrong = [
      `Bearer ${SECRET.slice(0, -1)}x`,
      null,
      `Basic ${SECRET}`,
      "Bearer short",
      `Bearer ${SECRET}extra`,
    ];
    for (const auth of wrong) {
      const { res, json } = await post(h, fixtureText, auth);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(json).toEqual({
        code: "unauthenticated",
        message: "bad or missing bearer token",
        details: null,
        requestId: "",
      });
    }
    expect(h.server.stats().rejectedAuth).toBe(5);
    expect(h.fixes).toHaveLength(0);

    const { res, json } = await post(h, fixtureText);
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, accepted: true });
    expect(h.server.stats().rejectedAuth).toBe(5);
  });

  it("logs a bad secret at warn at most once a minute and counts the suppressed lines", async () => {
    const h = await listening(start());
    for (let i = 0; i < 3; i++) await post(h, "{}", "Bearer nope");
    let warns = h.logs.filter((e) => e.msg === "webhook rejected: bad secret");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.level).toBe("warn");

    h.clock.ms += 60_000;
    await post(h, "{}", "Bearer nope");
    warns = h.logs.filter((e) => e.msg === "webhook rejected: bad secret");
    expect(warns).toHaveLength(2);
    expect(warns[1]?.fields).toMatchObject({ suppressed: 2, rejectedAuth: 4 });
  });

  it("accepts the fixture, hands the fix to onFix, and refuses the same body as a duplicate", async () => {
    const h = await listening(start());
    const first = await post(h, fixtureText);
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get("cache-control")).toBe("no-store");
    expect(first.res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(first.json).toEqual({ ok: true, accepted: true });

    expect(h.fixes).toHaveLength(1);
    const accepted = h.fixes[0]!;
    expect(accepted.key).toBe("e00fce68aaaaaaaaaaaaaaaa:22:1793132969");
    expect(accepted.receivedAtMs).toBe(NOW_MS);
    expect(accepted.fix).toMatchObject({ lat: 46.8721, lng: -113.994, accuracyM: 13 });
    expect(accepted.meta).toMatchObject({ deviceId: "e00fce68aaaaaaaaaaaaaaaa", reqId: 22, towers: 2, wps: 2 });

    const second = await post(h, fixtureText);
    expect(second.json).toEqual({ ok: true, accepted: false, reason: "duplicate" });
    expect(h.fixes).toHaveLength(1);
  });

  it("accepts Particle's default body shape", async () => {
    const h = await listening(start());
    const { json } = await post(h, JSON.stringify(defaultFormat(fixture())));
    expect(json).toEqual({ ok: true, accepted: true });
    expect(h.fixes).toHaveLength(1);
    expect(h.server.stats().lastPayload).toMatchObject({ towers: 2, wps: 2, req_id: 22 });
  });

  it("answers the Console's test-event text with a note and counts badBody", async () => {
    const h = await listening(start());
    const { res, json } = await post(h, "test-event");
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, note: "body was not valid JSON; ignored" });
    expect(h.server.stats().badBody).toBe(1);
    const warn = h.logs.find((e) => e.msg === "webhook body not JSON");
    expect(warn?.level).toBe("warn");
  });

  it("logs at most the first 80 characters of a body that is not JSON", async () => {
    const h = await listening(start());
    const text = `not json ${"y".repeat(200)}`;
    await post(h, text);
    const warn = h.logs.find((e) => e.msg === "webhook body not JSON");
    expect(warn?.fields.preview).toBe(text.slice(0, 80));
    expect(JSON.stringify(h.logs)).not.toContain(text);
  });

  it("answers 413 to a body over the limit", async () => {
    const h = await listening(start());
    const big = JSON.stringify({ event: "loc", pad: "x".repeat(70 * 1024) });
    const { res, json } = await post(h, big);
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({ code: "payload_too_large", details: null, requestId: "" });
    expect(h.fixes).toHaveLength(0);
  });

  it("answers 413 to a streamed body over the limit that declares no length", async () => {
    const h = await listening(start());
    const chunk = new TextEncoder().encode("x".repeat(10 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 7) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await fetch(`${h.url}/webhook`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "payload_too_large" });
  });

  it("answers a rejected body with its reason and logs it at info", async () => {
    const h = await listening(start());
    const body = fixture();
    body.payload.loc.lck = 0;
    const { json } = await post(h, JSON.stringify(body));
    expect(json).toEqual({ ok: true, accepted: false, reason: "no gps lock" });
    expect(h.server.stats()).toMatchObject({ noLock: 1, lastReason: "no gps lock", lastEvent: "loc" });
    const info = h.logs.find((e) => e.level === "info");
    expect(info?.fields).toEqual({ reason: "no gps lock", event: "loc", deviceId: "e00fce68aaaaaaaaaaaaaaaa" });
  });
});

describe("routing", () => {
  it("answers 404 to any other method or path", async () => {
    const h = await listening(start());
    for (const [method, path] of [
      ["GET", "/webhook"],
      ["POST", "/other"],
      ["POST", "/api/health"],
    ] as const) {
      const res = await fetch(`${h.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${SECRET}` },
        ...(method === "POST" ? { body: fixtureText } : {}),
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ code: "not_found", details: null, requestId: "" });
    }
    expect(h.fixes).toHaveLength(0);
  });
});

describe("statistics and logs", () => {
  it("reflect the sequence of requests and never carry the secret or the body", async () => {
    const h = await listening(start());
    await post(h, fixtureText, "Bearer wrong");
    await post(h, fixtureText);
    await post(h, fixtureText);
    await post(h, "test-event");

    const stats = h.server.stats();
    expect(stats).toMatchObject({
      requestsTotal: 4,
      accepted: 1,
      duplicates: 1,
      badBody: 1,
      rejectedAuth: 1,
      lastReason: "duplicate",
      lastReqId: 22,
      lastDeviceId: "e00fce68aaaaaaaaaaaaaaaa",
      lastEvent: "loc",
      lastTriggers: ["time"],
      lastReceivedAt: new Date(NOW_MS).toISOString(),
      lastAcceptedAt: new Date(NOW_MS).toISOString(),
    });
    expect(stats.lastMeta).toMatchObject({ reqId: 22, batteryPercent: 98 });
    expect(stats.lastPayload).toMatchObject({ towers: 2, wps: 2, req_id: 22, trig: ["time"] });

    const debug = h.logs.find((e) => e.level === "debug");
    expect(debug?.fields).toEqual({
      deviceId: "e00fce68aaaaaaaaaaaaaaaa",
      reqId: 22,
      lat: 46.8721,
      lng: -113.994,
      speedMps: 0.06,
      accuracyM: 13,
    });

    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("Bearer");
    expect(logged).not.toContain(fixtureText);
    expect(logged).not.toContain(JSON.stringify(fixture()));
    expect(logged).not.toContain("towers");
  });
});

describe("answer before relay", () => {
  it("delivers the response to the client before onFix runs", async () => {
    // The client runs in a worker thread and flips a shared flag once it has
    // the response. onFix blocks this thread waiting on that flag, so it only
    // sees the flag set if the answer was already on the socket when onFix ran.
    const shared = new Int32Array(new SharedArrayBuffer(4));
    const results: string[] = [];
    const h = await listening(
      start(() => {
        results.push(Atomics.wait(shared, 0, 0, 5_000));
      }),
    );
    const worker = new Worker(
      `
      const { workerData, parentPort } = require("node:worker_threads");
      const flag = new Int32Array(workerData.buffer);
      fetch(workerData.url, {
        method: "POST",
        headers: { Authorization: workerData.auth },
        body: workerData.body,
      })
        .then((res) => res.json())
        .then((json) => {
          Atomics.store(flag, 0, 1);
          Atomics.notify(flag, 0);
          parentPort.postMessage(json);
        })
        .catch((err) => parentPort.postMessage({ error: String(err) }));
      `,
      {
        eval: true,
        workerData: { buffer: shared.buffer, url: `${h.url}/webhook`, auth: `Bearer ${SECRET}`, body: fixtureText },
      },
    );
    const answer = await new Promise((resolve) => worker.once("message", resolve));
    await worker.terminate();

    expect(answer).toEqual({ ok: true, accepted: true });
    expect(results).toHaveLength(1);
    expect(["ok", "not-equal"]).toContain(results[0]);
  });
});

describe("close", () => {
  it("closes cleanly and stops listening", async () => {
    const h = await listening(start());
    const res = await fetch(`${h.url}/api/health`);
    await res.body?.cancel();
    await h.server.close();
    servers = servers.filter((s) => s !== h.server);
    await expect(fetch(`${h.url}/api/health`)).rejects.toThrow();
  });
});
