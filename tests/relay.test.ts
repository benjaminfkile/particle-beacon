// Tests for the fix relay over the library's state store and fake REST
// client: follower writes, leader adoption without repeats, the newest
// pending fix winning while a write is in flight, failed writes, fixes
// written by another node, unknown keys kept, polling start and stop, and
// the statistics. Fake timers drive the poll.
import {
  createBeaconState,
  createFakeRest,
  createStateStore,
  type Beacon,
  type FakeRest,
  type PutStateResponse,
  type RestError,
} from "beacon-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptedFix } from "../src/http.js";
import type { FixMeta } from "../src/particle/normalize.js";
import { createRelay, type BeaconDocument, type LatestFixDocument, type Relay } from "../src/relay.js";

const T0 = Date.parse("2026-10-27T20:30:00.000Z");
const POLL_MS = 1000;

interface LogEntry {
  level: string;
  fields: Record<string, unknown>;
  msg: string;
}

function meta(reqId: number): FixMeta {
  return {
    deviceId: "e00fce68aaaaaaaaaaaaaaaa",
    event: "loc",
    reqId,
    publishedAt: new Date(T0 - 300).toISOString(),
    deviceTime: new Date(T0 - 1000).toISOString(),
    batteryPercent: 98,
    cellPercent: 70,
    temperatureC: 20.5,
    gpsLock: true,
    hAccuracyM: 13,
    hdop: 1.8,
    triggers: ["time"],
    towers: 2,
    wps: 2,
  };
}

function accepted(reqId: number, receivedAtMs = T0 + reqId): AcceptedFix {
  return {
    fix: {
      lat: 46.8721 + reqId / 10_000,
      lng: -113.994,
      recordedAt: new Date(receivedAtMs - 1000).toISOString(),
      speedMps: 0.06,
      altitudeM: 975.72,
      headingDeg: null,
      accuracyM: 13,
    },
    meta: meta(reqId),
    key: `e00fce68aaaaaaaaaaaaaaaa:${reqId}:1793132969`,
    receivedAtMs,
  };
}

function docFor(f: AcceptedFix): LatestFixDocument {
  return {
    key: f.key,
    receivedAt: new Date(f.receivedAtMs).toISOString(),
    publishedAt: f.meta.publishedAt,
    fix: f.fix,
    meta: f.meta,
  };
}

interface Deferred {
  release: () => void;
}

interface Harness {
  rest: FakeRest;
  beacon: Beacon & { wake: ReturnType<typeof vi.fn> };
  relay: Relay;
  logs: LogEntry[];
  isLeader: { value: boolean };
  /** PUTs held until released, when holdPuts is on. */
  held: Deferred[];
  holdPuts: { value: boolean };
  puts: () => Array<Record<string, unknown>>;
  gets: () => number;
}

function setup(leader: boolean): Harness {
  const rest = createFakeRest(() => Date.now());
  const held: Deferred[] = [];
  const holdPuts = { value: false };
  const realPut = rest.putState.bind(rest);
  const putState = async (state: object, expectedVersion: number): Promise<PutStateResponse | RestError> => {
    if (holdPuts.value) {
      await new Promise<void>((resolve) => held.push({ release: resolve }));
    }
    return realPut(state, expectedVersion);
  };
  const logs: LogEntry[] = [];
  const at = (level: string) => (fields: Record<string, unknown>, msg: string) => {
    logs.push({ level, fields, msg });
  };
  const log = { info: at("info"), warn: at("warn"), error: at("error") };
  const store = createStateStore<BeaconDocument>({
    rest: { getState: () => rest.getState(), putState },
    log,
    empty: () => ({}),
  });
  const beacon = {
    state: createBeaconState(),
    rest,
    wake: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    running: vi.fn(() => true),
  };
  const isLeader = { value: leader };
  const relay = createRelay({
    target: "dev",
    beacon,
    store,
    leader: () => isLeader.value,
    statePollMs: POLL_MS,
    log,
  });
  return {
    rest,
    beacon,
    relay,
    logs,
    isLeader,
    held,
    holdPuts,
    puts: () =>
      rest.stateCalls.filter((c) => c.method === "put").map((c) => c.state as Record<string, unknown>),
    gets: () => rest.stateCalls.filter((c) => c.method === "get").length,
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("receive on a follower", () => {
  it("writes latestFix into the document and leaves the beacon alone", async () => {
    const h = setup(false);
    const f = accepted(1);
    const ret = h.relay.receive(f);
    expect(ret).toBeUndefined();
    await flush();

    expect(h.rest.state).toEqual({ latestFix: docFor(f) });
    expect(h.beacon.state.latestFix).toBeNull();
    expect(h.beacon.wake).not.toHaveBeenCalled();
    expect(h.relay.adopted()).toBeNull();
    const s = h.relay.stats();
    expect(s.writes).toBe(1);
    expect(s.writesFailed).toBe(0);
    expect(s.adopted).toBe(0);
    expect(s.lastWriteAt).toBe(new Date(T0).toISOString());
  });
});

describe("receive on the leader", () => {
  it("hands the fix to the beacon at once, writes it, and a poll does not adopt it again", async () => {
    const h = setup(true);
    const f = accepted(1);
    h.relay.receive(f);

    expect(h.beacon.state.latestFix).toMatchObject({ lat: f.fix.lat, lng: f.fix.lng, recordedAt: f.fix.recordedAt });
    expect(h.beacon.wake).toHaveBeenCalledTimes(1);
    expect(h.relay.stats().adopted).toBe(1);
    expect(h.relay.stats().lastAdoptedKey).toBe(f.key);
    expect(h.relay.stats().lastAdoptedAt).toBe(new Date(f.receivedAtMs).toISOString());
    expect(h.relay.adopted()).toEqual({ fix: f.fix, meta: f.meta, receivedAtMs: f.receivedAtMs });

    await flush();
    expect(h.rest.state).toEqual({ latestFix: docFor(f) });

    h.relay.startPolling();
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    const s = h.relay.stats();
    expect(s.polls).toBe(4);
    expect(s.adopted).toBe(1);
    expect(h.beacon.wake).toHaveBeenCalledTimes(1);
    h.relay.stop();
  });
});

describe("writes while one is in flight", () => {
  it("writes the first and then only the newest", async () => {
    const h = setup(false);
    h.holdPuts.value = true;
    const [a, b, c] = [accepted(1), accepted(2), accepted(3)];

    h.relay.receive(a);
    await flush();
    expect(h.held).toHaveLength(1);
    h.relay.receive(b);
    h.relay.receive(c);
    await flush();
    expect(h.held).toHaveLength(1);

    h.held.shift()!.release();
    await flush();
    expect(h.held).toHaveLength(1);
    h.held.shift()!.release();
    await flush();

    const keys = h.puts().map((s) => (s.latestFix as LatestFixDocument).key);
    expect(keys).toEqual([a.key, c.key]);
    expect(h.rest.state).toEqual({ latestFix: docFor(c) });
    expect(h.relay.stats().writes).toBe(2);
  });
});

describe("a failed write", () => {
  it("is counted, logged, and dropped, and later fixes still write", async () => {
    const h = setup(false);
    h.relay.receive(accepted(0));
    await flush();
    h.rest.nextStateError({
      ok: false,
      status: 500,
      code: "internal_error",
      message: "boom",
      requestId: null,
      serverTime: null,
    });
    h.relay.receive(accepted(1));
    await flush();

    let s = h.relay.stats();
    expect(s.writes).toBe(1);
    expect(s.writesFailed).toBe(1);
    expect(s.lastWriteError).toBe("internal_error");
    expect(h.logs).toContainEqual({
      level: "warn",
      fields: { target: "dev", code: "internal_error", status: 500 },
      msg: "fix relay write failed",
    });
    expect((h.rest.state as BeaconDocument).latestFix?.key).toBe(accepted(0).key);

    const next = accepted(2);
    h.relay.receive(next);
    await flush();
    s = h.relay.stats();
    expect(s.writes).toBe(2);
    expect(s.writesFailed).toBe(1);
    expect(h.rest.state).toEqual({ latestFix: docFor(next) });
  });
});

describe("a fix written by another node", () => {
  it("is adopted exactly once by the leader's poll, and an older one is ignored", async () => {
    const h = setup(true);
    h.relay.startPolling();
    await flush();
    expect(h.relay.stats().polls).toBe(1);
    expect(h.relay.stats().adopted).toBe(0);

    const other = accepted(5, T0 + 500);
    h.rest.setState({ latestFix: docFor(other) }, h.rest.stateVersion + 1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(h.relay.stats().adopted).toBe(1);
    expect(h.relay.stats().lastAdoptedKey).toBe(other.key);
    expect(h.beacon.wake).toHaveBeenCalledTimes(1);
    expect(h.beacon.state.latestFix).toMatchObject({ lat: other.fix.lat, lng: other.fix.lng });
    expect(h.relay.adopted()).toEqual({ fix: other.fix, meta: other.meta, receivedAtMs: other.receivedAtMs });

    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(h.relay.stats().adopted).toBe(1);
    expect(h.beacon.wake).toHaveBeenCalledTimes(1);

    const older = accepted(4, T0 + 100);
    h.rest.setState({ latestFix: docFor(older) }, h.rest.stateVersion + 1);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(h.relay.stats().adopted).toBe(1);
    expect(h.relay.stats().lastAdoptedKey).toBe(other.key);
    expect(h.beacon.wake).toHaveBeenCalledTimes(1);
    h.relay.stop();
  });

  it("keeps the adopted key across stopPolling and startPolling", async () => {
    const h = setup(true);
    const other = accepted(5);
    h.rest.setState({ latestFix: docFor(other) }, 1);
    h.relay.startPolling();
    await flush();
    expect(h.relay.stats().adopted).toBe(1);
    h.relay.stopPolling();
    h.relay.startPolling();
    await flush();
    expect(h.relay.stats().adopted).toBe(1);
    h.relay.stop();
  });

  it("is not adopted on a follower when nothing polls", async () => {
    const h = setup(false);
    h.rest.setState({ latestFix: docFor(accepted(5)) }, 1);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(h.gets()).toBe(0);
    expect(h.relay.stats().adopted).toBe(0);
  });
});

describe("the rest of the document", () => {
  it("keeps an unknown top-level key on a write", async () => {
    const h = setup(false);
    h.rest.setState({ mode: { name: "race" }, other: 7 }, 3);
    const f = accepted(1);
    h.relay.receive(f);
    await flush();
    expect(h.rest.state).toEqual({ mode: { name: "race" }, other: 7, latestFix: docFor(f) });
    expect(h.rest.stateVersion).toBe(4);
  });
});

describe("polling", () => {
  it("stopPolling ends the ticks", async () => {
    const h = setup(true);
    h.relay.startPolling();
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(h.gets()).toBe(3);
    h.relay.stopPolling();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(h.gets()).toBe(3);
    expect(h.relay.stats().polls).toBe(3);
  });

  it("a load that resolves after stopPolling adopts nothing", async () => {
    const h = setup(true);
    h.rest.setState({ latestFix: docFor(accepted(5)) }, 1);
    h.relay.startPolling();
    h.relay.stopPolling();
    await flush();
    expect(h.relay.stats().adopted).toBe(0);
    expect(h.beacon.wake).not.toHaveBeenCalled();
  });

  it("counts a failed read and warns at most once a minute", async () => {
    const h = setup(true);
    const err: RestError = {
      ok: false,
      status: 503,
      code: "unavailable",
      message: "down",
      requestId: null,
      serverTime: null,
    };
    for (let i = 0; i < 5; i++) h.rest.nextStateError(err);
    h.relay.startPolling();
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    let s = h.relay.stats();
    expect(s.polls).toBe(6);
    expect(s.pollsFailed).toBe(5);
    expect(s.lastReadError).toBe("unavailable");
    const warns = () => h.logs.filter((l) => l.msg === "fix relay read failed");
    expect(warns()).toEqual([
      { level: "warn", fields: { target: "dev", code: "unavailable", status: 503 }, msg: "fix relay read failed" },
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    h.rest.nextStateError(err);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    s = h.relay.stats();
    expect(s.pollsFailed).toBe(6);
    expect(warns()).toHaveLength(2);
    h.relay.stop();
  });
});

describe("stop", () => {
  it("ends polling and later receives write nothing", async () => {
    const h = setup(true);
    h.relay.startPolling();
    await flush();
    h.relay.stop();
    const before = h.rest.stateCalls.length;
    h.relay.receive(accepted(1));
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(h.rest.stateCalls.length).toBe(before);
    expect(h.relay.stats().writes).toBe(0);
  });
});

describe("stats", () => {
  it("start empty and carry the poll interval", () => {
    const h = setup(false);
    expect(h.relay.stats()).toEqual({
      statePollMs: POLL_MS,
      polls: 0,
      pollsFailed: 0,
      adopted: 0,
      writes: 0,
      writesFailed: 0,
      lastAdoptedAt: null,
      lastAdoptedKey: null,
      lastWriteAt: null,
      lastWriteError: null,
      lastReadError: null,
    });
  });
});
