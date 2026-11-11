// Refuses regenerated catalogs that a released OpenClaw would reject or read with
// rows missing. Released clients cannot be patched: v1/v2 parse strictly, and
// row-tolerant readers (beta, every v3 reader) drop a row they cannot parse and
// still report success. Each release's own refresh decides, through OpenClaw's
// `catalog:compare-released` sandbox.
//
// v3 is guarded only for releases that read v3. `--v3 auto` (the default) checks
// every release that accepts the v3 baseline or candidate and skips releases that
// refuse the schemaVersion; `--v3 enforce` also fails when no release reads v3 or
// the v3 comparison cannot run; `--v3 off` skips v3.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ACCEPTED = new Set(["updated", "unchanged", "fresh"]);
const V3_MODES = new Set(["off", "auto", "enforce"]);

const { values } = parseArgs({
  options: {
    openclaw: { type: "string" },
    models: { type: "string", default: "models" },
    v3: { type: "string", default: "auto" },
    // Local dry runs only: pin releases or limit the per-row request comparison.
    releases: { type: "string" },
    filter: { type: "string" },
    attempts: { type: "string", default: "2" },
  },
});
if (!values.openclaw || !V3_MODES.has(values.v3)) {
  console.error(
    "usage: node scripts/released-readers.mjs --openclaw <openclaw checkout> [--models <dir>] [--v3 off|auto|enforce]",
  );
  process.exit(2);
}

// OpenClaw versions: YYYY.M.D, optionally -beta.N (prerelease) or -N (correction).
function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(beta)\.(\d+)|-(\d+))?$/.exec(String(value).trim());
    if (!match) return undefined;
    const [, year, month, day, beta, betaNumber, correction] = match;
    // A beta sorts before its release; a correction after it.
    const tail = beta ? [-1, Number(betaNumber)] : [correction ? 1 : 0, Number(correction ?? 0)];
    return [Number(year), Number(month), Number(day), ...tail];
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function rowCount(bundle) {
  if (Array.isArray(bundle.models)) return bundle.models.length;
  return Object.values(bundle.providers ?? {}).reduce(
    (sum, provider) => sum + (Array.isArray(provider?.models) ? provider.models.length : 0),
    0,
  );
}

const oneLine = (value) => String(value ?? "no error message").replace(/\s+/g, " ").slice(0, 500);
// A release without a v3 reader refuses the file on schemaVersion alone.
const refusesSchemaVersion = (refresh) => !ACCEPTED.has(refresh.status) && /schemaVersion/.test(String(refresh.error));

// catalog-compare-released fails as a whole when one sandboxed reader dies before
// reporting (for example openclaw/openclaw's shared worker-copy race, which exits 0
// with no output). That is infrastructure, not a verdict, so it is retried; a
// rejection or row loss is a result in the dump and never retried.
function compare(version, candidate, baseline) {
  const attempts = Math.max(1, Number(values.attempts) || 1);
  for (let attempt = 1; ; attempt++) {
    const dump = mkdtempSync(join(tmpdir(), `released-readers-${version}-`));
    const args = ["scripts/catalog-compare-released.mts", "--candidate", candidate, "--baseline", baseline, "--dump", dump];
    if (values.releases) args.push("--releases", values.releases);
    if (values.filter) args.push("--filter", values.filter);
    try {
      // Releases come from the latest, extended-stable and beta npm dist-tags.
      execFileSync(process.execPath, args, { cwd: resolve(values.openclaw), stdio: ["ignore", "ignore", "inherit"] });
      return dump;
    } catch (error) {
      const reason = `${version}: released-reader comparison did not finish (exit ${error.status ?? error.signal})`;
      if (attempt >= attempts) throw new Error(reason);
      console.log(`::warning::${reason}; retrying (${attempt}/${attempts - 1})`);
    }
  }
}

function readRuns(dump, label) {
  return new Map(
    readdirSync(dump)
      .filter((file) => file.endsWith(`-${label}.json`))
      .map((file) => {
        const run = JSON.parse(readFileSync(join(dump, file), "utf8"));
        return [run.version, run];
      }),
  );
}

const failures = [];
const notices = [];
const versions = ["v1", "v2", ...(values.v3 === "off" ? [] : ["v3"])];
for (const version of versions) {
  const candidatePath = resolve(values.models, version, "catalog.next.json");
  const currentPath = resolve(values.models, version, "catalog.json");
  const baselinePath = existsSync(currentPath) ? currentPath : candidatePath;
  const candidateBundle = JSON.parse(readFileSync(candidatePath, "utf8"));
  const candidateRows = rowCount(candidateBundle);
  const minVersion = typeof candidateBundle.minVersion === "string" ? candidateBundle.minVersion : undefined;
  const v3 = version === "v3";

  let dump;
  try {
    dump = compare(version, candidatePath, baselinePath);
  } catch (error) {
    if (v3 && values.v3 === "auto") {
      console.log(`::warning::${error.message}; v3 is not enforced yet (--v3 auto)`);
      continue;
    }
    failures.push(error.message);
    continue;
  }
  const candidates = readRuns(dump, "candidate");
  const baselines = readRuns(dump, "baseline");
  if (candidates.size === 0) {
    failures.push(`${version}: no released reader ran`);
    continue;
  }

  let v3Readers = 0;
  for (const [release, { refresh, rows }] of [...candidates].toSorted(([a], [b]) => a.localeCompare(b))) {
    const baselineRefresh = baselines.get(release)?.refresh;
    const summary = `${version} on openclaw@${release}: ${refresh.status}, ${refresh.models ?? "?"}/${candidateRows} catalog rows kept, ${rows.length} rows observed`;
    console.log(summary);

    // A v3 kill switch: releases below minVersion must refuse the file and keep their catalog.
    if (minVersion && compareVersions(release, minVersion) === -1) {
      if (ACCEPTED.has(refresh.status) || !/requires OpenClaw/.test(String(refresh.error))) {
        failures.push(`${summary}: expected refusal below minVersion ${minVersion}: ${oneLine(refresh.error)}`);
      }
      continue;
    }
    if (v3 && refusesSchemaVersion(refresh) && (!baselineRefresh || refusesSchemaVersion(baselineRefresh))) {
      notices.push(`${version}: openclaw@${release} does not read v3; skipped`);
      continue;
    }
    if (v3) v3Readers++;
    if (!ACCEPTED.has(refresh.status)) {
      failures.push(`${summary}: ${oneLine(refresh.error)}`);
      continue;
    }
    // Row-tolerant readers report success after dropping rows they cannot parse.
    if (typeof refresh.models === "number" && refresh.models < candidateRows) {
      failures.push(`${summary}: the release dropped ${candidateRows - refresh.models} rows it could not read`);
    }
  }
  if (v3 && v3Readers === 0) {
    if (values.v3 === "enforce") {
      failures.push("v3: no released OpenClaw reads v3, but --v3 enforce requires one");
    } else {
      notices.push("v3: no released OpenClaw reads v3 yet; nothing to guard");
    }
  }
}

for (const notice of notices) {
  console.log(`::notice::${notice}`);
}
for (const failure of failures) {
  console.error(`::error::${failure}`);
}
process.exit(failures.length > 0 ? 1 : 0);
