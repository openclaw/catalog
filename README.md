# OpenClaw Model Catalog

The hosted model catalog served at **https://catalog.openclaw.ai/models/v1/catalog.json**.

**https://catalog.openclaw.ai/models/catalog.json** is a direct, byte-identical
alias of the v1 catalog. Both URLs refresh together and use the v1 format.

The v2 catalog is served at **https://catalog.openclaw.ai/models/v2/catalog.json**.
It has its own versioned format; the unversioned alias continues to serve v1.

The v3 catalog is served at **https://catalog.openclaw.ai/models/v3/catalog.json**.
It extends v2 with model `inference` capabilities, including native Decision models.

### Client compatibility

Catalog publication and OpenClaw releases can happen in either order:

| Client | Feed | Behavior |
| --- | --- | --- |
| Existing v1 clients | `/models/v1/catalog.json` or the unversioned alias | Continue receiving the v1 format. |
| Existing v2 clients and the current OpenClaw default | `/models/v2/catalog.json` | Continue receiving the v2 format. |
| Clients with v3 support, explicitly configured for it | `/models/v3/catalog.json` | Receive inference capabilities and native Decision model metadata. |

There are no redirects to a newer schema. v1/v2 omit `inference` and
Decision-only models; publishing v3 does not change client defaults. Newer
OpenClaw clients also accept v1/v2, so they can upgrade before the catalog does.
Only configure the v3 URL after upgrading to an OpenClaw build with v3 support;
older clients do not gain v3 support just by changing their URL.

OpenClaw fetches catalog updates in the background (every 6h, or via
`openclaw models refresh`) to learn about newly released models without waiting
for a release. See the [models documentation](https://docs.openclaw.ai/concepts/models)
for how the overlay works and how to disable it (`models.catalogRefresh.enabled: false`)
or point it at a mirror (`models.catalogRefresh.url`).

## How it is produced

The catalog is **not hand-edited**. A [scheduled workflow](.github/workflows/publish.yml)
assembles it from the `modelCatalog` blocks in the plugin manifests of
[openclaw/openclaw](https://github.com/openclaw/openclaw) (`extensions/*/openclaw.plugin.json`),
enriches per-token pricing, checks every 4 hours, validates it with the same schema the client enforces,
and commits all three versions **only when any version's content actually changed** —
so the file history is a readable changelog of model additions and pricing updates.

One publisher invocation generates v1, v2, and v3 from the same source snapshot.
Changes to generation timestamps or source commit metadata alone do not trigger
a commit. If any payload changes, all three outputs are committed together.

v1 and v2 are frozen. Released clients reject a v1/v2 file with any field or
value they do not know, and then stop refreshing. Before committing, the workflow
runs `scripts/released-readers.mjs`: the OpenClaw versions on the `latest`,
`extended-stable` and `beta` npm tags each refresh from the new v1, v2 and v3
files in a sandbox. A release fails the check when it rejects a file, or when it
reports success but kept fewer rows than the file contains (row-tolerant readers,
including every v3 reader, drop a row they cannot parse instead of rejecting the
file). On failure nothing is committed or deployed, and the last good catalog
stays live. If the comparison itself dies before reporting a verdict, it is
retried once; a rejection is a verdict and is never retried. New fields go to v3.
OpenClaw reads v3 only from a configured mirror URL, and builds that include
[openclaw/openclaw#190187](https://github.com/openclaw/openclaw/pull/190187)
ignore v3 fields they do not know. No release reads v3 yet.

### v3 released-reader guard

The v3 check applies only to releases that can read v3. A release that refuses
both the live and the new v3 file on `schemaVersion` alone has no v3 reader and
is skipped; any other release is held to the same rules as v1/v2. The repository
variable `CATALOG_GUARD_V3` selects the mode:

| `CATALOG_GUARD_V3` | Behavior |
| --- | --- |
| unset or `auto` | Check every release that reads v3. If none does, or the v3 comparison cannot run, log a notice or warning and continue. |
| `enforce` | As `auto`, but fail when no tagged release reads v3 or the v3 comparison cannot run. |
| `off` | Skip v3. |

It activates without a workflow change. Once a release with a v3 reader is on
one of the npm tags and `catalog:compare-released` in openclaw/openclaw drives
it with the v3 file, a v3 rejection or row loss on that release blocks the
publish. Set `CATALOG_GUARD_V3=enforce` when the OpenClaw default moves to v3,
so a guard that silently stops covering v3 also blocks. The check reads the
comparison's `--dump` files (`<release>-baseline.json`, `<release>-candidate.json`
with `refresh.status`, `refresh.error` and the kept row count `refresh.models`);
keep that format when changing the OpenClaw side.

Remote catalog data can only update model metadata. It can never change provider
endpoints, headers, or introduce providers your install doesn't ship — those
constraints are enforced client-side.

## Hosting and publication

Cloudflare Workers Static Assets serves the catalog directly from the CDN. There
is no Worker script, R2 bucket, or request-time catalog assembly. Unlike the docs
site, this feed does not need HTML routing, Markdown negotiation, or search.

`node scripts/build.mjs` stages the v1 catalog, its alias, the v2/v3 catalogs, and
`static/_headers` in `dist/`. Repository files and the upstream OpenClaw checkout
never become assets.
The response is UTF-8 JSON with public CORS, an exposed native `ETag`, and
`X-Content-Type-Options: nosniff`. Its mutable URL uses
`Cache-Control: public, max-age=0, must-revalidate`: clients revalidate their cached
copy, and unchanged content returns `304`. Cloudflare manages its asset cache
and deployment invalidation; the catalog does not use an immutable browser TTL.

The publish workflow deploys an isolated `openclaw-catalog-preview` first, verifies
it, then deploys the same staged bytes to `catalog.openclaw.ai`. It verifies the
actual post-commit `main` SHA before deployment and fails if another push made
the run stale. Deployments share the generator's concurrency group and also run
when generation found no change, so a failed deployment can be retried without
manufacturing a catalog update. Hosting changes pushed to `main` deploy the
committed catalog without regenerating it.

Repository Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`: the existing OpenClaw Cloudflare account.
- `CLOUDFLARE_API_TOKEN`: the deployment token for that account, with Workers
  Scripts edit and zone read access; custom-domain setup also needs the existing
  authorized domain/DNS access. Never commit either value.

CI uses Node.js 24.22.1. Local validation needs Node and Wrangler 4.157.0:

```sh
node --test scripts/hosting.test.mjs
node scripts/build.mjs
wrangler deploy --dry-run --env preview
wrangler dev --env preview --ip 127.0.0.1 --port 8787
# In another terminal:
node scripts/smoke.mjs http://127.0.0.1:8787
```

The smoke check verifies all four URLs for version-specific byte equality,
content type, cache/CORS headers, GET, HEAD, and conditional `304`, plus `404` for
missing and repository-only files. It also runs against the public hostname after
each deployment. Edges pick up a deployment gradually, so the check retries
responses that still carry the previous deployment's bytes or ETag for up to a
minute; every response from the new deployment must pass.

For the first cutover, record the existing `catalog.openclaw.ai` DNS and GitHub
Pages settings, deploy with `--env preview` (whose routes are explicitly empty),
and pass the smoke check before attaching the production custom domain. Keep the
Pages configuration available until production verification passes.

Rollback is a forward deployment: revert the broken hosting change on `main`,
retain the latest `models/v1/catalog.json`, `models/v2/catalog.json`, and
`models/v3/catalog.json` together,
and rerun the publish workflow. The alias is rebuilt from v1. Do not roll back an
entire old asset version and silently downgrade catalog data. If a
Cloudflare outage requires returning to GitHub Pages, restore the recorded DNS
and Pages settings, ensure Pages has published the current catalog commit, and
verify the public JSON bytes before declaring recovery.
That covers hosting changes. To undo bad catalog *content*, see the next section.

## Rolling back catalog content

Use this when a published catalog is wrong (missing or broken models, bad prices,
recommendations or provider settings) and the upstream fix in openclaw/openclaw
will not ship within the next publish cycle. A file that released readers
*rejected* needs no rollback for them: they keep their last good catalog. Clients
that *accepted* the bad file need a newer good one.

**Never revert, and never redeploy an old file or asset version.** A client
keeps its cached catalog unless the fetched file has a newer `generatedAt`; a
file with the same `generatedAt` and different bytes is also ignored
(`src/model-catalog/remote-store.worker.ts` in openclaw/openclaw). `git revert`
redeploys the old `generatedAt`, so every client that already fetched the bad
file reports `unchanged` and keeps it; only fresh installs get the old content.
Every rollback is a roll forward: the good content with a new `generatedAt`.

1. Pause scheduled publishing, or the next run (at most 4 hours later)
   regenerates the bad content from openclaw `main`: set the repository variable
   `CATALOG_PUBLISH_PAUSED` to `true`
   (`gh variable set CATALOG_PUBLISH_PAUSED --body true -R openclaw/catalog`).
   While paused, scheduled and manual runs only redeploy the committed catalog.
2. Pick the last good commit. Use a `catalog:` commit written by the publisher;
   all three feeds must come from one publish run:
   `git log --format='%h %cI %s' -- models/v3/catalog.json`.
3. Run **Publish catalog** with `rollback_to` set to that commit
   (`gh workflow run publish.yml -R openclaw/catalog -f rollback_to=<sha>`).
   `scripts/rollback.mjs` copies the v1, v2 and v3 files of that commit
   unchanged, gives all three one `generatedAt` newer than both the current
   clock and every file on `main` and at that commit, and validates them with
   OpenClaw `main`'s client parsers. The run then uses the normal publish path:
   the released-reader guard, a commit to `main` (always, even when only
   `generatedAt` changed), tests, the preview deployment, production, and the
   smoke checks.
4. Verify: `curl -s https://catalog.openclaw.ai/models/v3/catalog.json | jq '.generatedAt, .sourceCommit'`
   shows the new stamp and the restored source commit, and
   `openclaw models refresh` on an affected install reports `updated`. Clients
   without a manual refresh pick it up within their 6-hour refresh interval.
5. Land the upstream fix, then delete `CATALOG_PUBLISH_PAUSED`. The next
   publish regenerates the catalog with a newer `generatedAt` again.

### Emergency: a v3 parser defect in a released OpenClaw

Released parsers cannot be patched. If a released v3 reader misreads content
that is otherwise valid, stop that release from taking v3 updates by setting
`minVersion` on v3 to the first fixed release: run the rollback with
`v3_min_version` (for example `-f rollback_to=HEAD -f v3_min_version=2026.12.3`
to keep the current content, or a last good commit). Releases below that version
refuse every new v3 file ("remote catalog requires OpenClaw … or newer") and keep
the catalog they already stored; this was proven against a released reader with
the audit's `55-minVersion-future` fixture. The guard expects those refusals and
fails if a release below `minVersion` still accepts the file.

- They keep what they already stored. If an affected release already accepted
  a harmful file, first roll back to content it handles correctly without
  `minVersion`, wait for clients to refresh, then set `minVersion`.
- The version must parse (`2026.12.3`, `2026.12.3-beta.1`). An unparseable
  `minVersion` makes every reader, current ones included, refuse the file.
- The publisher does not carry `minVersion` into v3, so the next normal publish
  lifts the kill switch. Keep publishing paused until the publisher sets it, or
  until the affected releases no longer matter.
- Only v3 is exposed. v1 already carries the publisher's `minVersion`, and the
  frozen v1/v2 feeds should not need a kill switch.

## Discussing changes

Every change is an ordinary commit — use the commit history to see what changed
and [issues](https://github.com/openclaw/catalog/issues) to discuss catalog content.
Model definitions themselves are maintained in the plugin manifests in the main repo,
so corrections land there.
