// Tests for normalize, fixKey and summarizePayload against the Particle
// fixture: both webhook body shapes, the lock, heading, range, device, event
// and duplicate rules, and that every accepted fix matches location.schema.json.
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  fixKey,
  normalize,
  summarizePayload,
  type NormalizeOptions,
  type NormalizeResult,
} from "../src/particle/normalize.js";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

type Json = Record<string, any>;

const fixtureText = readFileSync(new URL("./fixtures/particle-loc.json", import.meta.url), "utf8");
const schema = JSON.parse(
  readFileSync(new URL("../contracts/schema/location.schema.json", import.meta.url), "utf8"),
) as Json;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateLocation = ajv.compile(schema);

const RECEIVED_AT_MS = Date.parse("2026-10-27T20:30:00.000Z");
const KEY = "e00fce68aaaaaaaaaaaaaaaa:22:1793132969";

function fixture(): Json {
  return JSON.parse(fixtureText) as Json;
}

function withLoc(patch: Json): Json {
  const body = fixture();
  Object.assign(body.payload.loc, patch);
  return body;
}

function defaultFormat(body: Json): Json {
  return {
    event: body.event,
    data: JSON.stringify(body.payload),
    coreid: body.deviceId,
    published_at: body.publishedAt,
  };
}

function run(body: unknown, opts: Partial<NormalizeOptions> = {}): NormalizeResult {
  const result = normalize(body, { receivedAtMs: RECEIVED_AT_MS, deviceId: null, lastKey: null, ...opts });
  if (result.ok) {
    expect(validateLocation(result.fix), JSON.stringify(validateLocation.errors)).toBe(true);
  }
  return result;
}

function ok(body: unknown, opts: Partial<NormalizeOptions> = {}) {
  const result = run(body, opts);
  if (!result.ok) throw new Error(`expected a fix, got ${result.reason}`);
  return result;
}

function reason(body: unknown, opts: Partial<NormalizeOptions> = {}): string | null {
  const result = run(body, opts);
  return result.ok ? null : result.reason;
}

describe("normalize", () => {
  it("normalizes the custom-template body", () => {
    const { fix, meta, key } = ok(fixture());
    expect(fix).toEqual({
      lat: 46.8721,
      lng: -113.994,
      recordedAt: "2026-10-27T20:29:29.000Z",
      speedMps: 0.06,
      altitudeM: 975.72,
      headingDeg: null,
      accuracyM: 13,
    });
    expect(key).toBe(KEY);
    expect(meta).toEqual({
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
    });
  });

  it("gives the identical fix and key for Particle's default format", () => {
    const custom = ok(fixture());
    const dflt = ok(defaultFormat(fixture()));
    expect(dflt.fix).toEqual(custom.fix);
    expect(dflt.key).toBe(custom.key);
    expect(dflt.meta).toEqual(custom.meta);
  });

  it("treats a data string that is not JSON as no payload", () => {
    expect(reason({ ...defaultFormat(fixture()), data: "not json {" })).toBe("no payload");
  });

  it("keeps the heading only while moving at 1 m/s or more", () => {
    expect(ok(withLoc({ spd: 12.4 })).fix.headingDeg).toBe(328.64);
    expect(ok(withLoc({ spd: 0.99 })).fix.headingDeg).toBeNull();
    expect(ok(withLoc({ spd: 12, hd: 361 })).fix.headingDeg).toBeNull();
  });

  it("nulls out-of-range optional values while the fix stays ok", () => {
    expect(ok(withLoc({ spd: 501 })).fix.speedMps).toBeNull();
    expect(ok(withLoc({ alt: 20001 })).fix.altitudeM).toBeNull();
    expect(ok(withLoc({ h_acc: -1 })).fix.accuracyM).toBeNull();
  });

  it("rejects a position without a GPS lock", () => {
    expect(reason(withLoc({ lck: 0 }))).toBe("no gps lock");
  });

  it("ignores any event but loc", () => {
    const result = run({ ...fixture(), event: "loc-enhanced" });
    expect(result).toEqual({
      ok: false,
      reason: "ignored event",
      event: "loc-enhanced",
      deviceId: "e00fce68aaaaaaaaaaaaaaaa",
    });
  });

  it("filters by the configured device id, case-insensitively", () => {
    expect(reason(fixture(), { deviceId: "e00fce68bbbbbbbbbbbbbbbb" })).toBe("other device");
    expect(ok(fixture(), { deviceId: "E00FCE68AAAAAAAAAAAAAAAA" }).key).toBe(KEY);
  });

  it("rejects the last accepted key as a duplicate", () => {
    expect(reason(fixture(), { lastKey: KEY })).toBe("duplicate");
  });

  it("falls back from loc.time to time, publishedAt, then the receipt time", () => {
    const noLocTime = fixture();
    delete noLocTime.payload.loc.time;
    const a = ok(noLocTime);
    expect(a.fix.recordedAt).toBe("2026-10-27T20:29:28.000Z");
    expect(a.meta.deviceTime).toBeNull();
    expect(a.key).toBe("e00fce68aaaaaaaaaaaaaaaa:22:-");

    delete noLocTime.payload.time;
    expect(ok(noLocTime).fix.recordedAt).toBe("2026-10-27T20:29:38.164Z");

    delete noLocTime.publishedAt;
    expect(ok(noLocTime).fix.recordedAt).toBe("2026-10-27T20:30:00.000Z");
  });

  it("rejects a latitude out of range", () => {
    expect(reason(withLoc({ lat: 91 }))).toBe("no usable position");
  });

  it("treats a body that is not an object as no payload", () => {
    expect(reason("loc")).toBe("no payload");
    expect(reason(null)).toBe("no payload");
  });
});

describe("fixKey", () => {
  it("uses - for a missing part", () => {
    expect(fixKey(null, null, null)).toBe("-:-:-");
    expect(fixKey("abc", 1, 2)).toBe("abc:1:2");
  });
});

describe("summarizePayload", () => {
  it("replaces towers and wps by their lengths and leaves the rest untouched", () => {
    const payload = fixture().payload;
    const summary = summarizePayload(payload) as Json;
    expect(summary.towers).toBe(2);
    expect(summary.wps).toBe(2);
    expect(summary.loc).toEqual(payload.loc);
    expect(summary.req_id).toBe(22);
    expect(Array.isArray(payload.towers)).toBe(true);
  });

  it("returns a non-object as given", () => {
    expect(summarizePayload("text")).toBe("text");
    expect(summarizePayload(null)).toBeNull();
  });
});
