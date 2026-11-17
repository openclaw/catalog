<!--
Write for someone choosing models or maintaining the model catalog who has not
read the code. The title and opening problem statement should explain the
affected task and outcome without requiring the diff.

Good title: fix: keep catalog refreshes working at the unversioned URL
Bad title: fix(build): copy the v1 JSON file
Good title: docs: help operators verify a catalog before publishing it
Bad title: docs: update validation script notes

For internal-only work, name the actual developer or operator workflow.
Do not invent an end-user benefit.
-->

## What Problem This Solves

<!--
Describe the concrete user, product, or operational problem.
In 1–3 plain-language sentences, explain what someone is trying to do, what
fails or is missing, and why it matters. Include a known trigger for a bug;
describe the need without inventing a bug for other changes.

Good: "OpenClaw installations refreshing model information from the unversioned
catalog URL receive a 404, so they cannot discover newly released models."
Bad: "Adds a copy step to the catalog build script."
-->

## User Impact

<!-- State the outcome for users, developers, or operators. Keep risks, breaking
changes and required actions visible. Say when no user-visible behavior changes. -->

## Why This Change Was Made

<!-- Briefly explain how the change addresses the need. Keep implementation
walkthroughs in the diff or optional details, not in place of the problem. -->

## Evidence

<!-- Lead with the behavior checked and the observed result, noting meaningful
gaps. Put commands, hashes and long logs after that summary or in linked details.
Use the most useful evidence for the change; redact secrets and private data. -->
