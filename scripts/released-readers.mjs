// Refuses regenerated v1/v2 catalogs that a released OpenClaw would reject.
// Released clients parse v1/v2 strictly and cannot be patched, so those feeds
// stay frozen and new fields go to v3. Each release's own refresh decides,
// through OpenClaw's `catalog:compare-released` sandbox.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ACCEPTED = new Set(["updated", "unchanged", "fresh"]);

const { values } = parseArgs({
  options: {
    openclaw: { type: "string" },
    models: { type: "string", default: "models" },
  },
});
if (!values.openclaw) {
  console.error("usage: node scripts/released-readers.mjs --openclaw <openclaw checkout> [--models <dir>]");
  process.exit(2);
}

const failures = [];
for (const version of ["v1", "v2"]) {
  const candidate = resolve(values.models, version, "catalog.next.json");
  const current = resolve(values.models, version, "catalog.json");
  const dump = mkdtempSync(join(tmpdir(), `released-readers-${version}-`));
  // Releases come from the latest, extended-stable and beta npm dist-tags.
  execFileSync(
    process.execPath,
    [
      "scripts/catalog-compare-released.mts",
      "--candidate", candidate,
      "--baseline", existsSync(current) ? current : candidate,
      "--dump", dump,
    ],
    { cwd: resolve(values.openclaw), stdio: ["ignore", "ignore", "inherit"] },
  );
  const runs = readdirSync(dump).filter((file) => file.endsWith("-candidate.json"));
  if (runs.length === 0) {
    failures.push(`${version}: no released reader ran`);
  }
  for (const file of runs) {
    const { version: release, refresh, rows } = JSON.parse(readFileSync(join(dump, file), "utf8"));
    const result = `${version} on openclaw@${release}: ${refresh.status}, ${rows.length} rows`;
    console.log(result);
    if (!ACCEPTED.has(refresh.status)) {
      // GitHub annotations keep one line.
      const error = String(refresh.error ?? "no error message").replace(/\s+/g, " ");
      failures.push(`${result}: ${error.slice(0, 500)}`);
    }
  }
}

for (const failure of failures) {
  console.error(`::error::${failure}`);
}
process.exit(failures.length > 0 ? 1 : 0);
