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
and commits the versions it wrote **only when any version's content actually changed** —
so the file history is a readable changelog of model additions and pricing updates.

One publisher invocation generates v1, v2, and v3 from the same source snapshot.
Changes to generation timestamps or source commit metadata alone do not trigger
a commit. If any payload changes, all written outputs are committed together.
The publisher refuses a feed that lost more than 5% of its rows or a whole
provider against the published file (`--previous*`); a manual run with the
`allow_shrink` input accepts an intended drop. If a new v1 would exceed the 4 MiB
client limit, the publisher leaves it unwritten (`--skip-oversized-v1`): the
published v1 stays live and v2/v3 still publish, so v1 can lag one or more
generations behind v2/v3.

v1 and v2 are frozen. Released clients reject a v1/v2 file with any field or
value they do not know, and then stop refreshing. The workflow runs the hosting
tests and build on a new catalog commit before pushing it, so a catalog that
would not deploy never reaches `main`. Before committing, the workflow
runs `scripts/released-readers.mjs`, which runs openclaw/openclaw's
`scripts/catalog-compare-released.mts --check` once per written feed against the
published file. Each OpenClaw version on the `latest`, `extended-stable` and
`beta` npm tags that reads the feed refreshes from the new file in a sandbox. A
release fails the check when it rejects the file, or when it reports success but
keeps fewer rows than the publisher wrote, beyond the loss it already had on the
published file (row-tolerant readers, including every v3 reader, drop a row they
cannot parse instead of rejecting the file). A manual run with the
`allow_row_loss` input accepts that many more dropped rows. On failure nothing is
committed or deployed, and the last good catalog stays live. New fields go to v3.
[openclaw/openclaw#197204](https://github.com/openclaw/openclaw/pull/197204)
makes v3 the OpenClaw default with a tolerant v3 reader; no release on an npm tag
ships it yet.

### v3 released-reader guard

`--check` gates v3 on every tagged release that ships a v3 reader and skips the
others by name (`v3 on openclaw@<version>: no v3 reader, skipped`), so the first
release that reads v3 is gated with no change here. It finds a v3 reader by a
function name in the release bundle.

A second, independent marker turns the requirement on by itself: a release whose
installed package (the install `--check` used) has the v3 default refresh URL,
`"https://catalog.openclaw.ai/models/v3/catalog.json"`, reads v3. If `--check`
skips such a release, the reader detection broke and the publish fails. Releases
without the marker are skipped as before. The marker is in the release content,
not the version: a release line is cut from a branch, so a version number does
not tell if it has the v3 reader. The gate also fails when it cannot inspect a
release `--check` reported, or when `--check` reports no release for v3.

In an emergency, a manual run with the `skip_v3_check` input skips the v3 check
for that run only. Scheduled runs always check v3.

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
   its v2 and v3 must come from one publish run (v1 may be older):
   `git log --format='%h %cI %s' -- models/v3/catalog.json`.
3. Run **Publish catalog** with `rollback_to` set to that commit
   (`gh workflow run publish.yml -R openclaw/catalog -f rollback_to=<sha>`).
   `scripts/rollback.mjs` copies the v1, v2 and v3 files of that commit
   unchanged, gives all three one `generatedAt` newer than both the current
   clock and every file on `main` and at that commit, and validates them with
   OpenClaw `main`'s client parsers. A v1 that lagged behind v2/v3 at that commit
   (an oversized v1 the publisher kept) is restored as it was, sharing the new
   `generatedAt`. The run then uses the normal publish path: the released-reader
   guard, a commit (always, even when only `generatedAt` changed), the hosting
   tests and build on the committed files, the push to `main`, the preview
   deployment, production, and the smoke checks.
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
the audit's `55-minVersion-future` fixture. The released-reader check then runs
only on tagged releases at or above `minVersion`, since a refusal below it is the
intended result; if no tagged release is at or above it, v3 is not checked.

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
