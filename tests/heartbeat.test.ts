// Tests for the heartbeat's health core and debug tree: the empty health,
// the battery and fix age after an adopted fix, the keys of the debug tree
// with cloudLagMs, and the whole body against the contract's heartbeat schema.
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { createBeaconState, type HeartbeatBody } from "beacon-library";
import { describe, expect, it } from "vitest";
import { buildHeartbeatDebug, buildHeartbeatHealth, type TargetView } from "../src/heartbeat.js";
import type { WebhookStats } from "../src/http.js";
import type { RelayStats } from "../src/relay.js";

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;

const RECEIVED_MS = Date.parse("2026-10-27T20:29:38.396Z");
const NOW_MS = RECEIVED_MS + 12_500;
const BOOT_MS = NOW_MS - 3_600_000;
const now = () => NOW_MS;

const schema = JSON.parse(
  readFileSync(new URL("../contracts/schema/heartbeat.schema.json", import.meta.url), "utf8"),
) as object;

const adopted: NonNullable<TargetView["adopted"]> = {
  fix: {
    lat: 46.8721,
    lng: -113.994,
    recordedAt: "2026-10-27T20:29:29.000Z",
    speedMps: 0.06,
    altitudeM: 975.72,
    headingDeg: null,
    accuracyM: 13,
  },
  meta: {
    deviceId: "e00fce68aaaaaaaaaaaaaaaa",
    event: "loc",
    reqId: 22,
    publishedAt: "2026-10-27T20:29:38.164Z",
    deviceTime: "2026-10-27T20:29:29.000Z",
    batteryPercent: 98,
    cellPercent: 70,
    temperatureC: 20.5,
    gpsLock: true,
    hAccuracyM: 13,
    hdop: 1.8,
    triggers: ["time"],
    towers: 2,
    wps: 2,
  },
  receivedAtMs: RECEIVED_MS,
};

function webhookStats(): WebhookStats {
  return {
    requestsTotal: 3,
    accepted: 1,
    rejectedAuth: 0,
    badBody: 1,
    ignoredEvents: 0,
    otherDevice: 0,
    noPayload: 0,
    noLock: 1,
    invalid: 0,
    duplicates: 0,
    lastReceivedAt: new Date(RECEIVED_MS).toISOString(),
    lastAcceptedAt: new Date(RECEIVED_MS).toISOString(),
    lastReason: null,
    lastDeviceId: "e00fce68aaaaaaaaaaaaaaaa",
    lastEvent: "loc",
    lastReqId: 22,
    lastTriggers: ["time"],
    lastMeta: adopted.meta,
    lastPayload: { cmd: "loc", towers: 2, wps: 2 },
  };
}

function relayStats(): RelayStats {
  return {
    statePollMs: 1000,
    polls: 10,
    pollsFailed: 0,
    adopted: 1,
    writes: 1,
    writesFailed: 0,
    lastAdoptedAt: new Date(RECEIVED_MS).toISOString(),
    lastAdoptedKey: "e00fce68aaaaaaaaaaaaaaaa:22:1793132969",
    lastWriteAt: new Date(RECEIVED_MS).toISOString(),
    lastWriteError: null,
    lastReadError: null,
  };
}

function debugFor(view: TargetView["adopted"]): Record<string, unknown> {
  const state = createBeaconState();
  state.socketState = "connected";
  state.httpFallbackSeconds = 2.6;
  state.lastReceiptLatencyMs = 88;
  return buildHeartbeatDebug({
    target: "dev",
    state,
    adopted: view,
    webhook: webhookStats(),
    relay: relayStats(),
    bootMs: BOOT_MS,
    version: "0.1.0",
    instance: "i-example",
    leader: true,
    now,
  });
}

describe("buildHeartbeatHealth", () => {
  it("is empty before any fix", () => {
    const state = createBeaconState();
    expect(buildHeartbeatHealth({ state, adopted: null, now })).toEqual({
      batteryPercent: null,
      lastFixAgeS: null,
      socketState: state.socketState,
    });
  });

  it("carries the battery and the fix age after an adopted fix", () => {
    const state = createBeaconState();
    state.socketState = "connected";
    expect(buildHeartbeatHealth({ state, adopted, now })).toEqual({
      batteryPercent: 98,
      lastFixAgeS: 12.5,
      socketState: "connected",
    });
  });

  it("never reports a negative age", () => {
    const health = buildHeartbeatHealth({ state: createBeaconState(), adopted, now: () => RECEIVED_MS - 5000 });
    expect(health.lastFixAgeS).toBe(0);
  });
});

describe("buildHeartbeatDebug", () => {
  it("has the keys of the design's tree with cloudLagMs", () => {
    const debug = debugFor(adopted);
    expect(Object.keys(debug)).toEqual(["target", "webhook", "device", "normalized", "relay", "transport", "process"]);
    expect(debug.target).toBe("dev");
    expect(Object.keys(debug.webhook as object)[0]).toBe("path");
    expect(debug.webhook).toMatchObject({ path: "/webhook", requestsTotal: 3, accepted: 1, lastReqId: 22 });
    expect(debug.device).toEqual({
      deviceId: "e00fce68aaaaaaaaaaaaaaaa",
      batteryPercent: 98,
      cellPercent: 70,
      temperatureC: 20.5,
      gpsLock: true,
      hAccuracyM: 13,
      hdop: 1.8,
      deviceTime: "2026-10-27T20:29:29.000Z",
      publishedAt: "2026-10-27T20:29:38.164Z",
      cloudLagMs: 232,
    });
    expect(debug.normalized).toEqual({
      lat: 46.8721,
      lng: -113.994,
      speedMps: 0.06,
      altitudeM: 975.72,
      headingDeg: null,
      accuracyM: 13,
      recordedAt: "2026-10-27T20:29:29.000Z",
    });
    expect(debug.relay).toEqual(relayStats());
    expect(debug.transport).toEqual({
      socketState: "connected",
      reconnectCount: 0,
      httpFallbackSeconds: 3,
      lastReceiptLatencyMs: 88,
      sendsFailedSinceBoot: 0,
    });
    expect(debug.process).toEqual({
      uptimeS: 3600,
      leader: true,
      instance: "i-example",
      version: "0.1.0",
      node: process.version,
    });
  });

  it("has nulls for the device and the fix before any fix", () => {
    const debug = debugFor(null);
    expect(Object.values(debug.device as object).every((v) => v === null)).toBe(true);
    expect(Object.keys(debug.device as object)).toContain("cloudLagMs");
    expect(Object.values(debug.normalized as object).every((v) => v === null)).toBe(true);
    expect(Object.keys(debug.normalized as object)).toHaveLength(7);
  });
});

describe("the heartbeat body", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  it.each([
    ["with an adopted fix", adopted],
    ["before any fix", null],
  ] as const)("validates against heartbeat.schema.json %s", (_name, view) => {
    const state = createBeaconState();
    const body: HeartbeatBody = {
      sentAt: new Date(NOW_MS).toISOString(),
      health: buildHeartbeatHealth({ state, adopted: view, now }),
      debug: debugFor(view),
    };
    const ok = validate(JSON.parse(JSON.stringify(body)));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });
});
