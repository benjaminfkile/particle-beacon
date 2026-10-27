// Boots the service: loads the configuration (exiting 2 with the key names on
// a bad one), builds the pino logger, reads the version from package.json,
// starts the service, and stops it gracefully on SIGTERM or SIGINT. Anything
// thrown past that is fatal and exits 1.
import { readFileSync } from "node:fs";
import { pino } from "pino";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { startService, type Service } from "./service.js";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function loadOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`config error: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}

function main(): void {
  const config = loadOrExit();
  const log = pino({ level: config.logLevel });
  const version = readVersion();
  const instance = process.env.HOSTNAME ?? "local";

  const fatal = (err: unknown, msg: string): void => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, msg);
    process.exit(1);
  };
  process.on("uncaughtException", (err) => fatal(err, "uncaught exception"));
  process.on("unhandledRejection", (err) => fatal(err, "unhandled rejection"));

  log.info({ version, instance }, "booting");
  let service: Service;
  try {
    service = startService(config, { log, version, bootMs: Date.now(), instance });
  } catch (err) {
    fatal(err, "start failed");
    return;
  }

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    service.stop().then(
      () => process.exit(0),
      (err: unknown) => fatal(err, "shutdown failed"),
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
