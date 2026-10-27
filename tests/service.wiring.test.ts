// Wiring test for the whole service with two targets: a scripted fetch
// answers the leader poll, each target's state document, heartbeats, and
// locations; two fake hubs stand in for the gateway; the HTTP server listens
// on port 0 and receives the fixture through a real fetch. Covers a follower
// writing both documents without sending, the leader sending over both hubs,
// a document written by another node adopted by the leader's poll, leadership
// lost stopping the polls and the cores, the health probe, and stop().
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { FakeHubClient, type HubOptions } from "beacon-library";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { startService, type Service } from "../src/service.js";

type Json = Record<string, any>;

const SECRET = "0123456789abcdef0123456789abcdef01234567";
const STATE_POLL_MS = 250;
const LEADER_POLL_MS = 2000;
const FIXTURE_KEY = "e00fce68aaaaaaaaaaaaaaaa:22:1793132969";
const DEV_ORIGIN = "https://api.example.com";
const PROD_ORIGIN = "https://api-prod.example.com";
const DEV_HUB = "wss://gateway.example.com/hub-dev";
const PROD_HUB = "wss://gateway.example.com/hub-prod";
const fixtureText = readFileSync(new URL("./fixtures/particle-loc.json", import.meta.url), "utf8");

const config: Config = {
  targets: [
    {
      name: "dev",
      apiBaseUrl: DEV_ORIGIN,
      beaconKey: "wbk_dev_placeholder",
      hubUrl: DEV_HUB,
      ingestChannel: "wmsfo-api-dev:ingest",
    },
    {
      name: "prod",
      apiBaseUrl: PROD_ORIGIN,
      beaconKey: "wbk_prod_placeholder",
      hubUrl: PROD_HUB,
      ingestChannel: "wmsfo-api:ingest",
    },
  ],
  webhookSecret: SECRET,
  deviceId: null,
  gatewayInternalUrl: "http://gateway.example.com:8080",
  statePollMs: STATE_POLL_MS,
  logLevel: "silent",
  forceLeader: false,
  gatewayRealtimeToken: "grt_x",
};

interface Doc {
  state: Json | null;
  version: number;
  gets: number;
  puts: number;
}

interface Harness {
  service: Service;
  url: string;
  flag: { leader: boolean };
  leaderPolls: { count: number };
  releaseLeader: () => void;
  docs: Record<string, Doc>;
  hubs: Record<string, FakeHubClient>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sends(hub: FakeHubClient) {
  return hub.invokes.filter((i) => i.method === "SendToChannel");
}

let harness: Harness | null = null;

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 25) {
    if (cond()) return;
    await advance(25);
  }
  expect(cond()).toBe(true);
}

async function boot(opts: { leader: boolean; holdLeader?: boolean }): Promise<Harness> {
  const flag = { leader: opts.leader };
  const leaderPolls = { count: 0 };
  let release: () => void = () => {};
  const held = opts.holdLeader
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  const docs: Record<string, Doc> = {
    [DEV_ORIGIN]: { state: null, version: 0, gets: 0, puts: 0 },
    [PROD_ORIGIN]: { state: null, version: 0, gets: 0, puts: 0 },
  };
  const hubs: Record<string, FakeHubClient> = {
    [DEV_HUB]: new FakeHubClient(),
    [PROD_HUB]: new FakeHubClient(),
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const serverTime = new Date().toISOString();
    if (url.pathname === "/internal/leader") {
      await held;
      leaderPolls.count += 1;
      return json(200, { isLeader: flag.leader, evaluatedAt: new Date().toISOString() });
    }
    const doc = docs[url.origin];
    if (doc === undefined) throw new Error(`unexpected host ${url.origin}`);
    if (url.pathname === "/beacons/me/state" && method === "GET") {
      doc.gets += 1;
      return json(200, { state: doc.state, stateVersion: doc.version, updatedAt: null, serverTime });
    }
    if (url.pathname === "/beacons/me/state" && method === "PUT") {
      doc.puts += 1;
      const body = JSON.parse(String(init?.body)) as { state: Json; expectedVersion: number };
      if (body.expectedVersion !== doc.version) {
        return json(409, {
          code: "state_version_conflict",
          message: "version conflict",
          details: { stateVersion: doc.version },
          requestId: "",
        });
      }
      doc.state = body.state;
      doc.version += 1;
      return json(200, { stateVersion: doc.version, updatedAt: serverTime, serverTime });
    }
    if (url.pathname === "/beacons/heartbeat") {
      return json(200, {
        receivedAt: serverTime,
        liveEventId: null,
        isActive: false,
        stateVersion: doc.version,
        serverTime,
      });
    }
    if (url.pathname === "/locations") {
      return json(200, { seq: 1, published: false, receivedAt: serverTime, serverTime });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  }) as typeof fetch;

  const service = startService(config, {
    log: pino({ level: "silent" }),
    version: "0.0.0-test",
    bootMs: Date.now(),
    instance: "test",
    fetchImpl,
    buildHub: (o: HubOptions) => {
      const hub = hubs[o.hubUrl];
      if (hub === undefined) throw new Error(`unexpected hub ${o.hubUrl}`);
      return hub;
    },
    httpPort: 0,
  });
  const h: Harness = { service, url: "", flag, leaderPolls, releaseLeader: () => release(), docs, hubs };
  harness = h;
  await until(() => service.http().port() !== 0);
  h.url = `http://127.0.0.1:${service.http().port()}`;
  return h;
}

/** Resolves every pending hub send so the send loops can deliver the next fix. */
function ackSends(h: Harness): void {
  for (const hub of Object.values(h.hubs)) for (const i of sends(hub)) i.resolve(undefined);
}

async function postFixture(h: Harness): Promise<Json> {
  const res = await fetch(`${h.url}/webhook`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: fixtureText,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
}

function latestKey(doc: Doc): unknown {
  return (doc.state?.latestFix as Json | undefined)?.key;
}

async function leaderRunning(h: Harness): Promise<void> {
  await until(() => h.service.leader().isLeader());
  await until(() => Object.values(h.hubs).every((hub) => hub.started));
  await advance(50);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(async () => {
  if (harness) {
    harness.releaseLeader();
    await harness.service.stop();
    harness = null;
  }
  vi.useRealTimers();
});

describe("service wiring", () => {
  it("(a) a follower writes both documents and sends nothing over either hub", async () => {
    const h = await boot({ leader: false });
    await advance(LEADER_POLL_MS * 2 + 100);
    expect(h.leaderPolls.count).toBeGreaterThanOrEqual(2);
    expect(h.service.leader().isLeader()).toBe(false);

    const body = await postFixture(h);
    expect(body).toEqual({ ok: true, accepted: true });

    await until(() => latestKey(h.docs[DEV_ORIGIN]!) === FIXTURE_KEY && latestKey(h.docs[PROD_ORIGIN]!) === FIXTURE_KEY);
    await advance(STATE_POLL_MS * 4);
    for (const hub of Object.values(h.hubs)) {
      expect(hub.started).toBe(false);
      expect(sends(hub)).toHaveLength(0);
    }
  });

  it("(b) the leader sends the fix over both hubs and writes both documents", async () => {
    const h = await boot({ leader: true });
    await leaderRunning(h);

    const body = await postFixture(h);
    expect(body).toEqual({ ok: true, accepted: true });

    await until(() => Object.values(h.hubs).every((hub) => sends(hub).length >= 1));
    await until(() => latestKey(h.docs[DEV_ORIGIN]!) === FIXTURE_KEY && latestKey(h.docs[PROD_ORIGIN]!) === FIXTURE_KEY);
    ackSends(h);
    await advance(STATE_POLL_MS * 4);
    for (const hub of Object.values(h.hubs)) {
      expect(sends(hub)).toHaveLength(1);
      expect((sends(hub)[0]!.args[2] as Json).lat).toBe(46.8721);
    }
  });

  it("(c) the leader adopts a fix another node wrote into one target's document", async () => {
    const h = await boot({ leader: true });
    await leaderRunning(h);
    await advance(STATE_POLL_MS * 2);

    const dev = h.docs[DEV_ORIGIN]!;
    const receivedAt = new Date().toISOString();
    dev.state = {
      latestFix: {
        key: "e00fce68aaaaaaaaaaaaaaaa:23:1793133029",
        receivedAt,
        publishedAt: receivedAt,
        fix: {
          lat: 46.8731,
          lng: -113.995,
          recordedAt: receivedAt,
          speedMps: 0.1,
          altitudeM: 975,
          headingDeg: null,
          accuracyM: 12,
        },
        meta: { deviceId: "e00fce68aaaaaaaaaaaaaaaa", reqId: 23, batteryPercent: 97, triggers: ["time"] },
      },
    };
    dev.version += 1;

    await until(() => sends(h.hubs[DEV_HUB]!).length === 1, STATE_POLL_MS + 500);
    expect((sends(h.hubs[DEV_HUB]!)[0]!.args[2] as Json).lat).toBe(46.8731);
    expect(sends(h.hubs[PROD_HUB]!)).toHaveLength(0);
  });

  it("(d) losing leadership stops the state polls and both cores", async () => {
    const h = await boot({ leader: true });
    await leaderRunning(h);
    await advance(STATE_POLL_MS * 2);
    expect(h.docs[DEV_ORIGIN]!.gets).toBeGreaterThan(0);
    expect(h.docs[PROD_ORIGIN]!.gets).toBeGreaterThan(0);

    h.flag.leader = false;
    await until(() => !h.service.leader().isLeader(), LEADER_POLL_MS + 500);
    await until(() => Object.values(h.hubs).every((hub) => hub.stopped));

    const before = h.docs[DEV_ORIGIN]!.gets + h.docs[PROD_ORIGIN]!.gets;
    await advance(3000);
    expect(h.docs[DEV_ORIGIN]!.gets + h.docs[PROD_ORIGIN]!.gets - before).toBe(0);
  });

  it("(e) health is 503 before the first leader poll and 200 after", async () => {
    const h = await boot({ leader: false, holdLeader: true });
    const before = await fetch(`${h.url}/api/health`);
    expect(before.status).toBe(503);
    expect(((await before.json()) as Json).code).toBe("unavailable");

    h.releaseLeader();
    await until(() => h.service.leader().polledOnce());
    const after = await fetch(`${h.url}/api/health`);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ status: "ok" });
  });

  it("(f) stop resolves and closes the port", async () => {
    const h = await boot({ leader: true });
    await leaderRunning(h);
    const port = h.service.http().port();

    await expect(h.service.stop()).resolves.toBeUndefined();
    harness = null;

    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    expect(free).toBe(true);
    await expect(fetch(`${h.url}/api/health`)).rejects.toThrow();
  });
});
