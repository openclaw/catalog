import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const build = fileURLToPath(new URL("build.mjs", import.meta.url));
const smoke = fileURLToPath(new URL("smoke.mjs", import.meta.url));
const headersFile = new URL("../static/_headers", import.meta.url);
const catalog = Buffer.from('{"providers":[]}\n');
const catalogV2 = Buffer.from(JSON.stringify({
  schemaVersion: 2,
  generatedAt: 1753500000000,
  sourceCommit: "fixture",
  providers: { example: { defaultModel: "model" } },
  models: [{ id: "model", provider: "example", input: ["text"], pricing: { status: "unknown" } }],
}) + "\n");
const catalogV3 = Buffer.from(JSON.stringify({
  ...JSON.parse(catalogV2),
  schemaVersion: 3,
  models: [...JSON.parse(catalogV2).models, {
    id: "decision-only", provider: "example", pricing: { status: "unknown" },
    inference: { chat: false, decision: { protocol: "example-decisions", input: ["text"] } },
  }],
}) + "\n");
const expectedCatalogs = new Map([
  ["/models/v1/catalog.json", catalog],
  ["/models/catalog.json", catalog],
  ["/models/v2/catalog.json", catalogV2],
  ["/models/v3/catalog.json", catalogV3],
]);
const catalogPaths = [...expectedCatalogs.keys()];

test("published generations keep Decision capabilities out of legacy feeds", async () => {
  const bundles = await Promise.all([1, 2, 3].map(async (version) => {
    const bundle = JSON.parse(await readFile(new URL(`../models/v${version}/catalog.json`, import.meta.url), "utf8"));
    assert.equal(bundle.schemaVersion, version);
    return bundle;
  }));
  const [v1, v2, v3] = bundles;
  for (const bundle of bundles.slice(1)) {
    assert.equal(bundle.sourceCommit, v1.sourceCommit, "one upstream source snapshot");
    assert.equal(bundle.generatedAt, v1.generatedAt, "one generation");
  }
  const legacyModels = [
    Object.entries(v1.providers).flatMap(([provider, entry]) => entry.models.map((model) => ({ ...model, provider }))),
    v2.models,
  ];
  const decisionOnly = v3.models.filter((model) => model.inference?.chat === false);
  assert.ok(v3.models.some((model) => model.inference?.decision), "v3 retains Decision capabilities");
  for (const models of legacyModels) {
    const keys = new Set(models.map((model) => `${model.provider}/${model.id}`));
    for (const model of models) {
      assert.equal(model.inference, undefined, "legacy model shape");
      assert.ok((model.input ?? []).every((input) => ["text", "image", "document"].includes(input)), "legacy modalities");
    }
    for (const model of decisionOnly) {
      assert.ok(!keys.has(`${model.provider}/${model.id}`), "Decision-only models stay opt-in");
    }
  }
});

test("all catalog URLs have the same exact-path header policy", async () => {
  const rules = (await readFile(headersFile, "utf8")).trim().split("\n\n");
  const policies = rules.map((rule) => rule.split("\n"));
  assert.deepEqual(policies.map(([path]) => path), catalogPaths);
  for (const policy of policies.slice(1)) {
    assert.deepEqual(policy.slice(1), policies[0].slice(1));
  }
});

test("preview cannot claim production routes or introduce request-time code", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.routes, [{ pattern: "catalog.openclaw.ai", custom_domain: true }]);
  assert.deepEqual(config.env.preview.routes, []);
  assert.equal(config.assets.directory, "./dist");
  assert.equal(config.assets.not_found_handling, "none");
  assert.equal(config.main, undefined);
  assert.equal(config.assets.binding, undefined);
  assert.equal(config.assets.run_worker_first, undefined);
});

function run(script, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env } });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("staging preserves bytes and excludes old output and repository files", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "catalog-build-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "models/v1"), { recursive: true });
  await mkdir(join(cwd, "models/v2"), { recursive: true });
  await mkdir(join(cwd, "models/v3"), { recursive: true });
  await mkdir(join(cwd, "static"));
  await mkdir(join(cwd, "dist"));
  await writeFile(join(cwd, "models/v1/catalog.json"), catalog);
  await writeFile(join(cwd, "models/v2/catalog.json"), catalogV2);
  await writeFile(join(cwd, "models/v3/catalog.json"), catalogV3);
  await writeFile(join(cwd, "static/_headers"), await readFile(headersFile));
  await writeFile(join(cwd, "dist/stale.json"), "old output");
  await writeFile(join(cwd, "README.md"), "not a public asset");
  const result = await run(build, [], cwd);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual((await readdir(join(cwd, "dist"), { recursive: true })).sort(), [
    "_headers", "models", "models/catalog.json", "models/v1", "models/v1/catalog.json",
    "models/v2", "models/v2/catalog.json",
    "models/v3", "models/v3/catalog.json",
  ]);
  for (const [path, expected] of expectedCatalogs) {
    assert.deepEqual(await readFile(join(cwd, "dist", path)), expected);
  }
  const refreshed = Buffer.from('{"providers":[{"id":"example"}]}\n');
  const refreshedV2 = Buffer.from(JSON.stringify({
    ...JSON.parse(catalogV2), generatedAt: 1753500000001,
  }) + "\n");
  const refreshedV3 = Buffer.from(JSON.stringify({
    ...JSON.parse(catalogV3), generatedAt: 1753500000001,
  }) + "\n");
  await writeFile(join(cwd, "models/v1/catalog.json"), refreshed);
  await writeFile(join(cwd, "models/v2/catalog.json"), refreshedV2);
  await writeFile(join(cwd, "models/v3/catalog.json"), refreshedV3);
  assert.equal((await run(build, [], cwd)).code, 0);
  const refreshedCatalogs = new Map(catalogPaths.map((path) => [
    path, path.includes("/v3/") ? refreshedV3 : path.includes("/v2/") ? refreshedV2 : refreshed,
  ]));
  for (const path of catalogPaths) {
    assert.deepEqual(await readFile(join(cwd, "dist", path)), refreshedCatalogs.get(path));
  }
  for (const version of ["v1", "v2", "v3"]) {
    const source = join(cwd, "models", version, "catalog.json");
    const valid = await readFile(source);
    await writeFile(source, "invalid");
    assert.notEqual((await run(build, [], cwd)).code, 0);
    for (const [path, expected] of refreshedCatalogs) {
      assert.deepEqual(await readFile(join(cwd, "dist", path)), expected);
    }
    await writeFile(source, valid);
  }
});

test("smoke rejects broken content, headers, validators, or redirects at every URL", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "catalog-smoke-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const expected = join(cwd, "catalog.json");
  const expectedV2 = join(cwd, "catalog-v2.json");
  const expectedV3 = join(cwd, "catalog-v3.json");
  await writeFile(expected, catalog);
  await writeFile(expectedV2, catalogV2);
  await writeFile(expectedV3, catalogV3);
  let mode = "valid";
  let target = catalogPaths[0];
  let targetRequests = 0;
  const server = createServer((request, response) => {
    if (!catalogPaths.includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    let activeMode = request.url === target ? mode : "valid";
    if (request.url === target) targetRequests++;
    if (activeMode === "stale-once") activeMode = targetRequests === 1 ? "stale" : "valid";
    // Some edges still run the previous deploy: its ETag and bytes, interleaved with the new one.
    if (activeMode === "lagging") activeMode = targetRequests % 2 === 0 ? "previous" : "valid";
    if (activeMode === "redirect") {
      response.writeHead(302, { Location: catalogPaths[0] }).end();
      return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    if (activeMode !== "missing-cors") response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Expose-Headers", "ETag");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const etag = activeMode === "previous" ? '"previous"'
      : request.url.includes("/v3/") ? '"fixture-v3"'
      : request.url.includes("/v2/") ? '"fixture-v2"' : '"fixture-v1"';
    response.setHeader("ETag", etag);
    const unchanged = (activeMode !== "ignores-etag" && request.headers["if-none-match"] === etag)
      || (activeMode === "wrong-precedence" && request.headers["if-modified-since"]);
    response.writeHead(unchanged ? 304 : 200);
    response.end(activeMode === "stale" || activeMode === "previous" ? "{}" : expectedCatalogs.get(request.url));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const noDelay = { CATALOG_SMOKE_RETRY_DELAY_MS: "0" };
  const valid = await run(smoke, [url, expected, expectedV2, expectedV3], cwd, noDelay);
  assert.equal(valid.code, 0, valid.output);
  for (target of catalogPaths) {
    for (mode of ["stale", "missing-cors", "ignores-etag", "wrong-precedence", "redirect"]) {
      const result = await run(smoke, [url, expected, expectedV2, expectedV3], cwd, noDelay);
      assert.notEqual(result.code, 0, `${target}: ${mode}`);
      if (mode === "stale") {
        // A byte mismatch reports sizes and hashes; a Buffer diff would exhaust the runner.
        assert.match(result.output, /deployed catalog bytes: got \d+ bytes sha256 [0-9a-f]{16}, expected/);
      }
    }
    // The edge may briefly serve the previous catalog right after a deploy.
    for (mode of ["stale-once", "lagging"]) {
      targetRequests = 0;
      const recovered = await run(smoke, [url, expected, expectedV2, expectedV3], cwd, noDelay);
      assert.equal(recovered.code, 0, `${target}: ${mode}: ${recovered.output}`);
    }
  }
});
