# OpenClaw Model Catalog

The hosted model catalog served at **https://catalog.openclaw.ai/models/v1/catalog.json**.

Every OpenClaw install fetches this file in the background (every 6h, or via
`openclaw models refresh`) to learn about newly released models without waiting
for a release. See the [models documentation](https://docs.openclaw.ai/concepts/models)
for how the overlay works and how to disable it (`models.catalogRefresh.enabled: false`)
or point it at a mirror (`models.catalogRefresh.url`).

## How it is produced

The catalog is **not hand-edited**. A [scheduled workflow](.github/workflows/publish.yml)
assembles it from the `modelCatalog` blocks in the plugin manifests of
[openclaw/openclaw](https://github.com/openclaw/openclaw) (`extensions/*/openclaw.plugin.json`),
enriches per-token pricing, checks every 4 hours, validates it with the same schema the client enforces,
and commits it **only when the content actually changed** — so the file history is a
readable changelog of model additions and pricing updates.

Remote catalog data can only update model metadata. It can never change provider
endpoints, headers, or introduce providers your install doesn't ship — those
constraints are enforced client-side.

## Discussing changes

Every change is an ordinary commit — use the commit history to see what changed
and [issues](https://github.com/openclaw/catalog/issues) to discuss catalog content.
Model definitions themselves are maintained in the plugin manifests in the main repo,
so corrections land there.
