import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

// Stage an allowlist, never the repository or the upstream checkout used by CI.
const catalog = await readFile("models/v1/catalog.json");
JSON.parse(catalog.toString("utf8"));
const headers = await readFile("static/_headers");
await rm("dist", { recursive: true, force: true });
await mkdir("dist/models/v1", { recursive: true });
await writeFile("dist/models/v1/catalog.json", catalog);
await writeFile("dist/_headers", headers);
console.log(`Staged catalog (${catalog.length} bytes).`);
