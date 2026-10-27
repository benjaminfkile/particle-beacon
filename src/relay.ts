// Carries a fix from the node that received the webhook to the leader through
// the beacon's state document (particle-beacon.md 5, contracts 4.2 and 9.5).
// Every node writes the newest fix under `latestFix`, keeping every other
// top-level key; one write is in flight at a time and only the newest waiting
// fix is written next. The leader hands its own fixes to the beacon at once
// and polls the document for fixes another node wrote, adopting each key once.
import {
  setLatestFix,
  StateStoreError,
  type Beacon,
  type BeaconLogger,
  type LocationBody,
  type StateStore,
} from "beacon-library";
import type { TargetView } from "./heartbeat.js";
import type { AcceptedFix } from "./http.js";
import type { FixMeta } from "./particle/normalize.js";

export interface LatestFixDocument {
  key: string;
  receivedAt: string;
  publishedAt: string | null;
  fix: LocationBody;
  meta: FixMeta;
}

export interface BeaconDocument {
  latestFix?: LatestFixDocument;
  [key: string]: unknown;
}

export interface RelayStats {
  statePollMs: number;
  polls: number;
  pollsFailed: number;
  adopted: number;
  writes: number;
  writesFailed: number;
  lastAdoptedAt: string | null;
  lastAdoptedKey: string | null;
  lastWriteAt: string | null;
  lastWriteError: string | null;
  lastReadError: string | null;
}

export interface RelayOptions {
  target: string;
  beacon: Beacon;
  store: StateStore<BeaconDocument>;
  leader: () => boolean;
  statePollMs: number;
  log: BeaconLogger;
  now?: () => number;
}

export interface Relay {
  receive(f: AcceptedFix): void;
  startPolling(): void;
  stopPolling(): void;
  stop(): void;
  stats(): RelayStats;
  adopted(): TargetView["adopted"];
}

type AdoptedFix = NonNullable<TargetView["adopted"]>;

const READ_WARN_INTERVAL_MS = 60_000;

function errorFields(err: unknown): { code: string; status: number | null } {
  if (err instanceof StateStoreError) return { code: err.code, status: err.status };
  return { code: err instanceof Error ? err.name : "Error", status: null };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The document's latestFix with its receivedAt in ms, or null when it is missing or malformed. */
function readLatestFix(doc: unknown): (LatestFixDocument & { receivedAtMs: number }) | null {
  if (!isObject(doc) || !isObject(doc.latestFix)) return null;
  const l = doc.latestFix;
  if (typeof l.key !== "string" || typeof l.receivedAt !== "string") return null;
  if (!isObject(l.fix) || !isObject(l.meta)) return null;
  if (typeof l.fix.lat !== "number" || typeof l.fix.lng !== "number" || typeof l.fix.recordedAt !== "string") {
    return null;
  }
  const receivedAtMs = Date.parse(l.receivedAt);
  if (Number.isNaN(receivedAtMs)) return null;
  return { ...(l as unknown as LatestFixDocument), receivedAtMs };
}

export function createRelay(opts: RelayOptions): Relay {
  const { target, beacon, store, log } = opts;
  const now = opts.now ?? Date.now;
  const stats: RelayStats = {
    statePollMs: opts.statePollMs,
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
  };
  let current: AdoptedFix | null = null;
  let pending: LatestFixDocument | null = null;
  let writing = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  // Bumped by stopPolling so a load still in flight adopts nothing.
  let pollGeneration = 0;
  let tickInFlight = false;
  let lastReadWarnAt: number | null = null;

  function adopt(fix: LocationBody, meta: FixMeta, key: string, receivedAtMs: number): void {
    setLatestFix(beacon.state, {
      lat: fix.lat,
      lng: fix.lng,
      recordedAt: fix.recordedAt,
      speedMps: fix.speedMps,
      altitudeM: fix.altitudeM,
      headingDeg: fix.headingDeg,
      accuracyM: fix.accuracyM,
    });
    beacon.wake();
    current = { fix, meta, receivedAtMs };
    stats.adopted += 1;
    stats.lastAdoptedKey = key;
    stats.lastAdoptedAt = new Date(receivedAtMs).toISOString();
  }

  function writeNext(): void {
    if (writing || pending === null || stopped) return;
    const value = pending;
    pending = null;
    writing = true;
    store
      .update((doc) => {
        doc.latestFix = value;
      })
      .then(
        () => {
          stats.writes += 1;
          stats.lastWriteAt = new Date(now()).toISOString();
        },
        (err: unknown) => {
          const fields = errorFields(err);
          stats.writesFailed += 1;
          stats.lastWriteError = fields.code;
          log.warn({ target, ...fields }, "fix relay write failed");
        },
      )
      .finally(() => {
        writing = false;
        writeNext();
      });
  }

  function readFailed(err: unknown): void {
    const fields = errorFields(err);
    stats.pollsFailed += 1;
    stats.lastReadError = fields.code;
    const t = now();
    if (lastReadWarnAt !== null && t - lastReadWarnAt < READ_WARN_INTERVAL_MS) return;
    lastReadWarnAt = t;
    log.warn({ target, ...fields }, "fix relay read failed");
  }

  function tick(): void {
    if (tickInFlight) return;
    tickInFlight = true;
    const generation = pollGeneration;
    store
      .load()
      .then(
        (snap) => {
          if (generation !== pollGeneration) return;
          stats.polls += 1;
          const latest = readLatestFix(snap.state);
          if (latest === null || latest.key === stats.lastAdoptedKey) return;
          if (current !== null && latest.receivedAtMs < current.receivedAtMs) return;
          adopt(latest.fix, latest.meta, latest.key, latest.receivedAtMs);
        },
        (err: unknown) => {
          if (generation !== pollGeneration) return;
          stats.polls += 1;
          readFailed(err);
        },
      )
      .finally(() => {
        if (generation === pollGeneration) tickInFlight = false;
      });
  }

  function stopPolling(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
    pollGeneration += 1;
    tickInFlight = false;
  }

  return {
    receive(f: AcceptedFix): void {
      if (stopped) return;
      try {
        if (opts.leader()) adopt(f.fix, f.meta, f.key, f.receivedAtMs);
      } catch (err) {
        log.error({ target, err: err instanceof Error ? err.message : String(err) }, "fix relay adopt failed");
      }
      pending = {
        key: f.key,
        receivedAt: new Date(f.receivedAtMs).toISOString(),
        publishedAt: f.meta.publishedAt,
        fix: f.fix,
        meta: f.meta,
      };
      writeNext();
    },
    startPolling(): void {
      if (stopped || timer !== null) return;
      tick();
      timer = setInterval(tick, opts.statePollMs);
    },
    stopPolling,
    stop(): void {
      stopPolling();
      stopped = true;
      pending = null;
    },
    stats(): RelayStats {
      return { ...stats };
    },
    adopted(): TargetView["adopted"] {
      return current;
    },
  };
}
