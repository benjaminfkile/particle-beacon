# particle-beacon

The WMSFO v2 particle beacon: an enrolled beacon whose fixes come from a Particle Tracker One, a cellular GPS puck. Particle Cloud posts each of the puck's `loc` events to this service's webhook; the service normalizes them to the API's location body and posts them to every WMSFO environment it is configured for, dev and prod at once if wanted, each through that environment's own beacon key. A Node and TypeScript service on the fleet behind the gateway with no user interface.

Read `docs/` before touching anything:

- `docs/particle-beacon.md`: this repository's technical design.
- `docs/DESIGN.md`: the design overview for all of v2 (a copy; the original is in `wmsfo-api/docs`).
- `docs/contracts.md`: the shared contracts every component codes against (a copy; wins on any conflict). Section 9 is the beacon contract.

## Run, test, build

Requires Node 22 or newer. `npm ci` installs dependencies.

| Command | What it does |
|---|---|
| `npm test` | Vitest suites for the config, the normalizer, the HTTP surface, the relay, the heartbeat body shape, and the service wiring. |
| `npm run typecheck` | `tsc --noEmit` against `tsconfig.json` (src and tests). |
| `npm run build` | `tsc -p tsconfig.build.json`; emits `dist/` for the container. |
| `npm run dev` | Runs `src/main.ts` under `ts-node`; serves the webhook on port 3000 and posts into whatever targets the environment names (see below). |
| `npm start` | Runs the built service from `dist/`. |
| `npm run contracts:check` | Verifies `contracts/` matches `wmsfo-api` at the pinned `CONTRACTS_SHA`. |
| `npm run beacon:check` | Verifies the vendored `beacon-library` tarball, its recorded SHA-256, and the pinned `BEACON_LIBRARY_SHA` still line up. |
| `npm run check:no-infra` | Fails when a tracked file names real infrastructure or carries a credential. |

## Local recipe (particle-beacon.md 9)

Create `.env.local` at the repo root with one dev target:

```
PB_TARGETS=dev
PB_DEV_API_BASE_URL=https://<dev-api-domain>
PB_DEV_BEACON_KEY=wbk_<the key shown once when the beacon named "particle-tracker" was created in the dev panel>
PB_DEV_HUB_URL=wss://<dev-gateway-domain>/hub
PB_DEV_INGEST_CHANNEL=wmsfo-api-dev:ingest
PB_WEBHOOK_SECRET=<32 or more characters; openssl rand -hex 32>
# PB_DEVICE_ID=<the puck's 24 hex character device id>
PB_GATEWAY_INTERNAL_URL=http://localhost:1
PB_STATE_POLL_MS=1000
PB_LOG_LEVEL=info
PB_FORCE_LEADER=true
```

`PB_GATEWAY_INTERNAL_URL=http://localhost:1` and `PB_FORCE_LEADER=true` let the service run without a gateway: the forced leader never polls `/internal/leader`, so `GATEWAY_REALTIME_TOKEN` is not required in this mode (it is required in every other run; see particle-beacon.md 6). `PB_FORCE_LEADER=true` is refused when `prod` is among the targets.

Load the file and run the dev command, then push the sample fix through:

```
set -a; source .env.local; set +a
npm run dev
# in another shell, with the same environment loaded
node scripts/post-sample.mjs
```

The first post answers `{"ok":true,"accepted":true}` and the fix reaches dev over the hub (falling back to `POST /locations` while the socket is down); a second post of the same fixture answers `accepted: false` with the reason `duplicate`. The dev beacon should be enrolled as a spare, so its rows are stored while an event is live and never published unless someone activates it.

The Particle webhook that feeds the deployed service, and the location settings that decide how often the puck publishes, are in particle-beacon.md 8.
