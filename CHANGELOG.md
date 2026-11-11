# Changelog

## Unreleased

- Add a manual rollback to the publish workflow: it republishes the v1/v2/v3 content of an earlier commit with a fresh `generatedAt`, so clients that cached a bad catalog accept it, and can set an emergency v3 `minVersion`. Scheduled publishing can be paused with `CATALOG_PUBLISH_PAUSED`.
- Gate every feed, v3 included, with OpenClaw's `catalog-compare-released --check`: a release that reads the feed must accept the file and keep every published row (`allow_row_loss`). A release that defaults to the v3 URL must be checked as a v3 reader, so the v3 requirement turns on with the first such release; a manual `skip_v3_check` input is the emergency off.
- Pass the published files to the publisher's shrink guard (`allow_shrink`), and keep the published v1 when a new one would exceed the client size limit while v2/v3 still publish.

- Use the standard GitHub Actions runtime budget for CodeQL instead of the rollout-specific 20-minute job cap.

- Batch main CodeQL security scans daily while retaining pull request and manual analysis.

- Refuse to publish v1/v2 catalogs that released OpenClaw versions would reject. The last good catalog stays live instead.

- Publish an opt-in v3 catalog with inference and Decision capabilities alongside the existing v1/v2 feeds. Older clients keep their versioned feed, and the unversioned alias remains v1.
- Update the catalog hosting toolchain to Node.js 24.22.0, Wrangler 4.151.0, and the latest compatible GitHub Actions.
