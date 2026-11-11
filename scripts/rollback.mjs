// Roll the hosted catalog forward to the content of an earlier, known-good commit.
//
// Clients keep whichever cached catalog has the newer `generatedAt` (and keep the
// stored copy when `generatedAt` ties with different bytes), so republishing an old
// file, or `git revert`, changes nothing for clients that already fetched the bad one.
// This copies the v1, v2 and v3 payloads of <ref> unchanged and gives all three one
// fresh `generatedAt` that is newer than anything published so far. The publish
// workflow then runs the usual released-reader guard, tests, preview and smoke.
//
// usage: node scripts/rollback.mjs --from <commit|HEAD> [--v3-min-version <version>]
//          [--openclaw <checkout>] [--models <dir>] [--now <ms>]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const VERSIONS = ["v1", "v2", "v3"];
// Released readers reject `generatedAt` more than 24 h ahead of their clock.
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60_000;
// Stable, beta and correction versions as OpenClaw's own version parser accepts them.
const OPENCLAW_VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}(?:-(?:beta\.\d+|\d+))?$/;

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    "v3-min-version": { type: "string", default: "" },
    openclaw: { type: "string" },
    models: { type: "string", default: "models" },
    now: { type: "string" },
  },
});

function fail(message) {
  console.error(`::error::rollback: ${message}`);
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const from = values.from?.trim() ?? "";
if (!/^(?:HEAD|[0-9a-f]{7,40})$/.test(from)) {
  fail(`--from must be HEAD or a commit SHA, got ${JSON.stringify(from)}`);
}
const minVersion = values["v3-min-version"].trim();
if (minVersion && !OPENCLAW_VERSION.test(minVersion)) {
  // A minVersion that clients cannot parse makes every reader, current ones
  // included, reject the file (audit fixture 56).
  fail(`--v3-min-version must look like 2026.11.6 or 2026.11.6-beta.1, got ${JSON.stringify(minVersion)}`);
}

let commit;
try {
  commit = git("rev-parse", "--verify", "--quiet", `${from}^{commit}`).trim();
} catch {
  fail(`${from} is not a commit in this checkout (the workflow fetches full history for rollbacks)`);
}
try {
  git("merge-base", "--is-ancestor", commit, "HEAD");
} catch {
  fail(`${commit} is not on the current main history; only previously published commits can be restored`);
}

const files = new Map();
for (const version of VERSIONS) {
  let text;
  try {
    text = git("show", `${commit}:models/${version}/catalog.json`);
  } catch {
    fail(`${commit} has no models/${version}/catalog.json; choose a commit that published all three feeds`);
  }
  const bundle = JSON.parse(text);
  if (bundle.schemaVersion !== Number(version.slice(1))) {
    fail(`${commit}:models/${version}/catalog.json has schemaVersion ${bundle.schemaVersion}`);
  }
  // Only generatedAt (and an optional v3 minVersion) may change. Refuse files that
  // would not round-trip byte for byte through the publisher's serialization.
  if (`${JSON.stringify(bundle, null, 2)}\n` !== text) {
    fail(`${commit}:models/${version}/catalog.json does not round-trip; refusing to rewrite it`);
  }
  files.set(version, bundle);
}
// v2 and v3 always come from one publisher run. v1 may be older: the publisher
// keeps the previous v1 when a new one would exceed the client size limit.
const source = files.get("v3").sourceCommit;
if (files.get("v2").sourceCommit !== source) {
  fail(`${commit} mixes v2/v3 source snapshots; pick a commit written by one publisher run`);
}
if (files.get("v1").sourceCommit !== source) {
  console.log(`::notice::${commit} carries an older v1 (source ${files.get("v1").sourceCommit}); it is restored as is`);
}

// Newer than every file at <ref> and every file currently on main, so every client
// that cached any of them accepts the restored content.
const now = values.now ? Number(values.now) : Date.now();
let newest = 0;
for (const version of VERSIONS) {
  newest = Math.max(newest, files.get(version).generatedAt);
  const current = resolve(values.models, version, "catalog.json");
  if (existsSync(current)) {
    newest = Math.max(newest, JSON.parse(readFileSync(current, "utf8")).generatedAt ?? 0);
  }
}
const generatedAt = Math.max(now, newest + 1);
if (!Number.isSafeInteger(generatedAt) || generatedAt > now + MAX_FUTURE_SKEW_MS) {
  fail(`a published generatedAt (${newest}) is more than 24 h in the future; clients would reject any newer stamp`);
}

const sortKeys = (bundle) =>
  Object.fromEntries(Object.entries(bundle).toSorted(([left], [right]) => (left < right ? -1 : 1)));
for (const version of VERSIONS) {
  const bundle = { ...files.get(version), generatedAt };
  if (version === "v3" && minVersion) {
    bundle.minVersion = minVersion;
  }
  files.set(version, sortKeys(bundle));
}

if (values.openclaw) {
  // The same client parsers the publisher validates against, from the openclaw checkout.
  const checks = VERSIONS.map((version) => ({
    version,
    file: resolve(values.models, version, "catalog.next.json"),
    parser: version === "v1" ? "parseRemoteModelCatalogBundle" : `parseRemoteModelCatalogBundleV${version.slice(1)}`,
  }));
  for (const { version, file } of checks) {
    writeFileSync(file, `${JSON.stringify(files.get(version), null, 2)}\n`);
  }
  const script = `
    import { readFileSync } from "node:fs";
    const core = await import(${JSON.stringify(resolve(values.openclaw, "packages/model-catalog-core/src/remote-catalog-bundle.ts"))});
    for (const { version, file, parser } of ${JSON.stringify(checks)}) {
      core[parser](JSON.parse(readFileSync(file, "utf8")));
      console.log(version + ": accepted by openclaw main's client schema");
    }`;
  try {
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: resolve(values.openclaw),
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    fail("restored content does not pass openclaw main's client schema");
  }
}

for (const version of VERSIONS) {
  writeFileSync(join(values.models, version, "catalog.next.json"), `${JSON.stringify(files.get(version), null, 2)}\n`);
}
const counts = VERSIONS.map((version) => {
  const bundle = files.get(version);
  const rows = Array.isArray(bundle.models)
    ? bundle.models.length
    : Object.values(bundle.providers).reduce((sum, provider) => sum + provider.models.length, 0);
  return `${version} ${rows} rows`;
});
console.log(
  `Restored content of ${commit} (source ${source}) with generatedAt ${generatedAt}` +
    `${minVersion ? `, v3 minVersion ${minVersion}` : ""}: ${counts.join(", ")}.`,
);
