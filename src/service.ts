// Wires the service (particle-beacon.md 2): one HTTP server for every node,
// and per target one beacon core, one state store, and one relay; a single
// leader gate runs the first target's beacon and, from its onStart and onStop,
// every other target's beacon and every relay's state poll. Fetch, the hub
// builder, the port, and the HTTP server are injectable for the wiring test.
import {
  createBeacon,
  createStateStore,
  gateOnLeader,
  type Beacon,
  type HubClient,
  type HubOptions,
  type Leader,
} from "beacon-library";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { buildHeartbeatDebug, buildHeartbeatHealth } from "./heartbeat.js";
import { startHttpServer, type HttpServer } from "./http.js";
import { createRelay, type BeaconDocument, type Relay } from "./relay.js";

export interface ServiceDeps {
  log: Logger;
  version: string;
  bootMs: number;
  instance: string;
  fetchImpl?: typeof fetch;
  buildHub?: (o: HubOptions) => HubClient;
  httpPort?: number;
  startHttp?: typeof startHttpServer;
}

export interface Service {
  stop(): Promise<void>;
  leader(): Leader;
  http(): HttpServer;
  targets(): string[];
}

interface TargetRuntime {
  name: string;
  beacon: Beacon;
  relay: Relay;
}

const DEFAULT_HTTP_PORT = 3000;

export function startService(config: Config, deps: ServiceDeps): Service {
  const { log } = deps;
  const startHttp = deps.startHttp ?? startHttpServer;
  let leader: Leader | null = null;
  let http: HttpServer | null = null;
  const isLeader = (): boolean => leader?.isLeader() ?? false;

  const runtimes: TargetRuntime[] = config.targets.map((target) => {
    const beaconLog = log.child({ target: target.name });
    let relay: Relay | null = null;
    const beacon = createBeacon({
      apiBaseUrl: target.apiBaseUrl,
      beaconKey: target.beaconKey,
      hubUrl: target.hubUrl,
      ingestChannel: target.ingestChannel,
      log: beaconLog,
      buildHealth: () =>
        buildHeartbeatHealth({ state: beacon.state, adopted: relay?.adopted() ?? null }),
      buildDebug: () =>
        buildHeartbeatDebug({
          target: target.name,
          state: beacon.state,
          adopted: relay?.adopted() ?? null,
          webhook: (http as HttpServer).stats(),
          relay: (relay as Relay).stats(),
          bootMs: deps.bootMs,
          version: deps.version,
          instance: deps.instance,
          leader: isLeader(),
        }),
      ...(deps.buildHub ? { buildHub: deps.buildHub } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    const store = createStateStore<BeaconDocument>({ rest: beacon.rest, log: beaconLog, empty: () => ({}) });
    relay = createRelay({
      target: target.name,
      beacon,
      store,
      leader: isLeader,
      statePollMs: config.statePollMs,
      log: beaconLog,
    });
    log.info(
      { target: target.name, apiBaseUrl: target.apiBaseUrl, ingestChannel: target.ingestChannel },
      "target configured",
    );
    return { name: target.name, beacon, relay };
  });
  log.info(
    { targets: runtimes.map((r) => r.name), statePollMs: config.statePollMs, deviceIdSet: config.deviceId !== null },
    "particle beacon starting",
  );

  const [first, ...others] = runtimes;
  if (first === undefined) throw new Error("no targets configured");

  http = startHttp({
    port: deps.httpPort ?? DEFAULT_HTTP_PORT,
    secret: config.webhookSecret,
    deviceId: config.deviceId,
    probe: () => ({ configLoaded: true, leaderPolledOnce: leader?.polledOnce() ?? false }),
    onFix: (f) => {
      for (const r of runtimes) r.relay.receive(f);
    },
    log,
  });

  leader = gateOnLeader({
    leader: {
      gatewayInternalUrl: config.gatewayInternalUrl,
      realtimeToken: config.gatewayRealtimeToken,
      forceLeader: config.forceLeader,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    },
    beacon: first.beacon,
    log,
    onStart: () => {
      for (const r of others) r.beacon.start();
      for (const r of runtimes) r.relay.startPolling();
    },
    onStop: async () => {
      for (const r of runtimes) r.relay.stopPolling();
      await Promise.all(others.map((r) => r.beacon.stop()));
    },
  });

  const server = http;
  const gate = leader;
  return {
    async stop(): Promise<void> {
      gate.stop();
      for (const r of runtimes) r.relay.stop();
      await Promise.all(runtimes.map((r) => r.beacon.stop()));
      await server.close();
    },
    leader: () => gate,
    http: () => server,
    targets: () => runtimes.map((r) => r.name),
  };
}
