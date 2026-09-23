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
const catalogPaths = ["/models/v1/catalog.json", "/models/catalog.json"];

test("both catalog URLs have the same exact-path header policy", async () => {
  const rules = (await readFile(headersFile, "utf8")).trim().split("\n\n");
  const policies = rules.map((rule) => rule.split("\n"));
  assert.deepEqual(policies.map(([path]) => path), catalogPaths);
  assert.deepEqual(policies[1].slice(1), policies[0].slice(1));
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
  await mkdir(join(cwd, "static"));
  await mkdir(join(cwd, "dist"));
  await writeFile(join(cwd, "models/v1/catalog.json"), catalog);
  await writeFile(join(cwd, "static/_headers"), await readFile(headersFile));
  await writeFile(join(cwd, "dist/stale.json"), "old output");
  await writeFile(join(cwd, "README.md"), "not a public asset");
  const result = await run(build, [], cwd);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual((await readdir(join(cwd, "dist"), { recursive: true })).sort(), [
    "_headers", "models", "models/catalog.json", "models/v1", "models/v1/catalog.json",
  ]);
  for (const path of catalogPaths) {
    assert.deepEqual(await readFile(join(cwd, "dist", path)), catalog);
  }
  const refreshed = Buffer.from('{"providers":[{"id":"example"}]}\n');
  await writeFile(join(cwd, "models/v1/catalog.json"), refreshed);
  assert.equal((await run(build, [], cwd)).code, 0);
  for (const path of catalogPaths) {
    assert.deepEqual(await readFile(join(cwd, "dist", path)), refreshed);
  }
  await writeFile(join(cwd, "models/v1/catalog.json"), "invalid");
  assert.notEqual((await run(build, [], cwd)).code, 0);
  for (const path of catalogPaths) {
    assert.deepEqual(await readFile(join(cwd, "dist", path)), refreshed);
  }
});

test("smoke rejects broken content, headers, validators, or redirects at either URL", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "catalog-smoke-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const expected = join(cwd, "catalog.json");
  await writeFile(expected, catalog);
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
    response.setHeader("ETag", '"fixture"');
    const unchanged = request.headers["if-none-match"] === '"fixture"'
      || (activeMode === "wrong-precedence" && request.headers["if-modified-since"]);
    response.writeHead(unchanged ? 304 : 200);
    response.end(activeMode === "stale" ? "{}" : catalog);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const valid = await run(smoke, [url, expected], cwd);
  assert.equal(valid.code, 0, valid.output);
  for (target of catalogPaths) {
    for (mode of ["stale", "missing-cors", "wrong-precedence", "redirect"]) {
      assert.notEqual((await run(smoke, [url, expected], cwd)).code, 0, `${target}: ${mode}`);
    }
  }
});
