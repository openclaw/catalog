// The generation rule for the three published feeds, shared by the hosting test
// and the rollback so a restored snapshot is held to the rule the deploy checks.
//
// v2 and v3 always come from one publisher run: one sourceCommit, one generatedAt.
// v1 may come from an older run (the publisher keeps the previous v1 when a new
// one would exceed the client size limit), so its sourceCommit is independent. A
// rollback gives all three feeds one fresh generatedAt, so v1 may share v3's stamp
// with a different source; it is never newer than v2/v3.
export function generationProblems(v1, v2, v3) {
  const problems = [];
  if (v2.sourceCommit !== v3.sourceCommit) {
    problems.push(`v2/v3 come from different source snapshots (${v2.sourceCommit}, ${v3.sourceCommit})`);
  }
  if (v2.generatedAt !== v3.generatedAt) {
    problems.push(`v2/v3 come from different generations (${v2.generatedAt}, ${v3.generatedAt})`);
  }
  if (!(v1.generatedAt <= v3.generatedAt)) {
    problems.push(`v1 (${v1.generatedAt}) is newer than v2/v3 (${v3.generatedAt})`);
  }
  return problems;
}
