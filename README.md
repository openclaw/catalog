# OpenClaw Model Catalog

The hosted model catalog served at **https://catalog.openclaw.ai/models/v1/catalog.json**.

**https://catalog.openclaw.ai/models/catalog.json** is a direct, byte-identical
alias of the v1 catalog. Both URLs refresh together and use the v1 format.

The v2 catalog is served at **https://catalog.openclaw.ai/models/v2/catalog.json**.
It has its own versioned format; the unversioned alias continues to serve v1.

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
and commits both versions **only when either version's content actually changed** —
so the file history is a readable changelog of model additions and pricing updates.

One publisher invocation generates v1 and v2 from the same source snapshot.
Changes to generation timestamps or source commit metadata alone do not trigger
a commit. If either payload changes, both outputs are committed together.

Remote catalog data can only update model metadata. It can never change provider
endpoints, headers, or introduce providers your install doesn't ship — those
constraints are enforced client-side.

## Hosting and publication

Cloudflare Workers Static Assets serves the catalog directly from the CDN. There
is no Worker script, R2 bucket, or request-time catalog assembly. Unlike the docs
site, this feed does not need HTML routing, Markdown negotiation, or search.

`node scripts/build.mjs` stages the v1 catalog, its alias, the v2 catalog, and
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

Local validation needs Node and Wrangler 4.131.1:

```sh
node --test scripts/hosting.test.mjs
node scripts/build.mjs
wrangler deploy --dry-run --env preview
wrangler dev --env preview --ip 127.0.0.1 --port 8787
# In another terminal:
node scripts/smoke.mjs http://127.0.0.1:8787
```

The smoke check verifies all three URLs for version-specific byte equality,
content type, cache/CORS headers, GET, HEAD, and conditional `304`, plus `404` for
missing and repository-only files. It also runs against the public hostname after
each deployment.

For the first cutover, record the existing `catalog.openclaw.ai` DNS and GitHub
Pages settings, deploy with `--env preview` (whose routes are explicitly empty),
and pass the smoke check before attaching the production custom domain. Keep the
Pages configuration available until production verification passes.

Rollback is a forward deployment: revert the broken hosting change on `main`,
retain the latest `models/v1/catalog.json` and `models/v2/catalog.json` as a pair,
and rerun the publish workflow. The alias is rebuilt from v1. Do not roll back an
entire old asset version and silently downgrade catalog data. If a
Cloudflare outage requires returning to GitHub Pages, restore the recorded DNS
and Pages settings, ensure Pages has published the current catalog commit, and
verify the public JSON bytes before declaring recovery.

## Discussing changes

Every change is an ordinary commit — use the commit history to see what changed
and [issues](https://github.com/openclaw/catalog/issues) to discuss catalog content.
Model definitions themselves are maintained in the plugin manifests in the main repo,
so corrections land there.
