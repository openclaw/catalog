import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

// A stand-in for openclaw's `catalog-compare-released.mts --check`: it records its
// arguments and prints the verdict FAKE_PLAN gives the candidate's feed (by default,
// every release accepts it).
const fakeCompare = `
import fs from "node:fs";
const args = process.argv.slice(2);
const candidate = args[args.indexOf("--candidate") + 1];
const feed = "v" + JSON.parse(fs.readFileSync(candidate, "utf8")).schemaVersion;
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
const releases = args.includes("--releases") ? args[args.indexOf("--releases") + 1].split(",") : ["2026.11.3"];
const accepted = releases.map((release) => feed + " on openclaw@" + release + ": updated, 1/1 rows");
const { lines = accepted, exit = 0 } = JSON.parse(process.env.FAKE_PLAN)[feed] ?? {};
for (const line of lines) console.log(line);
process.exit(exit);
`;

// Releases --check installed, as it caches them under $TMPDIR. `true` ships the v3
// default URL (the marker of a release that reads v3).
const V3_DEFAULT = '"https://catalog.openclaw.ai/models/v3/catalog.json"';
async function installRelease(tmp, release, v3Default) {
  const pkg = join(tmp, "openclaw-catalog-compare-released", release, "node_modules/openclaw");
  await mkdir(join(pkg, "dist/nested"), { recursive: true });
  await writeFile(join(pkg, "package.json"), json({ name: "openclaw", version: release }));
  await writeFile(join(pkg, "dist/remote-config-x.mjs"), `const DEFAULT_REMOTE_MODEL_CATALOG_URL = "https://catalog.openclaw.ai/models/v2/catalog.json";\n`);
  if (v3Default) await writeFile(join(pkg, "dist/nested/chunk.js"), `const DEFAULT_REMOTE_MODEL_CATALOG_URL = ${V3_DEFAULT};\n`);
}

async function gateFixture(t, { candidates, plan = {}, published = candidates, installs = { "2026.11.3": false, "2026.12.1": true } }) {
  // realpath: the gate resolves paths from its working directory (macOS /tmp is a symlink).
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "catalog-gate-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "openclaw/scripts"), { recursive: true });
  await writeFile(join(cwd, "openclaw/scripts/catalog-compare-released.mts"), fakeCompare);
  for (const version of ["v1", "v2", "v3"]) {
    await mkdir(join(cwd, "models", version), { recursive: true });
    if (published[version]) await writeFile(join(cwd, "models", version, "catalog.json"), json(published[version]));
    if (candidates[version]) await writeFile(join(cwd, "models", version, "catalog.next.json"), json(candidates[version]));
  }
  const tmp = join(cwd, "tmp");
  for (const [release, v3Default] of Object.entries(installs)) await installRelease(tmp, release, v3Default);
  const callsFile = join(cwd, "calls.jsonl");
  return {
    cwd,
    gate: (args = []) => run(releasedReaders, ["--openclaw", "openclaw", ...args], cwd, {
      FAKE_PLAN: JSON.stringify(plan),
      FAKE_CALLS: callsFile,
      TMPDIR: tmp,
    }),
    calls: async () => (await readFile(callsFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse),
  };
}

const candidates = { v1: v1(3), v2: versioned(2, 3), v3: versioned(3, 4) };
const noV3Reader = { lines: ["v3 on openclaw@2026.11.3: no v3 reader, skipped", "v3: no checked release reads v3 yet"] };
const option = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

test("the gate runs openclaw --check once per written feed against the published file", async (t) => {
  const { cwd, gate, calls } = await gateFixture(t, { candidates: { v2: candidates.v2, v3: candidates.v3 }, published: candidates, plan: { v3: noV3Reader } });
  const result = await gate();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /::notice::v1: no new file; the published v1 stays live/);
  assert.match(result.output, /v3: no checked release reads v3 yet/);
  const seen = await calls();
  assert.deepEqual(seen.map(({ args }) => option(args, "--candidate")), ["v2", "v3"].map((v) => join(cwd, "models", v, "catalog.next.json")));
  for (const { cwd: dir, args } of seen) {
    assert.ok(dir.endsWith("/openclaw"), dir);
    assert.equal(args[0], "--check");
    assert.equal(option(args, "--baseline"), option(args, "--candidate").replace("catalog.next.json", "catalog.json"));
    assert.equal(option(args, "--releases"), undefined, "dist-tags decide the releases");
    assert.equal(option(args, "--allow-row-loss"), undefined);
  }
  const first = await gateFixture(t, { candidates, published: {} });
  assert.equal((await first.gate()).code, 0);
  assert.ok((await first.calls()).every(({ args }) => !args.includes("--baseline")), "first publish of a feed has no baseline");
});

test("the gate fails when any feed fails and still checks the others", async (t) => {
  const { gate, calls } = await gateFixture(t, {
    candidates,
    plan: { v1: { lines: ["::error::v1 on openclaw@2026.9.37: error: futureTop"], exit: 1 } },
  });
  const result = await gate(["--allow-row-loss", "2"]);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /::error::v1 on openclaw@2026\.9\.37/);
  const seen = await calls();
  assert.equal(seen.length, 3);
  assert.ok(seen.every(({ args }) => option(args, "--allow-row-loss") === "2"));
  assert.equal((await gate(["--allow-row-loss", "x"])).code, 2);
});

const v3Read = { lines: ["v3 on openclaw@2026.12.1: updated, 4/4 rows"] };

test("a release without the v3 default URL may skip v3; one with it must be checked as a v3 reader", async (t) => {
  const absent = await gateFixture(t, { candidates, plan: { v3: noV3Reader } });
  const skipped = await absent.gate();
  assert.equal(skipped.code, 0, skipped.output);
  assert.match(skipped.output, /v3 on openclaw@2026\.11\.3: no v3 reader, skipped/);
  assert.doesNotMatch(skipped.output, /::error::/);

  const read = await gateFixture(t, { candidates, plan: { v3: v3Read } });
  const checked = await read.gate();
  assert.equal(checked.code, 0, checked.output);
  const rejected = await gateFixture(t, { candidates, plan: { v3: { lines: ["::error::v3 on openclaw@2026.12.1: rejected"], exit: 1 } } });
  assert.notEqual((await rejected.gate()).code, 0, "the normal check still decides a detected reader");

  const broken = await gateFixture(t, { candidates, plan: { v3: { lines: [
    "v3 on openclaw@2026.11.3: no v3 reader, skipped",
    "v3 on openclaw@2026.12.1: no v3 reader, skipped",
    "v3: no checked release reads v3 yet",
  ] } } });
  const missed = await broken.gate();
  assert.notEqual(missed.code, 0, missed.output);
  assert.match(missed.output, /::error::v3: openclaw@2026\.12\.1 defaults to the v3 catalog URL, but --check found no v3 reader and skipped it/);
  assert.doesNotMatch(missed.output, /openclaw@2026\.11\.3 defaults/);
});

test("the v3 marker check fails closed when it cannot see what --check installed or reported", async (t) => {
  const uninstalled = await gateFixture(t, { candidates, plan: { v3: noV3Reader }, installs: {} });
  const missing = await uninstalled.gate();
  assert.notEqual(missing.code, 0);
  assert.match(missing.output, /::error::v3: cannot inspect the openclaw@2026\.11\.3 install --check used/);
  const silent = await gateFixture(t, { candidates, plan: { v3: { lines: ["v3: no checked release reads v3 yet"] } } });
  const unknown = await silent.gate();
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.output, /::error::v3: --check reported no release/);
});

test("--skip-v3 skips the v3 check and its marker check", async (t) => {
  const { gate, calls } = await gateFixture(t, { candidates, plan: { v3: { lines: ["v3 on openclaw@2026.12.1: no v3 reader, skipped"] } } });
  const off = await gate(["--skip-v3"]);
  assert.equal(off.code, 0, off.output);
  assert.match(off.output, /::warning::v3 released-reader check skipped/);
  assert.equal((await calls()).length, 2, "v1 and v2 only");
});

test("a v3 minVersion limits the check to releases at or above it", async (t) => {
  const v3 = versioned(3, 4, { minVersion: "2026.12.3" });
  const releases = ["--releases", "2026.12.2,2026.12.3-beta.1,2026.12.3,2026.12.3-1"];
  const { gate, calls } = await gateFixture(t, { candidates: { ...candidates, v3 } });
  const result = await gate(releases);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /::notice::v3: minVersion 2026\.12\.3; 2026\.12\.2, 2026\.12\.3-beta\.1 will refuse it/);
  const byFeed = Object.fromEntries((await calls()).map(({ args }) => [option(args, "--candidate").split("/").at(-2), option(args, "--releases")]));
  assert.equal(byFeed.v3, "2026.12.3,2026.12.3-1");
  assert.equal(byFeed.v2, releases[1], "feeds without minVersion check every release");
  const above = await gateFixture(t, { candidates: { ...candidates, v3: versioned(3, 4, { minVersion: "2027.1.1" }) } });
  const skipped = await above.gate(releases);
  assert.equal(skipped.code, 0, skipped.output);
  assert.match(skipped.output, /::notice::v3: no tagged release is at or above minVersion 2027\.1\.1; nothing to check/);
  assert.equal((await above.calls()).length, 2);
});

async function catalogRepo(t) {
  const cwd = await mkdtemp(join(tmpdir(), "catalog-rollback-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  const write = async (generatedAt, rows, sourceCommit) => {
    const v3 = versioned(3, rows + 1);
    v3.models[rows] = { id: "decision-only", provider: "example", pricing: { status: "unknown" },
      inference: { chat: false, decision: { protocol: "example-decisions", input: ["text"] } } };
    for (const [version, bundle] of Object.entries({ v1: v1(rows), v2: versioned(2, rows), v3 })) {
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

test("rollback restores a v1 the publisher kept from an older run, never mixed v2/v3", async (t) => {
  const { cwd, git, write } = await catalogRepo(t);
  await write(1794385700207, 3, "source-a");
  const stale = JSON.parse(await readFile(join(cwd, "models/v1/catalog.json"), "utf8"));
  await write(1794389300207, 4, "source-b");
  // A publish that skipped an oversized v1: v2/v3 move on, v1 stays at source-a.
  await writeFile(join(cwd, "models/v1/catalog.json"), json(stale));
  git("commit", "-q", "-am", "v1 kept");
  const kept = await run(rollback, ["--from", "HEAD"], cwd);
  assert.equal(kept.code, 0, kept.output);
  assert.match(kept.output, /::notice::.* carries an older v1 \(source source-a\)/);
  const restored = JSON.parse(await readFile(join(cwd, "models/v1/catalog.next.json"), "utf8"));
  assert.equal(restored.sourceCommit, "source-a");
  assert.equal(restored.generatedAt, JSON.parse(await readFile(join(cwd, "models/v3/catalog.next.json"), "utf8")).generatedAt);
  // The deploy runs the hosting test on the restored files; it must accept them.
  for (const version of ["v1", "v2", "v3"]) {
    await writeFile(join(cwd, "models", version, "catalog.json"), await readFile(join(cwd, "models", version, "catalog.next.json")));
  }
  await mkdir(join(cwd, "scripts"));
  for (const file of ["hosting.test.mjs", "generations.mjs"]) {
    await writeFile(join(cwd, "scripts", file), await readFile(new URL(file, import.meta.url)));
  }
  const hosting = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-name-pattern", "published generations", "scripts/hosting.test.mjs"], {
      cwd,
      // A nested node --test must not join this run.
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT")),
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.on("close", (code) => resolve({ code, output }));
  });
  assert.equal(hosting.code, 0, hosting.output);
  assert.match(hosting.output, /pass 1\n/, "the generation test ran");
  git("commit", "-q", "-am", "rolled back");
  await writeFile(join(cwd, "models/v2/catalog.json"), json({ ...versioned(2, 4), generatedAt: 1794389300207, sourceCommit: "source-c" }));
  git("commit", "-q", "-am", "mixed");
  const mixed = await run(rollback, ["--from", "HEAD"], cwd);
  assert.notEqual(mixed.code, 0);
  assert.match(mixed.output, /mixes v2\/v3 source snapshots/);
});
