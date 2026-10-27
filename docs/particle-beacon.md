# Particle beacon: technical design

The particle beacon is an ordinary enrolled beacon (contracts 9) whose fixes come from a Particle Tracker One, a cellular GPS puck. The puck publishes a `loc` event to Particle Cloud over LTE; a Particle webhook posts that event to this service; the service normalizes it into the location body of contracts 4.2 and posts it, over the hub with the HTTP fallback every beacon has, to every WMSFO environment it is configured for. One puck can feed both dev and prod: the service holds one beacon key per target environment and is, to each API, one more enrolled beacon. It heartbeats every 15 s per target with the puck's battery as `health.batteryPercent`, the age of the last accepted fix as `health.lastFixAgeS`, and the webhook and device statistics as its `debug` object. It has no user interface; the admin panel's beacon page is its whole face. It runs on the fleet behind the gateway as a manifest service.

Every name, shape, path, and rule below is the one in the shared contracts (`docs/contracts.md`); the contract wins on any difference. Choices this document makes are in section 11; choices that need the owner are in section 12.

---

## 1. Shape

| Piece | Choice |
|---|---|
| Runtime | Node 22, TypeScript strict, ES modules, `beacon-library` (the beacon core, the leader monitor, the state store), native `fetch`, `node:http` for the two routes, `pino` logging (JSON lines); no database |
| Container | `node:22-alpine`, port 3000, `GET /api/health` and `POST /webhook`; deployed exactly like the legacy beacon (platform.md 3.6, 9.2a) |
| Tests | Vitest for the config, the normalizer, the HTTP surface, the relay, the heartbeat body, and the service wiring; a soak note like the legacy beacon's |
| Repository | `particle-beacon`, branches `grunt`, `dev`, `main`; `contracts/` vendored with `CONTRACTS_SHA` and a contracts check (contracts 13); `beacon-library` vendored with `BEACON_LIBRARY_SHA` |

```
particle-beacon/
  package.json  tsconfig.json  tsconfig.build.json  vitest.config.ts  Dockerfile
  CONTRACTS_SHA  contracts/  scripts/check-contracts.mjs
  BEACON_LIBRARY_SHA  vendor/  scripts/check-beacon-library.mjs  scripts/check-no-infra.mjs
  scripts/post-sample.mjs       posts the sample webhook body to a running service (section 9)
  docs/particle-beacon.md  docs/DESIGN.md  docs/contracts.md  docs/README.md  docs/soak/README.md
  src/
    main.ts                     boot: config, logger, hand off to service.ts
    service.ts                  wires the HTTP surface, one relay and one beacon core per target, and the leader gate (section 2)
    config.ts                   the PB_* keys, validated (section 6)
    http.ts                     GET /api/health and POST /webhook (section 4)
    particle/
      normalize.ts              the Particle webhook body to a LocationBody plus device metadata (section 3)
    relay.ts                    the latest fix from the receiving node to the leader through the target's state document (section 5)
    heartbeat.ts                the heartbeat body per target: the health core and the debug object (section 5a)
  tests/
    fixtures/particle-loc.json  a Particle webhook body in the custom template format (anonymised)
```

The beacon core, the leader monitor, and the state store come from the `beacon-library` package: its tarball ships in `vendor/`, `BEACON_LIBRARY_SHA` pins the library commit it was packed from, and `scripts/check-beacon-library.mjs` verifies the tarball, the recorded SHA-256, and the pinned commit id on every verification run.

---

## 2. What it does

1. Boots, verifies configuration, builds one beacon (`createBeacon`) and one state store per target, starts polling `GET /internal/leader` (every 2 s, 1 s timeout, leader only while the latest answer is `2xx`, `isLeader`, and `evaluatedAt` under 90 s old; `PB_FORCE_LEADER=true` for local runs, refused when `prod` is a target).
2. Every node serves `GET /api/health` and `POST /webhook` on port 3000 (section 4).
3. Particle Cloud posts every `loc` event of the puck to `https://<gateway-domain>/particle-beacon/webhook` with `Authorization: Bearer <PB_WEBHOOK_SECRET>`. The gateway strips the service prefix, so the container sees `POST /webhook`. The load balancer picks the node; any node may receive it.
4. The receiving node checks the secret, normalizes the body (section 3), answers Particle at once, and then relays the fix (section 5): it writes the fix as `latestFix` into each target's state document, and, when this node is the leader, also hands the fix to each target's send loop immediately.
5. The leader runs, per target, the beacon core (socket loop, send loop, heartbeat loop) and the relay's state poll: every `PB_STATE_POLL_MS` (1000) it reads the target's state document and adopts a `latestFix` it has not sent yet. A node that loses leadership stops its state polls and beacon cores within a poll; the new leader starts them. Two leaders for a loop during a hand-off post the same point twice, which the API carries as a repeat; harmless.
6. Heartbeats go every 15 s per target from the leader only; `health.batteryPercent` is the puck's battery from the last accepted fix, `health.lastFixAgeS` the age of the fix this target last adopted, `health.socketState` the socket's state; `debug` is section 5a.

A target is one WMSFO environment: an API base URL, a hub URL, an ingest channel, and the `wbk_` key of the beacon named `particle-tracker` in that environment's panel. Targets are independent: one API being down, or one beacon being revoked, changes nothing for the other.

---

## 3. The source and the normalizer

**The webhook body.** Particle delivers a webhook in one of two shapes. The custom template this service documents (section 8) sends the event payload as an object:

```json
{ "event": "loc", "deviceId": "<24 hex characters>", "publishedAt": "2026-10-27T20:29:38.164Z", "payload": { "...the Tracker payload..." } }
```

Particle's default format sends it as a JSON string, with other key names:

```json
{ "event": "loc", "data": "{\"cmd\":\"loc\",...}", "coreid": "<24 hex characters>", "published_at": "2026-10-27T20:29:38.164Z" }
```

The normalizer accepts both: `event` or `name`; `deviceId`, `coreid`, or `device_id`; `publishedAt` or `published_at`; `payload` as an object, or `data` as an object or a JSON string. Any other top-level key is ignored.

**The Tracker payload** (Tracker Edge firmware, as observed on 2026-10-27; `towers` and `wps` are present only when the product publishes tower and Wi-Fi data):

```json
{ "cmd": "loc", "time": 1793132968,
  "loc": { "lck": 1, "time": 1793132969, "lat": 46.8721, "lon": -113.994, "alt": 975.72, "hd": 328.64, "spd": 0.06,
           "h_acc": 13, "hdop": 1.8, "v_acc": 15, "vdop": 100, "cell": 70, "batt": 97.8, "temp": 20.5 },
  "trig": ["time"], "towers": [ { "rat": "lte", "str": -86 } ], "wps": [ { "bssid": "...", "ch": 8, "str": -31 } ], "req_id": 22 }
```

`loc.time` and `time` are epoch seconds; `loc.spd` is metres per second; `loc.alt` and `loc.h_acc` are metres; `loc.hd` is degrees clockwise from north; `loc.lck` is 1 for a GPS fix and 0 for a position from cell towers or Wi-Fi; `loc.batt` and `loc.cell` are percentages; `req_id` counts publishes per device and restarts at 1 when the puck reboots.

**Normalizer** (`normalize.ts`, pure, unit tested against the fixture): `normalize(body: unknown, opts: { receivedAtMs: number; deviceId: string | null; lastKey: string | null })` returns `{ ok: true, fix, meta, key }` or `{ ok: false, reason }`.

| Output | From | Rule |
|---|---|---|
| `lat` | `loc.lat` | a finite number within -90 to 90, else `no usable position` |
| `lng` | `loc.lon` (the Tracker field is `lon`) | a finite number within -180 to 180, else `no usable position` |
| `recordedAt` | `loc.time`, else `time`, else `publishedAt` | epoch seconds when a finite number above 0, rendered RFC 3339 UTC with three fractional digits; else the publish time when it parses; else the receipt time |
| `speedMps` | `loc.spd` | the number when finite and within 0 to 500, else null |
| `altitudeM` | `loc.alt` | the number when finite and within -500 to 20000, else null |
| `headingDeg` | `loc.hd` | the number when finite, within 0 to 360, and `loc.spd` is a finite number of at least 1; else null. A GPS heading is meaningful only while moving, and a parked puck repeats its last heading; without one the API derives the heading from movement (contracts 7.2) |
| `accuracyM` | `loc.h_acc` | the number when finite and within 0 to 100000, else null |

A body that is not a fix (`ok: false`, each with the reason the statistics count under):

| Reason | When |
|---|---|
| `ignored event` | `event` is anything but `loc` (`loc-enhanced`, the cloud's refined copy, among them: a webhook on `loc` receives it too because Particle matches event names by prefix) |
| `other device` | `opts.deviceId` is set and the body's device id differs |
| `no payload` | the payload is missing, not an object, not parseable from its string form, or has no `loc` object |
| `no gps lock` | `loc.lck` is not the number 1: a cell or Wi-Fi position can be hundreds of metres off and would move the tracker across town |
| `no usable position` | `lat` or `lng` missing or out of range |
| `duplicate` | `key` equals `opts.lastKey`: Particle retries deliveries, and the same event may arrive twice |

`key` is `<deviceId>:<req_id>:<loc.time>` (`-` for a missing part); the caller keeps the last accepted key. `meta` is `{ deviceId, event, reqId, publishedAt, deviceTime, batteryPercent, cellPercent, temperatureC, gpsLock, hAccuracyM, hdop, triggers, towers, wps }` with `batteryPercent` the rounded `loc.batt` clamped to 0 to 100 (null when absent), `deviceTime` the RFC 3339 rendering of `loc.time` (null when absent), `towers` and `wps` the counts of those arrays (never their contents: the heartbeat body is capped at 32 KB and the contents name third-party radios), and every other value null when absent.

---

## 4. The HTTP surface

One `node:http` server on port 3000, `Cache-Control: no-store` on every answer, the contracts error shape (0.3) on every error, no other route (404).

**`GET /api/health`.** `503 { "code": "unavailable", "message": "starting up", "details": null, "requestId": "" }` until the config has loaded and the leader poll has run once; `200 { "status": "ok" }` afterwards, leader or follower.

**`POST /webhook`.** The Particle webhook's door.

| Step | Rule |
|---|---|
| Auth | `Authorization: Bearer <PB_WEBHOOK_SECRET>`, compared in constant time (`crypto.timingSafeEqual` over equal-length buffers). Missing or wrong: `401 { "code": "unauthenticated", ... }`, counted under `rejectedAuth`, logged at warn at most once a minute. This is the one non-2xx Particle sees, so a webhook with a wrong secret shows errors in the Particle Console instead of silently feeding nothing |
| Body | read up to 64 KB; beyond that `413 { "code": "payload_too_large", ... }` and the connection is closed. The `Content-Type` header is not checked |
| Not JSON | `200 { "ok": true, "note": "body was not valid JSON; ignored" }`, counted under `badBody`, logged at warn. The Particle Console's Test button sends the literal text `test-event` |
| JSON | `normalize` (section 3); `200 { "ok": true, "accepted": true }` or `200 { "ok": true, "accepted": false, "reason": "<reason>" }` |
| Timing | the answer is written before the relay runs; nothing awaits a network call inside the request. Particle counts slow and failing answers as webhook errors and throttles a webhook that keeps failing |
| Logs | an accepted fix at debug with `{ deviceId, reqId, lat, lng, speedMps, accuracyM }`; a rejected body at info with its reason; the secret, the full body, and the `Authorization` header never reach a log line |

The server keeps `WebhookStats`: `requestsTotal`, `accepted`, `rejectedAuth`, `badBody`, `ignoredEvents`, `otherDevice`, `noPayload`, `noLock`, `invalid` (`no usable position`), `duplicates`, `lastReceivedAt`, `lastAcceptedAt`, `lastReason`, `lastDeviceId`, `lastEvent`, `lastReqId`, `lastTriggers`, `lastMeta`, and `lastPayload` (the last payload object with `towers` and `wps` replaced by their counts). Statistics are per node: a fix received by a follower is counted on that follower, not on the leader whose heartbeat reports them (section 5a).

---

## 5. The relay

The webhook lands on whichever node the load balancer picks, while the beacon core runs on the leader only (platform.md 3.6). The state document each beacon has on the API (contracts 4.2 and 9.5) is the one channel a beacon has between nodes, and it already carries a version and a conflict rule, so it carries the latest fix. `relay.ts` is `createRelay({ target, beacon, store, leader: () => boolean, statePollMs, log, now? })` returning `{ receive(fix, meta, key, receivedAtMs): void, startPolling(): void, stopPolling(): void, stop(): void, stats(): RelayStats }`, one per target.

**The document.** This beacon's part is `latestFix`; any other top-level key is kept as it is on every write:

```json
{ "latestFix": { "key": "<deviceId>:<req_id>:<loc.time>", "receivedAt": "2026-10-27T20:29:38.396Z", "publishedAt": "2026-10-27T20:29:38.164Z",
                 "fix": { "lat": 46.8721, "lng": -113.994, "recordedAt": "...", "speedMps": 0.06, "altitudeM": 975.72, "headingDeg": null, "accuracyM": 13 },
                 "meta": { "...section 3 meta..." } } }
```

**Receiving** (`receive`, on every node). When this node is the leader for this target: `setLatestFix(beacon.state, fix)` and `beacon.wake()` at once, and the key is remembered as adopted, so the poll below never sends the same fix twice. Then, leader or not, the fix is written to the document through `store.update((doc) => { doc.latestFix = ... })`. Writes are serialized by the store's own queue; while one is in flight the newest received fix waits as the one pending write (a fix arriving before it starts replaces it: nothing is queued, the newest wins, contracts 9.2), and the pending one is written when the in-flight write settles. A write that fails, conflicts exhausted included, is logged at warn (`fix relay write failed`, with `{ target, code, status }`), counted, and dropped; the next fix carries the document forward. A write never blocks the HTTP answer.

**Polling** (`startPolling`, leader only). Every `statePollMs`, `store.load()`; when the document carries a `latestFix` whose `key` differs from the last adopted key and whose `receivedAt` is not older than the last adopted one, `setLatestFix` and `wake`, and the key becomes the adopted one. A load that fails is logged at warn once a minute (`fix relay read failed`) and counted; the next tick tries again. `GET /beacons/me/state` does not stamp `last_seen_at` and may be read several times a second (contracts 4.2). On a follower the hop adds at most `statePollMs`; on the leader it adds nothing. The poll starts from the leader gate's `onStart` and stops from `onStop`, after a `store.load()` so a new leader adopts the fix the old one may have missed.

`RelayStats`: `{ statePollMs, polls, pollsFailed, adopted, writes, writesFailed, lastAdoptedAt, lastAdoptedKey, lastWriteAt, lastWriteError, lastReadError }`.

---

## 5a. The heartbeat's debug object

Per target, built by `buildHeartbeatHealth` and `buildHeartbeatDebug` in `heartbeat.ts`:

```json
{
  "target": "dev",
  "webhook": { "path": "/webhook", "requestsTotal": 120, "accepted": 118, "rejectedAuth": 0, "badBody": 1, "ignoredEvents": 0, "otherDevice": 0, "noPayload": 0, "noLock": 1, "invalid": 0, "duplicates": 0,
               "lastReceivedAt": "...", "lastAcceptedAt": "...", "lastReason": null, "lastDeviceId": "e00f...", "lastEvent": "loc", "lastReqId": 22, "lastTriggers": ["time"], "lastPayload": { "...the raw payload, towers and wps as counts..." } },
  "device": { "deviceId": "e00f...", "batteryPercent": 98, "cellPercent": 70, "temperatureC": 20.5, "gpsLock": true, "hAccuracyM": 13, "hdop": 1.8, "deviceTime": "...", "publishedAt": "...", "cloudLagMs": 232 },
  "normalized": { "lat": 46.8721, "lng": -113.994, "speedMps": 0.06, "altitudeM": 975.72, "headingDeg": null, "accuracyM": 13, "recordedAt": "..." },
  "relay": { "statePollMs": 1000, "polls": 3600, "pollsFailed": 0, "adopted": 118, "writes": 118, "writesFailed": 0, "lastAdoptedAt": "...", "lastAdoptedKey": "...", "lastWriteAt": "...", "lastWriteError": null, "lastReadError": null },
  "transport": { "socketState": "connected", "reconnectCount": 0, "httpFallbackSeconds": 0, "lastReceiptLatencyMs": 88, "sendsFailedSinceBoot": 0 },
  "process": { "uptimeS": 3600, "leader": true, "instance": "i-...", "version": "0.1.0", "node": "v22.x" }
}
```

`health` is `{ batteryPercent, lastFixAgeS, socketState }`: the battery from the meta of the fix this target last adopted (null before any), the age in seconds of that fix's `receivedAt`, and the socket's state. `device`, `normalized`, and `cloudLagMs` (`receivedAt` minus `publishedAt`) come from the same adopted fix; `webhook` is this node's statistics (section 4). The panel renders the tree; nothing in it is read by anything.

---

## 6. Configuration

Flat JSON secret, one for the service (platform.md 3.6), every key required unless marked:

| Key | Value |
|---|---|
| `PB_TARGETS` | comma-separated target names, each `dev` or `prod`, at least one, no repeats; `dev,prod` to feed both |
| `PB_<TARGET>_API_BASE_URL` | per target, `<TARGET>` upper case (`PB_DEV_API_BASE_URL`, `PB_PROD_API_BASE_URL`): that environment's WMSFO API, `https://<api-domain>` |
| `PB_<TARGET>_BEACON_KEY` | the `wbk_` key of the beacon named `particle-tracker` in that environment's panel |
| `PB_<TARGET>_HUB_URL`, `PB_<TARGET>_INGEST_CHANNEL` | `wss://<gateway-domain>/hub`, `<service>:ingest` (`wmsfo-api-dev:ingest` for dev, `wmsfo-api:ingest` for prod) |
| `PB_WEBHOOK_SECRET` | the shared secret the Particle webhook sends as a bearer token; 32 characters or more |
| `PB_DEVICE_ID` (optional) | the puck's Particle device id, 24 hex characters; when set, events from any other device are ignored |
| `PB_GATEWAY_INTERNAL_URL` | `http://<docker-bridge-ip>:8080` |
| `PB_STATE_POLL_MS` | `1000` (250 to 10000) |
| `PB_LOG_LEVEL` | `info` |
| `PB_FORCE_LEADER` (optional) | local only; refused when `prod` is among the targets |
| `GATEWAY_REALTIME_TOKEN` | injected by the gateway; used only for `/internal/leader`. Required when `PB_FORCE_LEADER` is false (its only reader); a forced leader never polls that endpoint, so the token is optional in that mode |

The app fails fast on a missing or invalid key, printing the key names and never a value. Keys of a target not named in `PB_TARGETS` are ignored.

---

## 7. Deployment

One manifest entry, `particle-beacon`: there is one puck, and the service posts to both environments itself, so there is no `-dev` twin. Image `particle-beacon:<sha>`, port 3000, secret per section 6, `includeInHealth` true, no realtime fields (platform.md 3.6). The service's public path is `https://<gateway-domain>/particle-beacon`, the gateway path form the simulator's control API also uses; the webhook URL is that path plus `/webhook`.

Workflows: none until the service is first deployed (the operator's rule for undeployed repositories). When it is, `.github/workflows/ci.yml` and `deploy.yml` are the legacy beacon's with the names changed, the deploy gated on a push to `main` (the one branch that deploys this service), image tag `<sha>`, environment `prod`.

First run: create the beacon `particle-tracker` in each target environment's panel and copy its key from the create response (shown once); write the secret; upsert the manifest entry from the dashboard; add the workflows and deploy; create the Particle webhook (section 8); activate the beacon in the panel when the puck should drive the site. Until a beacon is activated its rows are stored while an event is live and never published, so the puck can fly as a spare beside Red-Nose.

---

## 8. The Particle side

Everything the puck's operator configures lives in the Particle Console, under the **product** that holds the Tracker One (a webhook in a personal sandbox never sees product events). Integrations, add a webhook, custom template:

```json
{
  "name": "WMSFO particle-beacon",
  "event": "loc",
  "url": "https://<gateway-domain>/particle-beacon/webhook",
  "requestType": "POST",
  "noDefaults": true,
  "rejectUnauthorized": true,
  "headers": { "Authorization": "Bearer <PB_WEBHOOK_SECRET>" },
  "json": "{\"event\":\"{{{PARTICLE_EVENT_NAME}}}\",\"deviceId\":\"{{{PARTICLE_DEVICE_ID}}}\",\"publishedAt\":\"{{{PARTICLE_PUBLISHED_AT}}}\",\"payload\":{{{PARTICLE_EVENT_VALUE}}}}"
}
```

`{{{PARTICLE_EVENT_VALUE}}}` stays unquoted with triple braces so the Tracker JSON arrives as an object; the Console's editor flags the template as invalid JSON before rendering, and it saves and works. The default format (`noDefaults` false, no `json`) works too (section 3).

Location settings (product, Configuration, Location; a device-level configuration can override them): the radius trigger off (0) or small, the maximum update frequency as low as the puck sustains for the flight (the setting is the floor between publishes, in seconds; `0` means no floor), the minimum update frequency the longest gap acceptable while parked, enhanced location off (the service posts only GPS fixes, and the refinement costs a second event). Every publish is one Particle data operation; the plan's monthly allowance bounds the interval. The sample this design was built from published every 60 s with `trig: ["time"]`, GPS lock on every point, 8 to 33 m horizontal accuracy, and about 0.2 s from publish to webhook delivery.

---

## 9. Local development

`.env.local` carries one dev target with `PB_FORCE_LEADER=true` and `PB_GATEWAY_INTERNAL_URL=http://localhost:1`; `npm run dev` runs the service on port 3000 against dev. `node scripts/post-sample.mjs` posts `tests/fixtures/particle-loc.json` to `http://localhost:3000/webhook` with `PB_WEBHOOK_SECRET` from the environment (`URL` overrides the target) and prints the answer, so a fix can be pushed through the whole pipeline without a puck; a second run of the same fixture answers `accepted: false, reason: duplicate`.

---

## 10. Tests

| Suite | Covers |
|---|---|
| `config` | every `PB_*` key validated; `PB_TARGETS` parsing (one, two, unknown name, repeat, empty); per-target keys required only for named targets; missing keys named but not valued; `PB_FORCE_LEADER=true` refused with a prod target and accepted with dev only; `GATEWAY_REALTIME_TOKEN` optional under a forced leader; the webhook secret's minimum length; `PB_DEVICE_ID` shape; `PB_STATE_POLL_MS` bounds |
| `normalize` | the fixture in both webhook formats; `lon` not `lng`; `loc.time` seconds to RFC 3339 and the `time` and `publishedAt` fallbacks; speed, altitude, accuracy passed through within range and null outside; heading kept at 1 m/s and above and null below; `lck` 0 is `no gps lock`; `loc-enhanced` is `ignored event`; another device with `PB_DEVICE_ID` set is `other device`; a string `data` payload parses and a broken one is `no payload`; the same key twice is `duplicate`; `meta` counts towers and wps without their contents; the output validates against the vendored `location.schema.json` |
| `http` | health 503 then 200; a wrong, missing, and right bearer; constant-time comparison (equal and unequal lengths); a body over 64 KB is 413; non-JSON is 200 with the note; an accepted and a rejected fix answer as specified; the answer is written before the receive callback resolves; 404 elsewhere; statistics; no log line carries the secret or the header |
| `relay` | over the library's fake REST: `receive` on a follower writes `latestFix` and nothing reaches the beacon state; `receive` on the leader sets the latest fix at once and the following poll does not adopt it again; a second fix during an in-flight write replaces the pending one and is written once the first settles; a failed write is counted and dropped; the poll adopts a document written by another node once and only once, ignores an older `receivedAt`, and keeps other top-level keys through writes; `stopPolling` ends the ticks |
| `heartbeat` | `health` from the adopted fix (battery, age, socket state), null before any fix; the `debug` tree; the whole body validates against the vendored `heartbeat.schema.json` |
| `service.wiring` | two targets: a webhook on a follower writes both state documents and sends nothing over either hub; on the leader it reaches both fake hubs and both documents; a document written elsewhere is adopted by the leader's poll within one tick; leadership lost stops the polls and the cores; health reports 200 once the leader poll ran |
| Soak (dev) | 24 h with a dev target against the dev API, the beacon a spare: heartbeat gap never over 60 s, every webhook delivery accepted or counted, no process restart; recorded under `docs/soak/<date>.md` |

The beacon core's own suites (socket loop, send loop, heartbeat loop, hub, leader, state store) live in the `beacon-library` repository and run there; this repository trusts the vendored library and does not re-test its behaviour.

---

## 11. Decisions made here

- One service with one secret feeds every target environment, because there is one puck and dev needs to see it too; to each API it is one ordinary beacon with one key, and the APIs never learn about Particle (the operator, 2026-10-27).
- The fix travels from the receiving node to the leader through the beacon's state document, polled once a second, because the webhook lands on any node and the core runs on the leader only; the document is the channel the contracts already give a beacon between nodes.
- A position without a GPS lock is not posted. A cell or Wi-Fi position can be hundreds of metres off.
- The heading is sent only while the puck moves at 1 m/s or faster; otherwise the API derives it. A parked puck repeats its last heading.
- Only `loc` is a fix; `loc-enhanced` is counted and ignored. The refinement helps indoors, where the puck will not be, and would make every point arrive twice.
- A delivery whose device id, `req_id`, and `loc.time` equal the last accepted one is a duplicate. Particle retries deliveries.
- Particle gets `200` for every body it sends, parseable or not, except a bad secret (`401`), so a misconfigured webhook is visible in the Particle Console and a healthy one is never throttled.
- Webhook statistics are per node; the leader's heartbeat shows its own counters and the relay's adopted count shows the fleet-wide picture.
- No workflows until the service is deployed.

## 12. Needs a decision

- The publish interval during the flight and the Particle plan's data operation allowance (the operator with the puck's owner).
- Whether the puck should keep publishing while parked between flights (the minimum update frequency), given that every fix during a live event is stored.
