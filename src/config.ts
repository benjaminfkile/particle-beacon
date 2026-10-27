// Loads and validates the PB_* configuration from the environment
// (particle-beacon.md 6). Every problem is collected before throwing, and the
// thrown ConfigError names the offending keys, never their values.

export interface Target {
  name: "dev" | "prod";
  apiBaseUrl: string;
  beaconKey: string;
  hubUrl: string;
  ingestChannel: string;
}

export interface Config {
  targets: Target[];
  webhookSecret: string;
  deviceId: string | null;
  gatewayInternalUrl: string;
  statePollMs: number;
  logLevel: string;
  forceLeader: boolean;
  gatewayRealtimeToken: string | null;
}

export class ConfigError extends Error {
  readonly keys: string[];

  constructor(keys: string[]) {
    super(`invalid or missing configuration: ${keys.join(", ")}`);
    this.name = "ConfigError";
    this.keys = keys;
  }
}

const TARGET_NAMES = ["dev", "prod"] as const;
const MIN_SECRET_LENGTH = 32;
const DEVICE_ID = /^[0-9a-f]{24}$/i;
const DEFAULT_STATE_POLL_MS = 1000;
const MIN_STATE_POLL_MS = 250;
const MAX_STATE_POLL_MS = 10_000;

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseUrl(value: string | undefined, protocols: string[]): string | null {
  if (!isNonEmpty(value)) return null;
  const trimmed = value.trim();
  try {
    if (!protocols.includes(new URL(trimmed).protocol)) return null;
  } catch {
    return null;
  }
  return trimmed;
}

function parseHttpUrl(value: string | undefined): string | null {
  return parseUrl(value, ["http:", "https:"])?.replace(/\/+$/, "") ?? null;
}

function parseWsUrl(value: string | undefined): string | null {
  return parseUrl(value, ["ws:", "wss:"]);
}

function isTargetName(value: string): value is Target["name"] {
  return (TARGET_NAMES as readonly string[]).includes(value);
}

function parseTargetNames(value: string | undefined): Target["name"][] | null {
  if (!isNonEmpty(value)) return null;
  const names: Target["name"][] = [];
  for (const part of value.split(",")) {
    const name = part.trim();
    if (!isTargetName(name) || names.includes(name)) return null;
    names.push(name);
  }
  return names;
}

function parseBoolean(value: string): boolean | null {
  const lower = value.trim().toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  return null;
}

function parseTarget(name: Target["name"], env: NodeJS.ProcessEnv, missing: string[]): Target | null {
  const prefix = `PB_${name.toUpperCase()}_`;
  const apiBaseUrlKey = `${prefix}API_BASE_URL`;
  const beaconKeyKey = `${prefix}BEACON_KEY`;
  const hubUrlKey = `${prefix}HUB_URL`;
  const ingestChannelKey = `${prefix}INGEST_CHANNEL`;

  const apiBaseUrl = parseHttpUrl(env[apiBaseUrlKey]);
  if (apiBaseUrl === null) missing.push(apiBaseUrlKey);

  const beaconKey = env[beaconKeyKey];
  const beaconKeyOk = isNonEmpty(beaconKey) && beaconKey.startsWith("wbk_");
  if (!beaconKeyOk) missing.push(beaconKeyKey);

  const hubUrl = parseWsUrl(env[hubUrlKey]);
  if (hubUrl === null) missing.push(hubUrlKey);

  const ingestChannel = env[ingestChannelKey];
  const ingestChannelOk = isNonEmpty(ingestChannel) && ingestChannel.includes(":");
  if (!ingestChannelOk) missing.push(ingestChannelKey);

  if (apiBaseUrl === null || !beaconKeyOk || hubUrl === null || !ingestChannelOk) return null;
  return { name, apiBaseUrl, beaconKey, hubUrl, ingestChannel };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];

  const targetNames = parseTargetNames(env.PB_TARGETS);
  if (targetNames === null) missing.push("PB_TARGETS");
  const targets: Target[] = [];
  for (const name of targetNames ?? []) {
    const target = parseTarget(name, env, missing);
    if (target !== null) targets.push(target);
  }

  const webhookSecret = env.PB_WEBHOOK_SECRET;
  if (!isNonEmpty(webhookSecret) || webhookSecret.length < MIN_SECRET_LENGTH) {
    missing.push("PB_WEBHOOK_SECRET");
  }

  let deviceId: string | null = null;
  if (isNonEmpty(env.PB_DEVICE_ID)) {
    const raw = env.PB_DEVICE_ID.trim();
    if (DEVICE_ID.test(raw)) deviceId = raw.toLowerCase();
    else missing.push("PB_DEVICE_ID");
  }

  const gatewayInternalUrl = parseHttpUrl(env.PB_GATEWAY_INTERNAL_URL);
  if (gatewayInternalUrl === null) missing.push("PB_GATEWAY_INTERNAL_URL");

  let statePollMs = DEFAULT_STATE_POLL_MS;
  if (isNonEmpty(env.PB_STATE_POLL_MS)) {
    const raw = env.PB_STATE_POLL_MS.trim();
    const parsed = Number(raw);
    if (/^\d+$/.test(raw) && parsed >= MIN_STATE_POLL_MS && parsed <= MAX_STATE_POLL_MS) {
      statePollMs = parsed;
    } else {
      missing.push("PB_STATE_POLL_MS");
    }
  }

  const logLevel = env.PB_LOG_LEVEL;
  if (!isNonEmpty(logLevel)) missing.push("PB_LOG_LEVEL");

  let forceLeader = false;
  if (isNonEmpty(env.PB_FORCE_LEADER)) {
    const parsed = parseBoolean(env.PB_FORCE_LEADER);
    if (parsed === null) missing.push("PB_FORCE_LEADER");
    else forceLeader = parsed;
  }
  if (forceLeader && targetNames?.includes("prod")) missing.push("PB_FORCE_LEADER");

  const token = env.GATEWAY_REALTIME_TOKEN;
  const gatewayRealtimeToken = isNonEmpty(token) ? token : null;
  if (gatewayRealtimeToken === null && !forceLeader) missing.push("GATEWAY_REALTIME_TOKEN");

  if (missing.length > 0) throw new ConfigError([...new Set(missing)]);

  return {
    targets,
    webhookSecret: webhookSecret as string,
    deviceId,
    gatewayInternalUrl: gatewayInternalUrl as string,
    statePollMs,
    logLevel: logLevel as string,
    forceLeader,
    gatewayRealtimeToken,
  };
}
