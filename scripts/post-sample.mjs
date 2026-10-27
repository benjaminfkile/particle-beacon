#!/usr/bin/env node
// Posts tests/fixtures/particle-loc.json to the local webhook with
// PB_WEBHOOK_SECRET as the bearer token and prints "<status> <body>".
// URL overrides the target. Exits 0 on a 2xx, 1 otherwise, and 2 when
// PB_WEBHOOK_SECRET is unset.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.URL ?? "http://localhost:3000/webhook";
const secret = process.env.PB_WEBHOOK_SECRET;

if (!secret) {
  process.stderr.write("post-sample: PB_WEBHOOK_SECRET is not set\n");
  process.exit(2);
}

const body = readFileSync(join(root, "tests/fixtures/particle-loc.json"), "utf8");

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body,
  });
  process.stdout.write(`${res.status} ${await res.text()}\n`);
  process.exit(res.ok ? 0 : 1);
} catch (err) {
  process.stderr.write(`post-sample: request failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
