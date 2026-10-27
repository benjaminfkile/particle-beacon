# Soak drill: 24 h against dev

particle-beacon.md 10 asks for a 24 h soak of the particle beacon with a dev target against the dev API, the beacon a spare, checking that the heartbeat gap stays under 60 s, every webhook delivery is accepted or counted under a reason, and the process never restarts. Copy this file to `<date>.md` for each run and fill it in.

## Template

Copy to `docs/soak/YYYY-MM-DD.md` and record the drill as it runs.

```
# Soak, YYYY-MM-DD (dev, spare)

Environment:
- Targets: dev
- API base URL: https://<dev-api-domain>
- Hub URL: wss://<dev-gateway-domain>/hub
- Beacon: particle-tracker (wbk_...), enrolled as a spare (not active)
- Puck publish interval: ___ s (the product's maximum update frequency)
- Started at: YYYY-MM-DDTHH:MM:SSZ
- Ended at:   YYYY-MM-DDTHH:MM:SSZ
- Runner: <name>
- Container image: particle-beacon:<sha>
- Host: <fleet node id>

Windows watched (panel + logs):
- Heartbeat gap (max seen): ___ s (target: < 60 s)
- Webhook deliveries (Particle Console integration log): ___
- webhook.accepted + relay.adopted over the fleet: ___ (expect one per delivery; followers count accepted, the leader counts adopted)
- rejectedAuth: 0 (any value fails the drill; the secret is wrong somewhere)
- badBody, noLock, duplicates, ignoredEvents: ___ / ___ / ___ / ___
- relay.writesFailed, relay.pollsFailed: ___ / ___
- Socket reconnects: ___ (target: < 5, excluding gateway re-auth every ~15 min)
- httpFallbackSeconds accrued: ___ s
- Process restarts: 0 (any restart fails the drill; note the reason)
- sendsFailedSinceBoot (while live): ___ (target: 0 while dev has no live event)

Panel checks (start, +6 h, +12 h, +24 h):
- Beacon row shows heartbeats with the puck's payload in the debug tree and a battery value.
- Health colouring: green while the puck publishes (socket connected, lastFixAgeS under the publish interval, battery above 20).
- No stale-since flag; no revoked banner.

Incidents (with UTC timestamps):
- (none)   or   HH:MM:SS reason, mitigation, whether it self-recovered.

Verdict: pass / fail. Reasons:
```

## When to run

- Before the first prod target is added to the secret.
- After any change to `normalize.ts`, `http.ts`, `relay.ts`, or the vendored beacon library.
- Before every operational season, on the live dev stack the site points at.

## Notes

- The dev event should be off (`status_id` != 3) for most of the drill so the send loop only sees `409 no_live_event`, which does not count against `sendsFailedSinceBoot` (contracts 9.2). Flipping dev live for a short window is fine and useful; log the window.
- A parked puck keeps publishing on its minimum update frequency; `lastFixAgeS` grows to that interval between publishes and the panel's "no fix for 30 s" colour is expected when the interval is longer than that.
- A single rejected body is not an incident. A minute of `rejectedAuth`, a heartbeat gap above 60 s, or any process restart, is.
