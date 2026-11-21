import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CONTEXT = "Publication source current";
export const PREFIX = "automation/catalog/";
const SHA = /^[0-9a-f]{40}$/;
const FILES = new Set([1, 2, 3].map((version) => `models/v${version}/catalog.json`));
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

function command(binary, args) {
  return execFileSync(binary, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
}

const gitCommand = (...args) => command("git", args);
function github(method, path, body = {}) {
  const args = ["api", "--method", method, "-H", "Accept: application/vnd.github+json", path];
  for (const [key, value] of Object.entries(body)) args.push(typeof value === "string" ? "-f" : "-F", `${key}=${value}`);
  return JSON.parse(command("gh", args));
}

function repository(value) {
  ensure(/^[\w.-]+\/[\w.-]+$/.test(value ?? ""), "GITHUB_REPOSITORY is required");
  return value;
}

function sourceBase(message) {
  const matches = [...message.matchAll(/^Catalog-Source-Base: ([0-9a-f]{40})$/gm)];
  ensure(matches.length === 1, "candidate needs exactly one Catalog-Source-Base trailer");
  return matches[0][1];
}

function list(api, path) {
  const rows = api("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100`);
  ensure(Array.isArray(rows) && rows.length < 100, "metadata listing reached its inspection limit");
  return rows;
}

function currentMain(api, repo) {
  const result = api("GET", `repos/${repo}/git/ref/heads/main`);
  ensure(SHA.test(result.object?.sha ?? ""), "main did not resolve to a commit");
  return result.object.sha;
}

export function inspectCandidate(api, repo, pr) {
  ensure(pr.base?.repo?.full_name === repo && pr.base.ref === "main", "publication must target this repository's main");
  ensure(pr.head?.repo?.full_name === repo, "reserved publication branches cannot come from a fork");
  ensure(/^automation\/catalog\/\d+-\d+$/.test(pr.head.ref ?? ""), "malformed reserved publication branch");
  ensure(SHA.test(pr.head.sha ?? ""), "candidate head is missing");
  const commit = api("GET", `repos/${repo}/commits/${pr.head.sha}`);
  ensure(commit.sha === pr.head.sha && SHA.test(commit.commit?.tree?.sha ?? ""), "candidate commit identity changed");
  const base = sourceBase(commit.commit.message);
  ensure(commit.parents?.length === 1 && commit.parents[0].sha === base, "candidate must have only its generation base as parent");
  ensure(Array.isArray(commit.files) && commit.files.length > 0 && commit.files.length <= FILES.size
    && commit.files.every((file) => FILES.has(file.filename) && file.status === "modified"),
  "candidate must modify only the generated catalog files");
  ensure(currentMain(api, repo) === base, "main advanced since catalog generation; retain this PR and regenerate from current main");
  return { base, head: commit.sha, tree: commit.commit.tree.sha };
}

export function requireStrictRule(api, repo) {
  const app = api("GET", "apps/github-actions");
  ensure(app.slug === "github-actions" && Number.isSafeInteger(app.id), "GitHub Actions App identity is unavailable");
  const rules = list(api, `repos/${repo}/rules/branches/main`);
  ensure(rules.some((rule) => rule.type === "non_fast_forward"), "main must reject non-fast-forward updates");
  const matches = (rule) => rule.type === "required_status_checks"
    && rule.parameters?.strict_required_status_checks_policy === true
    && rule.parameters.required_status_checks?.some((check) => check.context === CONTEXT && check.integration_id === app.id);
  for (const rule of rules.filter(matches)) {
    ensure(Number.isSafeInteger(rule.ruleset_id), "required rule has no source ruleset identity");
    const source = api("GET", `repos/${repo}/rulesets/${rule.ruleset_id}?includes_parents=true`);
    if (source.id === rule.ruleset_id && source.enforcement === "active"
      && Array.isArray(source.bypass_actors) && source.bypass_actors.length === 0
      && source.rules?.some(matches)) return;
  }
  throw new Error(`main needs an active strict ${CONTEXT} rule pinned to the GitHub Actions App with no bypass actors; PR retained`);
}

function status(api, repo, head, state, description, runUrl) {
  return api("POST", `repos/${repo}/statuses/${head}`, {
    state, context: CONTEXT, description, ...(runUrl ? { target_url: runUrl } : {}),
  });
}

// This runs from trusted base-branch code under pull_request_target. It reads
// GitHub metadata only; candidate files and workflows are never checked out.
export function checkPullRequest({ api = github, repo, number, expectedHead, runUrl, log = console.log }) {
  repository(repo);
  ensure(Number.isSafeInteger(number) && number > 0, "pull request number is required");
  const pr = api("GET", `repos/${repo}/pulls/${number}`);
  ensure(pr.state === "open" && pr.base?.ref === "main" && pr.base.repo?.full_name === repo,
    "pull request is no longer open against this repository's main");
  ensure(SHA.test(expectedHead ?? "") && pr.head?.sha === expectedHead, "pull request head changed since this event");
  if (!pr.head.ref?.startsWith("automation/catalog")) {
    status(api, repo, pr.head.sha, "success", "Not a catalog publication branch (N/A)", runUrl);
    log("Publication source current: N/A for an ordinary pull request");
    return;
  }
  try {
    inspectCandidate(api, repo, pr);
    status(api, repo, pr.head.sha, "success", "Catalog generated from the current main commit", runUrl);
  } catch (error) {
    status(api, repo, pr.head.sha, "failure", "Catalog source is stale or candidate metadata is invalid", runUrl);
    throw error;
  }
}

export function publish({ api = github, git = gitCommand, repo, runId, attempt, runUrl, emit = () => {}, log = console.log,
  pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000) }) {
  repository(repo);
  ensure(/^\d+$/.test(runId ?? "") && /^\d+$/.test(attempt ?? ""), "workflow run identity is required");
  const branch = `${PREFIX}${runId}-${attempt}`;
  const head = git("rev-parse", "HEAD");
  ensure(SHA.test(head), "candidate head is invalid");
  ensure(!git("status", "--porcelain", "--untracked-files=no"), "candidate has uncommitted tracked changes");
  const base = sourceBase(git("show", "-s", "--format=%B", head));
  ensure(git("show", "-s", "--format=%P", head) === base, "candidate must be one commit on its generation base");
  const tree = git("rev-parse", `${head}^{tree}`);
  ensure(currentMain(api, repo) === base, "main advanced before publication; regenerate from current main");
  const pending = list(api, `repos/${repo}/pulls?state=open&base=main`)
    .find((pr) => pr.head?.repo?.full_name === repo && pr.head.ref?.startsWith(PREFIX));
  ensure(!pending, `publication PR already pending: ${pending?.html_url}; resolve it before publishing again`);
  ensure(!git("ls-remote", "--heads", "origin", `refs/heads/${branch}`), "candidate branch already exists; inspect the previous attempt");
  // Never overwrite a candidate, including an orphan from an uncertain PR request.
  git("push", "origin", `${head}:refs/heads/${branch}`);
  log(`Candidate ${branch} (${head}) pushed; it remains available if publication stops.`);
  const created = api("POST", `repos/${repo}/pulls`, {
    base: "main", head: branch, title: git("show", "-s", "--format=%s", head),
    body: `Generated catalog update.\n\nSource base: \`${base}\`\nCandidate: \`${head}\`\n${runUrl ? `\nWorkflow: ${runUrl}\n` : ""}`,
  });
  ensure(Number.isSafeInteger(created.number) && created.number > 0, "PR creation outcome is unknown; candidate branch retained");
  log(`Catalog PR: ${created.html_url}`);
  let pr = api("GET", `repos/${repo}/pulls/${created.number}`);
  ensure(pr.state === "open" && pr.head?.sha === head && pr.head.ref === branch, "created PR head or state changed");
  const candidate = inspectCandidate(api, repo, pr);
  ensure(candidate.base === base && candidate.tree === tree, "remote candidate differs from the tested local tree");
  // A client precheck cannot fence the base. GitHub must enforce this strict,
  // non-bypassable status rule at the merge itself, including a last-read race.
  requireStrictRule(api, repo);
  status(api, repo, head, "success", "Catalog generated from the current main commit", runUrl);
  // GitHub briefly reports null while computing mergeability. Only that state
  // gets bounded observation; a rejection or identity change is not retried.
  for (let attempt = 0; attempt < 4; attempt++) {
    pr = api("GET", `repos/${repo}/pulls/${created.number}`);
    ensure(pr.state === "open" && pr.head?.sha === head && pr.head.ref === branch
      && pr.head.repo?.full_name === repo && pr.base?.ref === "main" && pr.base.repo?.full_name === repo,
    "PR identity changed before merge");
    if (pr.mergeable !== null) break;
    if (attempt < 3) pause();
  }
  ensure(pr.mergeable === true, "PR mergeability is rejected or still unknown; PR retained");
  let merged;
  try {
    merged = api("PUT", `repos/${repo}/pulls/${created.number}/merge`, { sha: head, merge_method: "squash" });
  } catch {
    // A lost response can follow a successful merge. Reconcile once through
    // the authoritative PR record; never repeat the mutating merge request.
  }
  pr = api("GET", `repos/${repo}/pulls/${created.number}`);
  ensure(pr.merged === true && SHA.test(pr.merge_commit_sha ?? ""), "PR is not confirmed merged; no deployment is permitted");
  const mergeSha = pr.merge_commit_sha;
  ensure((merged?.merged !== true || merged.sha === mergeSha) && pr.head?.sha === head
    && pr.head.ref === branch && pr.head.repo?.full_name === repo && pr.base?.ref === "main"
    && pr.base.repo?.full_name === repo, "merged PR receipt changed or is incomplete");
  git("-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--no-tags", "origin", mergeSha);
  ensure(git("show", "-s", "--format=%P", mergeSha) === base, "merged commit has a different source base; no deployment is permitted");
  ensure(git("rev-parse", `${mergeSha}^{tree}`) === tree, "merged tree differs from the tested candidate; no deployment is permitted");
  ensure(git("ls-remote", "--exit-code", "origin", "refs/heads/main").split(/\s/)[0] === mergeSha,
    "main advanced after merge; no stale deployment is permitted");
  git("checkout", "--detach", mergeSha);
  // Only authoritative merged-tree proof can release a SHA to the deploy steps.
  emit({ sha: mergeSha, pr: created.html_url });
  log(`Verified merged catalog ${mergeSha}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.GITHUB_REPOSITORY;
  const runUrl = `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  try {
    if (process.argv[2] === "publish") {
      publish({ repo, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, runUrl,
        emit: ({ sha, pr }) => appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\npr=${pr}\n`) });
    } else if (process.argv[2] === "check") {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      checkPullRequest({ repo, number: event.pull_request?.number, expectedHead: event.pull_request?.head?.sha, runUrl });
    } else throw new Error("usage: node scripts/publication.mjs <publish|check>");
  } catch (error) {
    console.error(`::error::Catalog publication stopped: ${error.message}. Retain any candidate branch/PR for inspection; nothing is approved for deployment.`);
    process.exitCode = 1;
  }
}
