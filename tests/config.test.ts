// Tests for loadConfig: the PB_* keys, their validation, and that a
// ConfigError names the offending keys and never their values.
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const SECRET_32 = "s".repeat(32);

function devEnv(): NodeJS.ProcessEnv {
  return {
    PB_TARGETS: "dev",
    PB_DEV_API_BASE_URL: "https://api-dev.example.com/",
    PB_DEV_BEACON_KEY: "wbk_dev_placeholder",
    PB_DEV_HUB_URL: "wss://gateway-dev.example.com/hub",
    PB_DEV_INGEST_CHANNEL: "wmsfo-api-dev:ingest",
    PB_WEBHOOK_SECRET: SECRET_32,
    PB_GATEWAY_INTERNAL_URL: "http://gateway.example.com:8080/",
    PB_STATE_POLL_MS: "1000",
    PB_LOG_LEVEL: "info",
    GATEWAY_REALTIME_TOKEN: "token-placeholder",
  };
}

function prodKeys(): NodeJS.ProcessEnv {
  return {
    PB_PROD_API_BASE_URL: "https://api.example.com",
    PB_PROD_BEACON_KEY: "wbk_prod_placeholder",
    PB_PROD_HUB_URL: "wss://gateway.example.com/hub",
    PB_PROD_INGEST_CHANNEL: "wmsfo-api:ingest",
  };
}

function devProdEnv(): NodeJS.ProcessEnv {
  return { ...devEnv(), ...prodKeys(), PB_TARGETS: "dev,prod" };
}

function configError(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected loadConfig to throw a ConfigError");
}

describe("loadConfig", () => {
  it("loads a valid dev-only environment", () => {
    const config = loadConfig(devEnv());
    expect(config).toEqual({
      targets: [
        {
          name: "dev",
          apiBaseUrl: "https://api-dev.example.com",
          beaconKey: "wbk_dev_placeholder",
          hubUrl: "wss://gateway-dev.example.com/hub",
          ingestChannel: "wmsfo-api-dev:ingest",
        },
      ],
      webhookSecret: SECRET_32,
      deviceId: null,
      gatewayInternalUrl: "http://gateway.example.com:8080",
      statePollMs: 1000,
      logLevel: "info",
      forceLeader: false,
      gatewayRealtimeToken: "token-placeholder",
    });
  });

  it("loads two targets in PB_TARGETS order", () => {
    expect(loadConfig(devProdEnv()).targets.map((t) => t.name)).toEqual(["dev", "prod"]);
    const reversed = loadConfig({ ...devProdEnv(), PB_TARGETS: "prod,dev" });
    expect(reversed.targets.map((t) => t.name)).toEqual(["prod", "dev"]);
    expect(reversed.targets[0]).toEqual({
      name: "prod",
      apiBaseUrl: "https://api.example.com",
      beaconKey: "wbk_prod_placeholder",
      hubUrl: "wss://gateway.example.com/hub",
      ingestChannel: "wmsfo-api:ingest",
    });
  });

  it("ignores PB_DEV_* keys when only prod is named", () => {
    const env: NodeJS.ProcessEnv = { ...devEnv(), ...prodKeys(), PB_TARGETS: "prod" };
    delete env.PB_DEV_API_BASE_URL;
    delete env.PB_DEV_BEACON_KEY;
    delete env.PB_DEV_HUB_URL;
    delete env.PB_DEV_INGEST_CHANNEL;
    const config = loadConfig(env);
    expect(config.targets.map((t) => t.name)).toEqual(["prod"]);

    const invalidDev = loadConfig({ ...env, PB_DEV_BEACON_KEY: "not-a-key", PB_DEV_HUB_URL: "nope" });
    expect(invalidDev.targets.map((t) => t.name)).toEqual(["prod"]);
  });

  describe("PB_TARGETS", () => {
    it.each(["", "staging", "dev,dev", "dev,", "DEV"])("refuses %j", (value) => {
      const err = configError({ ...devProdEnv(), PB_TARGETS: value });
      expect(err.keys).toEqual(["PB_TARGETS"]);
    });

    it("refuses an absent value", () => {
      const env = devEnv();
      delete env.PB_TARGETS;
      expect(configError(env).keys).toEqual(["PB_TARGETS"]);
    });

    it("trims names", () => {
      const config = loadConfig({ ...devProdEnv(), PB_TARGETS: " dev , prod " });
      expect(config.targets.map((t) => t.name)).toEqual(["dev", "prod"]);
    });
  });

  it("names missing per-target keys with the target and never the values", () => {
    const env: NodeJS.ProcessEnv = { ...devProdEnv() };
    delete env.PB_PROD_API_BASE_URL;
    delete env.PB_PROD_BEACON_KEY;
    delete env.PB_PROD_HUB_URL;
    delete env.PB_PROD_INGEST_CHANNEL;
    const err = configError(env);
    expect(err.keys).toEqual([
      "PB_PROD_API_BASE_URL",
      "PB_PROD_BEACON_KEY",
      "PB_PROD_HUB_URL",
      "PB_PROD_INGEST_CHANNEL",
    ]);
    expect(err.message).toBe(
      "invalid or missing configuration: PB_PROD_API_BASE_URL, PB_PROD_BEACON_KEY, PB_PROD_HUB_URL, PB_PROD_INGEST_CHANNEL",
    );
  });

  it("names invalid per-target keys and never the values", () => {
    const err = configError({
      ...devEnv(),
      PB_DEV_API_BASE_URL: "ftp://api-dev.example.com",
      PB_DEV_BEACON_KEY: "key_without_prefix",
      PB_DEV_HUB_URL: "https://gateway-dev.example.com/hub",
      PB_DEV_INGEST_CHANNEL: "no-colon",
    });
    expect(err.keys).toEqual([
      "PB_DEV_API_BASE_URL",
      "PB_DEV_BEACON_KEY",
      "PB_DEV_HUB_URL",
      "PB_DEV_INGEST_CHANNEL",
    ]);
    expect(err.message).not.toContain("example.com");
    expect(err.message).not.toContain("key_without_prefix");
  });

  it("never puts a value in the message", () => {
    const err = configError({ ...devEnv(), PB_TARGETS: "dev,prod", PB_WEBHOOK_SECRET: "short" });
    expect(err.message).not.toContain("wbk_");
    expect(err.message).not.toContain("wss://");
    expect(err.message).not.toContain("short");
  });

  it("refuses a 31-character secret and accepts a 32-character one", () => {
    expect(configError({ ...devEnv(), PB_WEBHOOK_SECRET: "s".repeat(31) }).keys).toEqual(["PB_WEBHOOK_SECRET"]);
    expect(loadConfig({ ...devEnv(), PB_WEBHOOK_SECRET: SECRET_32 }).webhookSecret).toBe(SECRET_32);
  });

  describe("PB_DEVICE_ID", () => {
    it("refuses 23 characters", () => {
      expect(configError({ ...devEnv(), PB_DEVICE_ID: "a".repeat(23) }).keys).toEqual(["PB_DEVICE_ID"]);
    });

    it("refuses a non-hex character", () => {
      expect(configError({ ...devEnv(), PB_DEVICE_ID: `${"a".repeat(23)}g` }).keys).toEqual(["PB_DEVICE_ID"]);
    });

    it("stores a valid upper-case id lower-cased", () => {
      expect(loadConfig({ ...devEnv(), PB_DEVICE_ID: "E00FCE68AAAAAAAAAAAAAAAA" }).deviceId).toBe(
        "e00fce68aaaaaaaaaaaaaaaa",
      );
    });
  });

  describe("PB_STATE_POLL_MS", () => {
    it("defaults to 1000 when absent", () => {
      const env = devEnv();
      delete env.PB_STATE_POLL_MS;
      expect(loadConfig(env).statePollMs).toBe(1000);
    });

    it.each(["249", "10001", "2.5", "abc"])("refuses %j", (value) => {
      expect(configError({ ...devEnv(), PB_STATE_POLL_MS: value }).keys).toEqual(["PB_STATE_POLL_MS"]);
    });

    it.each([["250", 250], ["500", 500], ["10000", 10000]])("accepts %j", (value, expected) => {
      expect(loadConfig({ ...devEnv(), PB_STATE_POLL_MS: value }).statePollMs).toBe(expected);
    });
  });

  it("requires PB_LOG_LEVEL and PB_GATEWAY_INTERNAL_URL", () => {
    const env = devEnv();
    delete env.PB_LOG_LEVEL;
    env.PB_GATEWAY_INTERNAL_URL = "not a url";
    expect(configError(env).keys).toEqual(["PB_GATEWAY_INTERNAL_URL", "PB_LOG_LEVEL"]);
  });

  describe("PB_FORCE_LEADER and GATEWAY_REALTIME_TOKEN", () => {
    it("accepts a forced leader with dev only", () => {
      const config = loadConfig({ ...devEnv(), PB_FORCE_LEADER: "TRUE" });
      expect(config.forceLeader).toBe(true);
    });

    it("refuses a forced leader with dev,prod, naming PB_FORCE_LEADER", () => {
      const err = configError({ ...devProdEnv(), PB_FORCE_LEADER: "true" });
      expect(err.keys).toEqual(["PB_FORCE_LEADER"]);
      expect(err.message).toBe("invalid or missing configuration: PB_FORCE_LEADER");
    });

    it("refuses PB_FORCE_LEADER=maybe", () => {
      expect(configError({ ...devEnv(), PB_FORCE_LEADER: "maybe" }).keys).toEqual(["PB_FORCE_LEADER"]);
    });

    it("accepts PB_FORCE_LEADER=false", () => {
      expect(loadConfig({ ...devEnv(), PB_FORCE_LEADER: "False" }).forceLeader).toBe(false);
    });

    it("makes the token optional only under a forced leader", () => {
      const env = devEnv();
      delete env.GATEWAY_REALTIME_TOKEN;
      expect(configError(env).keys).toEqual(["GATEWAY_REALTIME_TOKEN"]);
      expect(configError({ ...env, PB_FORCE_LEADER: "false" }).keys).toEqual(["GATEWAY_REALTIME_TOKEN"]);
      const forced = loadConfig({ ...env, PB_FORCE_LEADER: "true" });
      expect(forced.gatewayRealtimeToken).toBeNull();
    });
  });

  it("reports every missing key of an empty environment once", () => {
    const keys = configError({}).keys;
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "PB_TARGETS",
      "PB_WEBHOOK_SECRET",
      "PB_GATEWAY_INTERNAL_URL",
      "PB_LOG_LEVEL",
      "GATEWAY_REALTIME_TOKEN",
    ]);
  });
});
