# Changelog

## Unreleased

- Use the standard GitHub Actions runtime budget for CodeQL instead of the rollout-specific 20-minute job cap.

- Batch main CodeQL security scans daily while retaining pull request and manual analysis.

- Refuse to publish v1/v2 catalogs that released OpenClaw versions would reject. The last good catalog stays live instead.

- Publish an opt-in v3 catalog with inference and Decision capabilities alongside the existing v1/v2 feeds. Older clients keep their versioned feed, and the unversioned alias remains v1.
- Update the catalog hosting toolchain to Node.js 24.22.0, Wrangler 4.151.0, and the latest compatible GitHub Actions.
