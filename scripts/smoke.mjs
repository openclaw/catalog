import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = new URL(process.argv[2]);
const expectedV1 = await readFile(process.argv[3] ?? "models/v1/catalog.json");
const expectedV2 = await readFile(process.argv[4] ?? "models/v2/catalog.json");
const request = (target, options = {}) => fetch(target, {
  ...options,
  redirect: "manual",
  signal: AbortSignal.timeout(30_000),
});
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
  const response = await request(url, { headers: { Origin: "https://example.com" } });
  assert.equal(response.status, 200, "catalog GET");
  verifyHeaders(response);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json;\s*charset=utf-8$/i);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, "deployed catalog bytes");
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
  assert.deepEqual(Buffer.from(await changed.arrayBuffer()), expected, "revalidated catalog bytes");
}

for (const path of ["/missing.json", "/README.md", "/.git/config", "/_headers"]) {
  const missing = await request(new URL(path, base));
  assert.equal(missing.status, 404, `${path} must not be published`);
  await missing.body?.cancel();
}
console.log(`Catalog smoke passed: ${base} (all three catalog URLs).`);
