// Turns a Particle webhook body into a LocationBody for the API plus the
// device metadata the heartbeat reports (particle-beacon.md 3). Accepts the
// custom-template shape and Particle's default shape. Pure: no I/O, no clock.
import type { LocationBody } from "beacon-library";

export interface FixMeta {
  deviceId: string | null;
  event: string;
  reqId: number | null;
  publishedAt: string | null;
  deviceTime: string | null;
  batteryPercent: number | null;
  cellPercent: number | null;
  temperatureC: number | null;
  gpsLock: boolean;
  hAccuracyM: number | null;
  hdop: number | null;
  triggers: string[];
  towers: number;
  wps: number;
}

export type NormalizeReason =
  | "ignored event"
  | "other device"
  | "no payload"
  | "no gps lock"
  | "no usable position"
  | "duplicate";

export type NormalizeResult =
  | { ok: true; fix: LocationBody; meta: FixMeta; key: string }
  | { ok: false; reason: NormalizeReason; event: string | null; deviceId: string | null };

export interface NormalizeOptions {
  receivedAtMs: number;
  deviceId: string | null;
  lastKey: string | null;
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function inRange(value: unknown, min: number, max: number): number | null {
  const n = finite(value);
  return n !== null && n >= min && n <= max ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Renders epoch milliseconds as RFC 3339 UTC with three fractional digits. */
function toRfc3339Ms(ms: number): string {
  return new Date(ms).toISOString();
}

/** Epoch seconds when a finite number above 0 that maps to a valid date. */
function epochSeconds(value: unknown): number | null {
  const n = finite(value);
  if (n === null || n <= 0) return null;
  return Number.isNaN(new Date(n * 1000).getTime()) ? null : n;
}

function pickDeviceId(body: Obj): string | null {
  const id = str(body.deviceId) ?? str(body.coreid) ?? str(body.device_id);
  return id === null ? null : id.toLowerCase();
}

function pickPublishedAt(body: Obj): string | null {
  const value = str(body.publishedAt) ?? str(body.published_at);
  return value !== null && !Number.isNaN(Date.parse(value)) ? value : null;
}

function pickPayload(body: Obj): Obj | null {
  const raw = body.payload ?? body.data;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isObject(raw) ? raw : null;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function triggers(value: unknown): string[] {
  return Array.isArray(value) && value.every((t) => typeof t === "string") ? [...value] : [];
}

function battery(value: unknown): number | null {
  const n = finite(value);
  return n === null ? null : Math.min(100, Math.max(0, Math.round(n)));
}

/** `<deviceId>:<reqId>:<deviceTimeS>`, with `-` for a missing part. */
export function fixKey(
  deviceId: string | null,
  reqId: number | null,
  deviceTimeS: number | null,
): string {
  return `${deviceId ?? "-"}:${reqId ?? "-"}:${deviceTimeS ?? "-"}`;
}

/** The payload with its towers and wps arrays replaced by their lengths. */
export function summarizePayload(payload: unknown): unknown {
  if (!isObject(payload)) return payload;
  const out: Obj = { ...payload };
  if (Array.isArray(out.towers)) out.towers = out.towers.length;
  if (Array.isArray(out.wps)) out.wps = out.wps.length;
  return out;
}

export function normalize(body: unknown, opts: NormalizeOptions): NormalizeResult {
  if (!isObject(body)) return { ok: false, reason: "no payload", event: null, deviceId: null };

  const event = str(body.event) ?? str(body.name);
  const deviceId = pickDeviceId(body);
  const fail = (reason: NormalizeReason): NormalizeResult => ({ ok: false, reason, event, deviceId });

  if (event !== "loc") return fail("ignored event");
  if (opts.deviceId !== null && opts.deviceId.toLowerCase() !== deviceId) return fail("other device");

  const payload = pickPayload(body);
  const loc = payload === null ? null : payload.loc;
  if (payload === null || !isObject(loc)) return fail("no payload");
  if (loc.lck !== 1) return fail("no gps lock");

  const lat = inRange(loc.lat, -90, 90);
  const lng = inRange(loc.lon, -180, 180);
  if (lat === null || lng === null) return fail("no usable position");

  const reqId = Number.isInteger(payload.req_id) ? (payload.req_id as number) : null;
  const deviceTimeS = epochSeconds(loc.time);
  const key = fixKey(deviceId, reqId, deviceTimeS);
  if (key === opts.lastKey) return fail("duplicate");

  const publishedAt = pickPublishedAt(body);
  const recordedAtS = deviceTimeS ?? epochSeconds(payload.time);
  const recordedAt =
    recordedAtS !== null
      ? toRfc3339Ms(recordedAtS * 1000)
      : toRfc3339Ms(publishedAt !== null ? Date.parse(publishedAt) : opts.receivedAtMs);

  const speedMps = inRange(loc.spd, 0, 500);
  const spd = finite(loc.spd);
  const fix: LocationBody = {
    lat,
    lng,
    recordedAt,
    speedMps,
    altitudeM: inRange(loc.alt, -500, 20000),
    headingDeg: spd !== null && spd >= 1 ? inRange(loc.hd, 0, 360) : null,
    accuracyM: inRange(loc.h_acc, 0, 100000),
  };

  const meta: FixMeta = {
    deviceId,
    event,
    reqId,
    publishedAt,
    deviceTime: deviceTimeS === null ? null : toRfc3339Ms(deviceTimeS * 1000),
    batteryPercent: battery(loc.batt),
    cellPercent: finite(loc.cell),
    temperatureC: finite(loc.temp),
    gpsLock: true,
    hAccuracyM: finite(loc.h_acc),
    hdop: finite(loc.hdop),
    triggers: triggers(payload.trig),
    towers: arrayLength(payload.towers),
    wps: arrayLength(payload.wps),
  };

  return { ok: true, fix, meta, key };
}
