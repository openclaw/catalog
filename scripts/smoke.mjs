import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const base = new URL(process.argv[2]);
const expectedV1 = await readFile(process.argv[3] ?? "models/v1/catalog.json");
const expectedV2 = await readFile(process.argv[4] ?? "models/v2/catalog.json");
const request = (target, options = {}) => fetch(target, {
  ...options,
  redirect: "manual",
  signal: AbortSignal.timeout(30_000),
});
// assert.deepEqual on multi-megabyte Buffers builds a full diff on mismatch, which
// exhausts the runner's memory and kills it. Compare bytes and report sizes and hashes.
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const assertBytes = (actual, expected, label) => {
  assert.ok(
    actual.equals(expected),
    `${label}: got ${actual.length} bytes sha256 ${digest(actual)}, expected ${expected.length} bytes sha256 ${digest(expected)}`,
  );
};
// Right after a deploy the edge can still serve the previous catalog; wait for the new bytes.
const retryDelayMs = Number(process.env.CATALOG_SMOKE_RETRY_DELAY_MS ?? 10_000);
const fetchDeployed = async (url, expected) => {
  for (let attempt = 1; ; attempt++) {
    const response = await request(url, { headers: { Origin: "https://example.com" } });
    const body = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200 || body.equals(expected) || attempt === 6) {
      return { response, body };
    }
    await sleep(retryDelayMs);
  }
};
const verifyHeaders = (response) => {
  assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("access-control-expose-headers") ?? "", /\betag\b/i);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
};

for (const [path, expected] of [
  ["/models/v1/catalog.json", expectedV1],
  ["/models/catalog.json", expectedV1],
  ["/models/v2/catalog.json", expectedV2],
]) {
  const url = new URL(path, base);
  const { response, body } = await fetchDeployed(url, expected);
  assert.equal(response.status, 200, "catalog GET");
  verifyHeaders(response);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json;\s*charset=utf-8$/i);
  assertBytes(body, expected, `${path} deployed catalog bytes`);
  const etag = response.headers.get("etag");
  assert.ok(etag, "native ETag");

  const head = await request(url, { method: "HEAD", headers: { Origin: "https://example.com" } });
  assert.equal(head.status, 200, "catalog HEAD");
  verifyHeaders(head);
  assert.equal(head.headers.get("etag"), etag, "HEAD ETag");
  assert.equal(head.headers.get("content-type"), response.headers.get("content-type"), "HEAD content type");
  assert.equal((await head.arrayBuffer()).byteLength, 0, "HEAD body");

  const conditional = await request(url, { headers: { "If-None-Match": etag, Origin: "https://example.com" } });
  assert.equal(conditional.status, 304, "unchanged catalog revalidation");
  verifyHeaders(conditional);
  assert.equal((await conditional.arrayBuffer()).byteLength, 0, "304 body");

  // OpenClaw sends both validators. ETag must win when the date suggests freshness.
  const changed = await request(url, { headers: {
    "If-None-Match": '"not-the-current-catalog"',
    "If-Modified-Since": "Fri, 31 Dec 9999 23:59:59 GMT",
    Origin: "https://example.com",
  } });
  assert.equal(changed.status, 200, "nonmatching ETag takes precedence over date");
  verifyHeaders(changed);
  assertBytes(Buffer.from(await changed.arrayBuffer()), expected, `${path} revalidated catalog bytes`);
}

for (const path of ["/missing.json", "/README.md", "/.git/config", "/_headers"]) {
  const missing = await request(new URL(path, base));
  assert.equal(missing.status, 404, `${path} must not be published`);
  await missing.body?.cancel();
}
console.log(`Catalog smoke passed: ${base} (all three catalog URLs).`);
