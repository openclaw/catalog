# Changelog

## Unreleased

- Add a manual rollback to the publish workflow: it republishes the v1/v2/v3 content of an earlier commit with a fresh `generatedAt`, so clients that cached a bad catalog accept it, and can set an emergency v3 `minVersion`. Scheduled publishing can be paused with `CATALOG_PUBLISH_PAUSED`.
- Run the released-reader guard on v3 for releases that read v3 (`CATALOG_GUARD_V3`), and fail when a release reports success but drops catalog rows.
- Retry a released-reader comparison once when it dies before reporting a verdict, instead of blocking every feed until the next scheduled run.

- Use the standard GitHub Actions runtime budget for CodeQL instead of the rollout-specific 20-minute job cap.

- Batch main CodeQL security scans daily while retaining pull request and manual analysis.

- Refuse to publish v1/v2 catalogs that released OpenClaw versions would reject. The last good catalog stays live instead.

- Publish an opt-in v3 catalog with inference and Decision capabilities alongside the existing v1/v2 feeds. Older clients keep their versioned feed, and the unversioned alias remains v1.
- Update the catalog hosting toolchain to Node.js 24.22.0, Wrangler 4.151.0, and the latest compatible GitHub Actions.
