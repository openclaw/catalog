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
In 1–3 plain sentences, say who is affected, what happens today, and why it
matters to them. For a bug, name the trigger if known. For a feature or internal
work, describe the need in the actual workflow without inventing harm.
Could a reader understand the problem without knowing your proposed fix?

Good: "Background checks can use up a new user's model allowance before they've
asked the assistant to monitor anything."
Bad: "Turn off periodic checks on fresh installs."
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
