import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkPullRequest, CONTEXT, inspectCandidate, PREFIX, publish, requireStrictRule } from "./publication.mjs";

const repo = "fixture/catalog";
const branch = `${PREFIX}123-1`;
const app = { id: 71, slug: "github-actions" };
const rule = {
  type: "required_status_checks", ruleset_id: 42,
  parameters: { strict_required_status_checks_policy: true,
    required_status_checks: [{ context: CONTEXT, integration_id: app.id }] },
};
const gitAt = (cwd, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "catalog-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  const remote = join(root, "remote.git");
  await mkdir(cwd);
  const git = (...args) => gitAt(cwd, ...args);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  for (const version of [1, 2, 3]) {
    await mkdir(join(cwd, `models/v${version}`), { recursive: true });
    await writeFile(join(cwd, `models/v${version}/catalog.json`), "{}\n");
  }
  git("add", "models");
  git("commit", "-qm", "Initial catalogs");
  const base = git("rev-parse", "HEAD");
  const baseTree = git("rev-parse", "HEAD^{tree}");
  git("init", "--bare", "-q", remote);
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "HEAD:main");
  await writeFile(join(cwd, "models/v2/catalog.json"), '{"changed":true}\n');
  git("commit", "-qam", "catalog: fixture", "-m", `Catalog-Source-Base: ${base}`);
  const head = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const bare = (...args) => git("--git-dir", remote, ...args);
  const current = () => bare("rev-parse", "refs/heads/main");
  const pr = { number: 1, state: "open", merged: false, mergeable: true, html_url: `https://github.com/${repo}/pull/1`,
    head: { sha: head, ref: branch, repo: { full_name: repo } },
    base: { ref: "main", repo: { full_name: repo } } };
  const calls = [];
  const statuses = [];
  const emitted = [];
  let pauses = 0;
  let serverDenials = 0;
  const mergeability = [...(options.mergeability ?? [])];
  const commit = (sha) => ({
    sha, parents: git("show", "-s", "--format=%P", sha).split(" ").filter(Boolean).map((sha) => ({ sha })),
    commit: { message: git("show", "-s", "--format=%B", sha), tree: { sha: git("rev-parse", `${sha}^{tree}`) } },
    files: git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).split("\n").filter(Boolean)
      .map((filename) => ({ filename, status: "modified" })),
  });
  const advance = () => {
    const next = git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit-tree", baseTree, "-p", current(), "-m", "Concurrent main update");
    git("push", "-q", "origin", `${next}:refs/heads/main`);
    return next;
  };
  const api = (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "apps/github-actions") return app;
    if (path.startsWith(`repos/${repo}/rules/branches/main`)) return options.noRule ? [] : [rule, { type: "non_fast_forward" }];
    if (path.startsWith(`repos/${repo}/rulesets/42`)) return options.ruleset
      ?? { id: 42, enforcement: "active", bypass_actors: options.bypass ? [{ actor_id: 1 }] : [], rules: [rule] };
    if (path === `repos/${repo}/git/ref/heads/main`) return { object: { sha: current() } };
    if (path.startsWith(`repos/${repo}/commits/`)) {
      const result = commit(path.split("/").at(-1));
      return options.changeCommit?.(result) ?? result;
    }
    if (path.startsWith(`repos/${repo}/statuses/`)) { statuses.push(body); return { state: body.state }; }
    if (method === "GET" && path.startsWith(`repos/${repo}/pulls?`)) return options.pending ? [pr] : [];
    if (method === "POST" && path === `repos/${repo}/pulls`) {
      if (options.createError) throw new Error("PR request outcome unknown");
      assert.equal(body.head, branch);
      return pr;
    }
    if (method === "GET" && path === `repos/${repo}/pulls/1`) {
      const result = structuredClone(pr);
      if (statuses.length && mergeability.length) result.mergeable = mergeability.shift();
      return result;
    }
    if (method === "PUT" && path === `repos/${repo}/pulls/1/merge`) {
      assert.equal(body.sha, head);
      assert.equal(body.merge_method, "squash");
      if (options.race) advance();
      // Model GitHub's strict required check at the merge boundary, after the
      // client's final read. Removing this server guard admits the stale merge.
      if (current() !== base) {
        serverDenials++;
        throw new Error("strict server gate: base is no longer current");
      }
      if (options.mergeError) throw new Error("merge response unknown");
      if (options.pendingMerge) return { merged: false, message: "pending" };
      const parent = options.wrongParent ? advance() : base;
      const merged = git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
        "commit-tree", options.wrongTree ? baseTree : tree, "-p", parent, "-m", "Squashed catalog");
      git("push", "-q", "origin", `${merged}:refs/heads/main`);
      Object.assign(pr, { merged: true, state: "closed", merge_commit_sha: merged });
      if (options.wrongReceipt) pr.head.sha = base;
      if (options.lostResponseAfterMerge) throw new Error("merge response lost after success");
      return { merged: true, sha: merged };
    }
    throw new Error(`unexpected API call: ${method} ${path}`);
  };
  const run = () => publish({ api, git, repo, runId: "123", attempt: "1", emit: (value) => emitted.push(value), log() {}, pause() { pauses++; } });
  return { api, git, bare, head, base, tree, pr, current, advance, statuses, calls, emitted, run,
    pauses: () => pauses, serverDenials: () => serverDenials };
}

test("publication deploys only the actual verified squash commit", async (t) => {
  const f = await fixture(t);
  f.run();
  assert.equal(f.emitted.length, 1);
  const merged = f.emitted[0].sha;
  assert.notEqual(merged, f.head, "a squash is a new commit");
  assert.equal(f.git("rev-parse", "HEAD"), merged);
  assert.equal(f.git("show", "-s", "--format=%P", merged), f.base);
  assert.equal(f.git("rev-parse", `${merged}^{tree}`), f.tree);
  assert.equal(f.current(), merged);
  assert.equal(f.statuses.at(-1).state, "success");
  assert.equal(f.statuses.at(-1).context, CONTEXT);
  assert.equal(f.calls.filter(({ method }) => method === "PUT").length, 1);
});

test("strict gate absence or bypass retains the PR and never asks to merge", async (t) => {
  for (const options of [{ noRule: true }, { bypass: true }]) {
    const f = await fixture(t, options);
    assert.throws(f.run, /strict|non-fast-forward/);
    assert.equal(f.bare("rev-parse", `refs/heads/${branch}`), f.head);
    assert.equal(f.pr.merged, false);
    assert.deepEqual(f.emitted, []);
    assert.equal(f.calls.some(({ method }) => method === "PUT"), false);
  }
});

test("strict rule must name the observed Actions App and be active", () => {
  for (const variation of [
    { ...rule, parameters: { ...rule.parameters, strict_required_status_checks_policy: false } },
    { ...rule, parameters: { ...rule.parameters, required_status_checks: [{ context: CONTEXT, integration_id: 999 }] } },
  ]) {
    assert.throws(() => requireStrictRule((method, path) => path === "apps/github-actions" ? app : [variation, { type: "non_fast_forward" }], repo), /active strict/);
  }
  for (const source of [
    { id: 42, enforcement: "evaluate", bypass_actors: [], rules: [rule] },
    { id: 42, enforcement: "disabled", rules: [rule] },
  ]) {
    assert.throws(() => requireStrictRule((method, path) => path === "apps/github-actions" ? app
      : path.includes("rulesets/") ? source : [rule, { type: "non_fast_forward" }], repo), /active strict/);
  }
});

test("runtime accepts redacted bypass metadata but rejects exposed bypass", () => {
  const source = { id: 42, enforcement: "active", rules: [rule] };
  const check = (metadata) => requireStrictRule((method, path) => path === "apps/github-actions" ? app
    : path.includes("rulesets/") ? { ...source, ...metadata } : [rule, { type: "non_fast_forward" }], repo);
  for (const metadata of [{}, { bypass_actors: [] }, { current_user_can_bypass: "never" },
    { bypass_actors: [], current_user_can_bypass: "never" }]) {
    assert.doesNotThrow(() => check(metadata));
  }
  for (const bypass_actors of [undefined, null, {}, "", [{ actor_id: 1 }]]) {
    assert.throws(() => check({ bypass_actors }), /active strict/);
  }
  for (const current_user_can_bypass of [undefined, null, false, "always", "pull_requests_only"]) {
    assert.throws(() => check({ current_user_can_bypass }), /active strict/);
  }
});

test("publication completes with redacted ruleset bypass metadata", async (t) => {
  const f = await fixture(t, { ruleset: { id: 42, enforcement: "active", rules: [rule] } });
  f.run();
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0].sha, f.current());
  assert.equal(f.calls.filter(({ method }) => method === "PUT").length, 1);
});

test("the server rejects a base race after the final client read", async (t) => {
  const f = await fixture(t, { race: true });
  assert.throws(f.run, /not confirmed merged/);
  assert.equal(f.serverDenials(), 1);
  assert.notEqual(f.current(), f.base);
  assert.equal(f.pr.merged, false);
  assert.deepEqual(f.emitted, []);
  assert.equal(f.calls.filter(({ method }) => method === "PUT").length, 1);
  assert.equal(f.bare("rev-parse", `refs/heads/${branch}`), f.head);
});

test("pending, uncertain, and mismatched merge outcomes emit no deployment SHA", async (t) => {
  for (const [options, error] of [
    [{ pendingMerge: true }, /not confirmed merged/],
    [{ mergeError: true }, /not confirmed merged/],
    [{ wrongReceipt: true }, /receipt changed/],
    [{ wrongTree: true }, /merged tree differs/],
    [{ wrongParent: true }, /different source base/],
  ]) {
    const f = await fixture(t, options);
    assert.throws(f.run, error);
    assert.deepEqual(f.emitted, []);
    assert.equal(f.git("rev-parse", "HEAD"), f.head);
    assert.equal(f.bare("rev-parse", `refs/heads/${branch}`), f.head);
    assert.equal(f.calls.filter(({ method }) => method === "PUT").length, 1);
  }
});

test("pending PRs and uncertain orphan branches cannot be overwritten", async (t) => {
  const pending = await fixture(t, { pending: true });
  assert.throws(pending.run, /already pending/);
  assert.equal(pending.calls.some(({ method }) => method === "POST"), false);
  const orphan = await fixture(t, { createError: true });
  assert.throws(orphan.run, /outcome unknown/);
  assert.equal(orphan.bare("rev-parse", `refs/heads/${branch}`), orphan.head);
  assert.throws(orphan.run, /already exists/);
  assert.deepEqual(orphan.emitted, []);
});

test("only null mergeability receives bounded observation", async (t) => {
  const ready = await fixture(t, { mergeability: [null, true] });
  ready.run();
  assert.equal(ready.pauses(), 1);
  assert.equal(ready.emitted.length, 1);
  for (const sequence of [[false], [null, null, null, null]]) {
    const held = await fixture(t, { mergeability: sequence });
    assert.throws(held.run, /mergeability/);
    assert.equal(held.pauses(), sequence[0] === false ? 0 : 3);
    assert.equal(held.calls.some(({ method }) => method === "PUT"), false);
    assert.deepEqual(held.emitted, []);
  }
});

test("a lost merge response is reconciled once without repeating the merge", async (t) => {
  const recovered = await fixture(t, { lostResponseAfterMerge: true });
  recovered.run();
  assert.equal(recovered.emitted[0].sha, recovered.current());
  assert.equal(recovered.calls.filter(({ method }) => method === "PUT").length, 1);
  const mismatched = await fixture(t, { lostResponseAfterMerge: true, wrongReceipt: true });
  assert.throws(mismatched.run, /receipt changed/);
  assert.deepEqual(mismatched.emitted, []);
  assert.equal(mismatched.calls.filter(({ method }) => method === "PUT").length, 1);
});

test("metadata validation rejects changed source, head, parent and file scope", async (t) => {
  for (const changeCommit of [
    (commit) => ({ ...commit, sha: "0".repeat(40) }),
    (commit) => ({ ...commit, parents: [...commit.parents, commit.parents[0]] }),
    (commit) => ({ ...commit, files: [{ filename: ".github/workflows/publish.yml", status: "modified" }] }),
    (commit) => ({ ...commit, commit: { ...commit.commit, message: "Missing source base" } }),
  ]) {
    const f = await fixture(t, { changeCommit });
    assert.throws(() => inspectCandidate(f.api, repo, f.pr));
  }
  const stale = await fixture(t);
  stale.advance();
  assert.throws(() => inspectCandidate(stale.api, repo, stale.pr), /main advanced/);
});

test("metadata-only PR gate marks ordinary PRs N/A and rejects reserved forks", async (t) => {
  const normal = await fixture(t);
  normal.pr.head.ref = "feature/catalog-reader";
  normal.pr.head.repo.full_name = "contributor/catalog";
  checkPullRequest({ api: normal.api, repo, number: 1, expectedHead: normal.head, log() {} });
  assert.equal(normal.statuses.at(-1).state, "success");
  assert.match(normal.statuses.at(-1).description, /N\/A/);
  assert.equal(normal.calls.some(({ path }) => path.includes("/commits/")), false);

  for (const edit of [
    (pr) => { pr.head.repo.full_name = "contributor/catalog"; },
    (pr) => { pr.head.ref = "automation/catalog/not-a-run"; },
  ]) {
    const reserved = await fixture(t);
    edit(reserved.pr);
    assert.throws(() => checkPullRequest({ api: reserved.api, repo, number: 1, expectedHead: reserved.head }));
    assert.equal(reserved.statuses.at(-1).state, "failure");
    assert.equal(reserved.calls.some(({ path }) => path.includes("/commits/")), false);
  }
  const valid = await fixture(t);
  checkPullRequest({ api: valid.api, repo, number: 1, expectedHead: valid.head });
  assert.equal(valid.statuses.at(-1).state, "success");
});

test("PR event drift cannot publish either N/A or reserved success", async (t) => {
  for (const edit of [
    (pr) => { pr.state = "closed"; },
    (pr) => { pr.base.ref = "untrusted-target"; },
    (pr) => { pr.head.sha = "0".repeat(40); },
  ]) {
    for (const ordinary of [false, true]) {
      const f = await fixture(t);
      if (ordinary) f.pr.head.ref = "feature/reader";
      edit(f.pr);
      assert.throws(() => checkPullRequest({ api: f.api, repo, number: 1, expectedHead: f.head }));
      assert.deepEqual(f.statuses, []);
    }
  }
});
