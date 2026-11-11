import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const releasedReaders = fileURLToPath(new URL("released-readers.mjs", import.meta.url));
const rollback = fileURLToPath(new URL("rollback.mjs", import.meta.url));

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

const v1 = (rows, extra = {}) => ({
  ...extra,
  generatedAt: 1794385700207,
  minVersion: "2026.7.0",
  providers: { example: { models: Array.from({ length: rows }, (_, index) => ({ id: `m${index}` })) } },
  schemaVersion: 1,
  sourceCommit: "source-a",
});
const versioned = (schemaVersion, rows, extra = {}) => ({
  ...extra,
  generatedAt: 1794385700207,
  models: Array.from({ length: rows }, (_, index) => ({ id: `m${index}`, provider: "example", pricing: { status: "unknown" } })),
  providers: { example: { defaultModel: "m0" } },
  schemaVersion,
  sourceCommit: "source-a",
});
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// A stand-in for openclaw's catalog-compare-released: each release's refresh outcome
// comes from FAKE_PLAN, keyed by schemaVersion, release and baseline/candidate.
const fakeCompare = `
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { candidate: { type: "string" }, baseline: { type: "string" },
  dump: { type: "string" }, releases: { type: "string" }, filter: { type: "string" } } });
const plan = JSON.parse(process.env.FAKE_PLAN);
const schema = JSON.parse(fs.readFileSync(values.candidate, "utf8")).schemaVersion;
const crashes = plan.crash?.["v" + schema] ?? 0;
const key = path.join(process.env.FAKE_STATE, "crash-v" + schema);
const crashed = fs.existsSync(key) ? Number(fs.readFileSync(key, "utf8")) : 0;
if (crashed < crashes) {
  fs.writeFileSync(key, String(crashed + 1));
  console.error("Error: released reader failed for /tmp/x/2026.9.37 (exit 0):");
  process.exit(1);
}
for (const label of ["baseline", "candidate"]) {
  const bundle = JSON.parse(fs.readFileSync(values[label], "utf8"));
  const rows = bundle.models?.length ?? Object.values(bundle.providers).reduce((n, p) => n + p.models.length, 0);
  for (const [release, outcome] of Object.entries(plan["v" + schema] ?? {})) {
    const chosen = outcome[label] ?? outcome;
    const refresh = chosen.status === "error"
      ? { status: "error", error: chosen.error, providers: 0, models: 0 }
      : { status: chosen.status ?? "updated", providers: 1, models: rows - (chosen.drop ?? 0) };
    fs.writeFileSync(path.join(values.dump, release + "-" + label + ".json"),
      JSON.stringify({ version: release, refresh, rows: [{ model: "example/m0" }] }));
  }
}
`;

async function guardFixture(t, { candidates, plan }) {
  const cwd = await mkdtemp(join(tmpdir(), "catalog-guard-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "openclaw/scripts"), { recursive: true });
  await mkdir(join(cwd, "state"));
  await writeFile(join(cwd, "openclaw/scripts/catalog-compare-released.mts"), fakeCompare);
  for (const [version, bundle] of Object.entries(candidates)) {
    await mkdir(join(cwd, "models", version), { recursive: true });
    await writeFile(join(cwd, "models", version, "catalog.json"), json(bundle));
    await writeFile(join(cwd, "models", version, "catalog.next.json"), json(bundle));
  }
  return (args = []) => run(releasedReaders, ["--openclaw", "openclaw", ...args], cwd, {
    FAKE_PLAN: JSON.stringify(plan),
    FAKE_STATE: join(cwd, "state"),
  });
}

const notV3 = { status: "error", error: '[{"code":"invalid_value","values":[1],"path":["schemaVersion"]}]' };
const ok = { status: "updated" };
const legacy = { "2026.11.3": ok, "2026.9.37": ok, "2026.11.5-beta.1": ok };
const candidates = { v1: v1(3), v2: versioned(2, 3), v3: versioned(3, 4) };

test("released readers accept v1/v2 and skip v3 until a release reads it", async (t) => {
  const guard = await guardFixture(t, {
    candidates,
    plan: { v1: legacy, v2: legacy, v3: { "2026.11.3": notV3, "2026.9.37": notV3, "2026.11.5-beta.1": notV3 } },
  });
  const auto = await guard();
  assert.equal(auto.code, 0, auto.output);
  assert.match(auto.output, /v2 on openclaw@2026\.9\.37: updated, 3\/3 catalog rows kept/);
  assert.match(auto.output, /::notice::v3: openclaw@2026\.11\.3 does not read v3; skipped/);
  assert.match(auto.output, /::notice::v3: no released OpenClaw reads v3 yet/);
  const enforce = await guard(["--v3", "enforce"]);
  assert.notEqual(enforce.code, 0);
  assert.match(enforce.output, /::error::v3: no released OpenClaw reads v3, but --v3 enforce requires one/);
  const off = await guard(["--v3", "off"]);
  assert.equal(off.code, 0, off.output);
  assert.doesNotMatch(off.output, /v3/);
});

test("released readers fail on rejection and on rows a tolerant reader dropped", async (t) => {
  const guard = await guardFixture(t, {
    candidates,
    plan: {
      v1: { ...legacy, "2026.9.37": { status: "error", error: 'Unrecognized key: "futureTop"' } },
      v2: { ...legacy, "2026.11.5-beta.1": { status: "updated", drop: 1 } },
      v3: { "2026.11.3": notV3, "2026.12.1-beta.1": { baseline: ok, candidate: { status: "updated", drop: 2 } } },
    },
  });
  const result = await guard();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /::error::v1 on openclaw@2026\.9\.37: error.*futureTop/);
  assert.match(result.output, /::error::v2 on openclaw@2026\.11\.5-beta\.1: updated, 2\/3 .*dropped 1 rows/);
  assert.match(result.output, /::error::v3 on openclaw@2026\.12\.1-beta\.1: updated, 2\/4 .*dropped 2 rows/);
  assert.doesNotMatch(result.output, /::error::v1 on openclaw@2026\.11\.3/);
});

test("a v3 reader that refuses the candidate fails even when the baseline was bad", async (t) => {
  const refused = { status: "error", error: '[{"code":"invalid_value","path":["providers","x","api"]}]' };
  const guard = await guardFixture(t, {
    candidates,
    plan: {
      v1: legacy,
      v2: legacy,
      v3: {
        "2026.12.1": { baseline: ok, candidate: notV3 },
        "2026.12.2": { baseline: refused, candidate: refused },
      },
    },
  });
  const result = await guard();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /::error::v3 on openclaw@2026\.12\.1: error/);
  assert.match(result.output, /::error::v3 on openclaw@2026\.12\.2: error/);
});

test("v3 minVersion makes refusal the expected result below it", async (t) => {
  const requires = (version) => ({ status: "error", error: `Error: remote catalog requires OpenClaw 2026.12.3 or newer (current ${version})` });
  const plan = (below) => ({
    v1: legacy,
    v2: legacy,
    v3: { "2026.12.2": below, "2026.12.3-beta.1": requires("2026.12.3-beta.1"), "2026.12.3": ok },
  });
  const v3 = versioned(3, 4, { minVersion: "2026.12.3" });
  const pass = await (await guardFixture(t, { candidates: { ...candidates, v3 }, plan: plan(requires("2026.12.2")) }))();
  assert.equal(pass.code, 0, pass.output);
  const leaked = await (await guardFixture(t, { candidates: { ...candidates, v3 }, plan: plan(ok) }))();
  assert.notEqual(leaked.code, 0);
  assert.match(leaked.output, /::error::v3 on openclaw@2026\.12\.2: updated.*expected refusal below minVersion 2026\.12\.3/);
});

test("a comparison that dies before reporting is retried once, never a rejection", async (t) => {
  const plan = { v1: legacy, v2: legacy, v3: { "2026.12.1": ok } };
  const once = await (await guardFixture(t, { candidates, plan: { ...plan, crash: { v2: 1 } } }))();
  assert.equal(once.code, 0, once.output);
  assert.match(once.output, /::warning::v2: released-reader comparison did not finish \(exit 1\); retrying/);
  const twice = await (await guardFixture(t, { candidates, plan: { ...plan, crash: { v2: 2 } } }))();
  assert.notEqual(twice.code, 0);
  assert.match(twice.output, /::error::v2: released-reader comparison did not finish/);
  const v3Auto = await (await guardFixture(t, { candidates, plan: { ...plan, crash: { v3: 2 } } }))();
  assert.equal(v3Auto.code, 0, v3Auto.output);
  assert.match(v3Auto.output, /::warning::v3: .*not enforced yet/);
  const v3Enforce = await (await guardFixture(t, { candidates, plan: { ...plan, crash: { v3: 2 } } }))(["--v3", "enforce"]);
  assert.notEqual(v3Enforce.code, 0);
});

async function catalogRepo(t) {
  const cwd = await mkdtemp(join(tmpdir(), "catalog-rollback-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  const write = async (generatedAt, rows, sourceCommit) => {
    for (const [version, bundle] of Object.entries({ v1: v1(rows), v2: versioned(2, rows), v3: versioned(3, rows + 1) })) {
      await mkdir(join(cwd, "models", version), { recursive: true });
      await writeFile(join(cwd, "models", version, "catalog.json"), json({ ...bundle, generatedAt, sourceCommit }));
    }
    git("add", "models");
    git("commit", "-q", "-m", `catalog ${generatedAt}`);
    return git("rev-parse", "HEAD");
  };
  return { cwd, git, write };
}

test("rollback restores earlier content with one generatedAt newer than anything published", async (t) => {
  const { cwd, write } = await catalogRepo(t);
  const good = await write(1794385700207, 3, "source-good");
  await write(1794389300207, 5, "source-bad");
  const now = "1794380000000"; // a runner clock behind the bad stamp must not matter
  const result = await run(rollback, ["--from", good.slice(0, 12), "--now", now], cwd);
  assert.equal(result.code, 0, result.output);
  for (const [version, rows] of [["v1", 3], ["v2", 3], ["v3", 4]]) {
    const restored = JSON.parse(await readFile(join(cwd, "models", version, "catalog.next.json"), "utf8"));
    assert.equal(restored.generatedAt, 1794389300208, version);
    assert.equal(restored.sourceCommit, "source-good", version);
    assert.equal(restored.models?.length ?? restored.providers.example.models.length, rows, version);
    const original = JSON.parse(execFileSync("git", ["show", `${good}:models/${version}/catalog.json`], { cwd, encoding: "utf8" }));
    assert.deepEqual({ ...restored, generatedAt: 0 }, { ...original, generatedAt: 0 }, `${version} content unchanged`);
  }
  const live = Date.now();
  const fresh = await run(rollback, ["--from", "HEAD", "--v3-min-version", "2026.12.3"], cwd);
  assert.equal(fresh.code, 0, fresh.output);
  const v3 = await readFile(join(cwd, "models/v3/catalog.next.json"), "utf8");
  const parsed = JSON.parse(v3);
  assert.ok(parsed.generatedAt >= live, "uses the clock when it is newer");
  assert.equal(parsed.minVersion, "2026.12.3");
  assert.deepEqual(Object.keys(parsed), Object.keys(parsed).toSorted(), "publisher key order");
  assert.equal(JSON.parse(await readFile(join(cwd, "models/v2/catalog.next.json"), "utf8")).minVersion, undefined);
});

test("rollback refuses refs and versions it cannot restore safely", async (t) => {
  const { cwd, git, write } = await catalogRepo(t);
  await write(1794385700207, 3, "source-a");
  git("checkout", "-q", "-b", "side");
  const side = await write(1794385700300, 4, "source-side");
  git("checkout", "-q", "main");
  for (const [args, message] of [
    [["--from", "main~1"], /must be HEAD or a commit SHA/],
    [["--from", "deadbeefdeadbeef"], /is not a commit/],
    [["--from", side], /not on the current main history/],
    [["--from", "HEAD", "--v3-min-version", "banana"], /--v3-min-version must look like/],
  ]) {
    const result = await run(rollback, args, cwd);
    assert.notEqual(result.code, 0, args.join(" "));
    assert.match(result.output, message);
  }
  await writeFile(join(cwd, "models/v1/catalog.json"), JSON.stringify(v1(3, { generatedAt: 1 })));
  git("commit", "-q", "-am", "minified");
  const unformatted = await run(rollback, ["--from", "HEAD"], cwd);
  assert.match(unformatted.output, /does not round-trip/);
});
