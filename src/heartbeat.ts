// Builds the heartbeat's health core and debug tree for one target
// (particle-beacon.md 5a) from the beacon state, the fix the relay last
// adopted, this node's webhook statistics, and the relay's statistics. Pure:
// the clock is passed in.
import type { BeaconState, HealthCore, LocationBody } from "beacon-library";
import type { WebhookStats } from "./http.js";
import type { FixMeta } from "./particle/normalize.js";
import type { RelayStats } from "./relay.js";

export interface TargetView {
  target: string;
  adopted: { fix: LocationBody; meta: FixMeta; receivedAtMs: number } | null;
}

export interface HeartbeatHealthInput {
  state: BeaconState;
  adopted: TargetView["adopted"];
  now?: () => number;
}

export interface HeartbeatDebugInput {
  target: string;
  state: BeaconState;
  adopted: TargetView["adopted"];
  webhook: WebhookStats;
  relay: RelayStats;
  bootMs: number;
  version: string;
  instance: string;
  leader: boolean;
  now?: () => number;
}

export function buildHeartbeatHealth(input: HeartbeatHealthInput): HealthCore {
  const now = input.now ?? Date.now;
  const { adopted } = input;
  return {
    batteryPercent: adopted?.meta.batteryPercent ?? null,
    lastFixAgeS: adopted ? Math.max(0, (now() - adopted.receivedAtMs) / 1000) : null,
    socketState: input.state.socketState,
  };
}

function device(adopted: TargetView["adopted"]): Record<string, unknown> {
  const meta = adopted?.meta ?? null;
  const publishedMs = meta?.publishedAt ? Date.parse(meta.publishedAt) : Number.NaN;
  return {
    deviceId: meta?.deviceId ?? null,
    batteryPercent: meta?.batteryPercent ?? null,
    cellPercent: meta?.cellPercent ?? null,
    temperatureC: meta?.temperatureC ?? null,
    gpsLock: meta?.gpsLock ?? null,
    hAccuracyM: meta?.hAccuracyM ?? null,
    hdop: meta?.hdop ?? null,
    deviceTime: meta?.deviceTime ?? null,
    publishedAt: meta?.publishedAt ?? null,
    cloudLagMs: adopted && !Number.isNaN(publishedMs) ? adopted.receivedAtMs - publishedMs : null,
  };
}

function normalized(adopted: TargetView["adopted"]): Record<string, unknown> {
  const fix = adopted?.fix ?? null;
  return {
    lat: fix?.lat ?? null,
    lng: fix?.lng ?? null,
    speedMps: fix?.speedMps ?? null,
    altitudeM: fix?.altitudeM ?? null,
    headingDeg: fix?.headingDeg ?? null,
    accuracyM: fix?.accuracyM ?? null,
    recordedAt: fix?.recordedAt ?? null,
  };
}

export function buildHeartbeatDebug(input: HeartbeatDebugInput): Record<string, unknown> {
  const now = input.now ?? Date.now;
  const { state } = input;
  return {
    target: input.target,
    webhook: { path: "/webhook", ...input.webhook },
    device: device(input.adopted),
    normalized: normalized(input.adopted),
    relay: { ...input.relay },
    transport: {
      socketState: state.socketState,
      reconnectCount: state.reconnectCount,
      httpFallbackSeconds: Math.round(state.httpFallbackSeconds),
      lastReceiptLatencyMs: state.lastReceiptLatencyMs,
      sendsFailedSinceBoot: state.sendsFailedSinceBoot,
    },
    process: {
      uptimeS: Math.max(0, Math.floor((now() - input.bootMs) / 1000)),
      leader: input.leader,
      instance: input.instance,
      version: input.version,
      node: process.version,
    },
  };
}
