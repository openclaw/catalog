// Publish gate: every released OpenClaw that reads a feed must accept the new file
// and keep every row the publisher wrote. The verdict is openclaw/openclaw's
// `catalog-compare-released.mts --check` (rejection, row loss against the last
// published file, releases without a reader for the feed skipped by name); this
// script only runs it once per feed:
//
// - A feed without `catalog.next.json` (v1 skipped by `--skip-oversized-v1`) keeps
//   its published file and is not checked.
// - A file with `minVersion` is checked only on tagged releases at or above it.
//   Releases below refuse it by design (the emergency kill switch) and keep the
//   catalog they already stored.
// - `--v3 enforce` also fails when no checked release reads v3; `--v3 off` skips v3.
//
// usage: node scripts/released-readers.mjs --openclaw <checkout> [--models <dir>]
//          [--v3 auto|enforce|off] [--allow-row-loss <n>] [--releases <v,v>]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    openclaw: { type: "string" },
    models: { type: "string", default: "models" },
    v3: { type: "string", default: "auto" },
    "allow-row-loss": { type: "string", default: "" },
    // Pins the releases instead of the npm dist-tags (local dry runs).
    releases: { type: "string", default: "" },
  },
});
const allowRowLoss = values["allow-row-loss"].trim();
if (!values.openclaw || !["auto", "enforce", "off"].includes(values.v3) || !/^\d*$/.test(allowRowLoss)) {
  console.error(
    "usage: node scripts/released-readers.mjs --openclaw <checkout> [--models <dir>] [--v3 auto|enforce|off] [--allow-row-loss <n>] [--releases <v,v>]",
  );
  process.exit(2);
}

// OpenClaw versions: YYYY.M.D, optionally -beta.N (before the release) or -N (a correction after it).
function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+)|-(\d+))?$/.exec(String(value).trim());
    if (!match) return undefined;
    const [, year, month, day, beta, correction] = match;
    return [+year, +month, +day, beta === undefined ? (correction === undefined ? 0 : 1) : -1, +(beta ?? correction ?? 0)];
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  const index = a.findIndex((part, i) => part !== b[i]);
  return index === -1 ? 0 : a[index] < b[index] ? -1 : 1;
}

let tagged;
function releases() {
  if (values.releases) return values.releases.split(",").map((version) => version.trim()).filter(Boolean);
  // The same dist-tags catalog-compare-released reads.
  tagged ??= (() => {
    const parsed = JSON.parse(execFileSync("npm", ["view", "openclaw", "dist-tags", "--json"], { encoding: "utf8" }));
    const tags = Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed;
    return [...new Set(["latest", "extended-stable", "beta"].map((tag) => tags[tag]).filter(Boolean))];
  })();
  return tagged;
}

let failed = false;
for (const version of ["v1", "v2", "v3"]) {
  if (version === "v3" && values.v3 === "off") {
    console.log("::notice::v3 released-reader check is off (CATALOG_GUARD_V3=off)");
    continue;
  }
  const next = resolve(values.models, version, "catalog.next.json");
  const current = resolve(values.models, version, "catalog.json");
  if (!existsSync(next)) {
    console.log(`::notice::${version}: no new file; the published ${version} stays live and is not checked`);
    continue;
  }
  const args = ["scripts/catalog-compare-released.mts", "--check", "--candidate", next];
  if (existsSync(current)) args.push("--baseline", current);
  if (allowRowLoss) args.push("--allow-row-loss", allowRowLoss);

  const { minVersion } = JSON.parse(readFileSync(next, "utf8"));
  if (typeof minVersion === "string" && minVersion) {
    const all = releases();
    const checked = all.filter((release) => compareVersions(release, minVersion) !== -1);
    const below = all.filter((release) => !checked.includes(release));
    if (below.length > 0) {
      console.log(`::notice::${version}: minVersion ${minVersion}; ${below.join(", ")} will refuse it and keep their catalog`);
    }
    if (checked.length === 0) {
      console.log(`::notice::${version}: no tagged release is at or above minVersion ${minVersion}; nothing to check`);
      continue;
    }
    if (below.length > 0 || values.releases) args.push("--releases", checked.join(","));
  } else if (values.releases) {
    args.push("--releases", values.releases);
  }

  const result = spawnSync(process.execPath, args, {
    cwd: resolve(values.openclaw),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  if (result.status !== 0) failed = true;
  if (version === "v3" && values.v3 === "enforce" && /^v3: no checked release reads v3 yet$/m.test(result.stdout ?? "")) {
    console.log("::error::v3: no tagged release reads v3, but CATALOG_GUARD_V3=enforce requires one");
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
