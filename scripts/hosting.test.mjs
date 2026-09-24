import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  schemaVersion: 3,
  generatedAt: 1753500000000,
  sourceCommit: "fixture",
  providers: { example: {} },
  providerPricing: { "example/routed": { input: 0.042, output: 0, source: "openRouter" } },
  upstreamPricing: { "vendor/decision": { input: 0.042, output: 0, source: "liteLLM", passthroughOnly: true } },
  models: [
    {
      id: "decision", provider: "example",
      inference: { chat: false, decision: { protocol: "example-decision", input: ["text"] } },
      pricing: { status: "known", currency: "USD", unit: "million_tokens", input: 0.042, output: 0, source: "manifest" },
    },
    {
      id: "local", provider: "example",
      inference: { chat: false, decision: { protocol: "onnx-classifier", input: ["text"] } },
      pricing: { status: "unknown" },
    },
  ],
}) + "\n");
const catalogPaths = ["/models/v1/catalog.json", "/models/catalog.json", "/models/v2/catalog.json", "/models/v3/catalog.json"];
const expectedCatalogs = new Map(catalogPaths.map((path) => [
  path, path.includes("/v3/") ? catalogV3 : path.includes("/v2/") ? catalogV2 : catalog,
]));

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

function run(script, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd });
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
  await writeFile(join(cwd, "models/v3/catalog.next.json"), "not a public asset");
  await writeFile(join(cwd, "static/_headers"), await readFile(headersFile));
  await writeFile(join(cwd, "dist/stale.json"), "old output");
  await writeFile(join(cwd, "README.md"), "not a public asset");
  const result = await run(build, [], cwd);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual((await readdir(join(cwd, "dist"), { recursive: true })).sort(), [
    "_headers", "models", "models/catalog.json", "models/v1", "models/v1/catalog.json",
    "models/v2", "models/v2/catalog.json", "models/v3", "models/v3/catalog.json",
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
  const server = createServer((request, response) => {
    if (!catalogPaths.includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    const activeMode = request.url === target ? mode : "valid";
    if (activeMode === "redirect") {
      response.writeHead(302, { Location: catalogPaths[0] }).end();
      return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    if (activeMode !== "missing-cors") response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Expose-Headers", "ETag");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const etag = request.url.includes("/v3/") ? '"fixture-v3"' : request.url.includes("/v2/") ? '"fixture-v2"' : '"fixture-v1"';
    response.setHeader("ETag", etag);
    const unchanged = request.headers["if-none-match"] === etag
      || (activeMode === "wrong-precedence" && request.headers["if-modified-since"]);
    response.writeHead(unchanged ? 304 : 200);
    response.end(activeMode === "stale" ? "{}" : expectedCatalogs.get(request.url));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const valid = await run(smoke, [url, expected, expectedV2, expectedV3], cwd);
  assert.equal(valid.code, 0, valid.output);
  for (target of catalogPaths) {
    for (mode of ["stale", "missing-cors", "wrong-precedence", "redirect"]) {
      assert.notEqual((await run(smoke, [url, expected, expectedV2, expectedV3], cwd)).code, 0, `${target}: ${mode}`);
    }
  }
});

function workflowRun(workflow, step) {
  const block = workflow.split("      - name: " + step + "\n")[1]?.split("\n      - name:")[0];
  assert.ok(block, step);
  const source = block.split("        run: |\n")[1];
  assert.ok(source, step + " run block");
  return source.split("\n").filter((line) => line.startsWith("          "))
    .map((line) => line.slice(10)).join("\n");
}

test("publication compares all versions before promoting the complete set", async (t) => {
  const workflow = await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const commit = workflowRun(workflow, "Commit on change only");
  // Exercise the real comparison/promotion block, never its git commit/push commands.
  const promote = commit.split("git config user.name")[0];
  assert.match(commit, /git add models\/v1\/catalog.json models\/v2\/catalog.json models\/v3\/catalog.json/);
  const cwd = await mkdtemp(join(tmpdir(), "catalog-publication-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const versions = ["v1", "v2", "v3"];
  for (const version of versions) await mkdir(join(cwd, "models", version), { recursive: true });
  for (const change of ["timestamps", ...versions, "missing-v3", "invalid-v3", "empty-v3", "whitespace-v3", "multiple-v3", "array-v3", "initial-v3"]) {
    const previous = new Map();
    const next = new Map();
    for (const version of versions) {
      const current = JSON.stringify({ schemaVersion: Number(version.slice(1)), generatedAt: 1, sourceCommit: "old", models: [] });
      const candidate = JSON.stringify({ schemaVersion: Number(version.slice(1)), generatedAt: 2, sourceCommit: "new", models: version === change ? [{ id: "new" }] : [] });
      previous.set(version, current);
      next.set(version, candidate);
      await writeFile(join(cwd, "models", version, "catalog.json"), current);
      await writeFile(join(cwd, "models", version, "catalog.next.json"), candidate);
    }
    if (change === "missing-v3") await rm(join(cwd, "models/v3/catalog.next.json"));
    if (change === "invalid-v3") await writeFile(join(cwd, "models/v3/catalog.next.json"), "invalid");
    const invalidOutputs = { "empty-v3": "", "whitespace-v3": " \n", "multiple-v3": "{}\n{}", "array-v3": "[]" };
    if (Object.hasOwn(invalidOutputs, change)) await writeFile(join(cwd, "models/v3/catalog.next.json"), invalidOutputs[change]);
    if (change === "initial-v3") await rm(join(cwd, "models/v3/catalog.json"));
    const result = spawnSync("bash", ["-c", promote], { cwd, encoding: "utf8" });
    const failed = change === "missing-v3" || change === "invalid-v3" || Object.hasOwn(invalidOutputs, change);
    if (failed) assert.notEqual(result.status, 0, change);
    else assert.equal(result.status, 0, result.stderr);
    for (const version of versions) {
      const expected = failed || change === "timestamps" ? previous : next;
      assert.equal(await readFile(join(cwd, "models", version, "catalog.json"), "utf8"), expected.get(version), change + " " + version);
      if (!failed) await assert.rejects(readFile(join(cwd, "models", version, "catalog.next.json")), { code: "ENOENT" });
    }
  }
});

test("generation refuses an upstream checkout without the v3 prerequisite", async (t) => {
  const workflow = await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const assemble = workflowRun(workflow, "Assemble catalog");
  const invocation = "node --import tsx scripts/publish-model-catalog.mts --pricing --out ../models/v1/catalog.next.json --out-v2 ../models/v2/catalog.next.json --out-v3 ../models/v3/catalog.next.json";
  assert.ok(assemble.endsWith(invocation));
  const preflight = assemble.slice(0, -invocation.length);
  const cwd = await mkdtemp(join(tmpdir(), "catalog-prerequisite-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "scripts"));
  for (const ready of [false, true]) {
    await writeFile(join(cwd, "scripts/publish-model-catalog.mts"), ready ? 'if (arg === "--out-v3") {}' : 'if (arg === "--out-v2") {}');
    const result = spawnSync("bash", ["-c", preflight], { cwd, encoding: "utf8" });
    assert.equal(result.status, ready ? 0 : 1, result.stderr);
    if (!ready) assert.match(result.stdout, /requires openclaw\/openclaw#157492/);
  }
});
