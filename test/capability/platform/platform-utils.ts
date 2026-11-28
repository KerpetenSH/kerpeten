import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh } from "../git/git-utils.ts";
import { FakeGitHub } from "./FakeGitHub.ts";
import type { FakeGitHubCall, FakeGitHubStart, FakeGitHubState } from "./types/fake-github.ts";
import type {
  CliAnswer,
  CliName,
  GhPaths,
  GlabPaths,
  MergeRequestFields,
  NoteFields,
  PositionFields,
  PullFields,
} from "./types/platform.ts";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

/** The origin remote of the test repositories on GitHub: the project the fake gh answers for. */
export const GITHUB_ORIGIN = "https://github.com/Acme/Shop.git";

/** The origin remote of the test repositories on GitLab: the project the fake glab answers for. */
export const GITLAB_ORIGIN = "git@gitlab.com:acme/shop.git";

function quoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Makes `dir` a git repository whose remote `origin` is at `origin`, or one without a remote when none is given. */
export function originRepo(dir: string, origin?: string): string {
  sh(dir, ["init", "-q", "-b", "main"]);

  if (origin !== undefined) sh(dir, ["remote", "add", "origin", origin]);

  return dir;
}

/** The paths the platform asks gh for, word for word, for the repository `repository`, `Acme/Shop` when none is given. */
export function ghPaths(number: number, repository = "Acme/Shop"): GhPaths {
  return {
    pull: `repos/${repository}/pulls/${number}`,
    comments: `repos/${repository}/pulls/${number}/comments?per_page=100`,
    reviews: `repos/${repository}/pulls/${number}/reviews?per_page=100`,
    conversation: `repos/${repository}/issues/${number}/comments?per_page=100`,
  };
}

/**
 * The paths the platform asks glab for, word for word, for the project `project`, `acme/shop` when none is given: the
 * full path of the project is one encoded segment.
 */
export function glabPaths(number: number, project = "acme/shop"): GlabPaths {
  const segment = encodeURIComponent(project);

  return {
    mergeRequest: `projects/${segment}/merge_requests/${number}`,
    discussions: `projects/${segment}/merge_requests/${number}/discussions?per_page=100`,
  };
}

/**
 * Writes a script named `name` into `dir` and returns its path. It appends the arguments of every call to
 * `<name>-calls.txt` and its working directory to `<name>-cwd.txt`, runs `before`, and answers by its last argument,
 * the path, from `answers`; a path it has no answer for ends with 97. It uses only what the shell has built in, so it
 * needs no PATH; an answer that hangs runs `/bin/sleep`.
 */
export function fakeCli(dir: string, name: CliName, answers: Readonly<Record<string, CliAnswer>>, before = ""): string {
  const cases = Object.entries(answers).map(([path, answer]) =>
    [
      `  ${quoted(path)})`,
      `    printf '%s' ${quoted(answer.stdout ?? "")}`,
      `    printf '%s' ${quoted(answer.stderr ?? "")} >&2`,
      ...(answer.hangs === true ? ["    exec /bin/sleep 30"] : []),
      `    exit ${answer.exitCode ?? 0} ;;`,
    ].join("\n"),
  );

  const script = [
    "#!/bin/sh",
    `(IFS='|'; printf '%s\\n' "$*") >> ${quoted(join(dir, `${name}-calls.txt`))}`,
    `printf '%s\\n' "$PWD" >> ${quoted(join(dir, `${name}-cwd.txt`))}`,
    before,
    'for last in "$@"; do :; done',
    'case "$last" in',
    ...cases,
    "  *)",
    `    printf 'the fake ${name} has no answer for: %s\\n' "$*" >&2`,
    "    exit 97 ;;",
    "esac",
    "",
  ].join("\n");

  const path = join(dir, name);

  writeFileSync(path, script);
  chmodSync(path, 0o755);

  return path;
}

/** A fake gh in `dir`, see `fakeCli`. */
export function fakeGh(dir: string, answers: Readonly<Record<string, CliAnswer>>, before = ""): string {
  return fakeCli(dir, "gh", answers, before);
}

/**
 * A fake gh in `dir` that is a GitHub of its own, see `FakeGitHub`: it keeps what is written to it in a file there, so
 * a later call reads it. Returns the path of the script. The script names the program that runs the tests by its
 * whole path, so it needs no PATH.
 */
export function fakeGitHub(dir: string, start: FakeGitHubStart = {}): string {
  const state: FakeGitHubState = {
    pull: start.pull ?? pullJson(),
    pullReads: 0,
    nextId: 9001,
    reviews: [],
    lineComments: [...(start.lineComments ?? [])],
    conversation: [...(start.conversation ?? [])],
    rules: start.rules ?? {},
    calls: [],
  };

  const source = join(import.meta.dir, "FakeGitHub.ts");

  const program = `import { FakeGitHub } from ${JSON.stringify(source)}; process.exit(await FakeGitHub.main(${JSON.stringify(dir)}, process.argv.slice(1)));`;

  const path = join(dir, "gh");

  writeFileSync(join(dir, FakeGitHub.STATE_FILE), JSON.stringify(state));
  writeFileSync(path, ["#!/bin/sh", `exec ${quoted(process.execPath)} -e ${quoted(program)} -- "$@"`, ""].join("\n"));
  chmodSync(path, 0o755);

  return path;
}

/** What the fake GitHub in `dir` holds now. */
export function gitHub(dir: string): FakeGitHubState {
  return FakeGitHub.read(dir);
}

/** The calls of the fake gh in `dir` that wrote, in order: those that were given a body on standard input. */
export function gitHubWrites(dir: string): FakeGitHubCall[] {
  return gitHub(dir).calls.filter((call) => call.input !== undefined);
}

/** A fake glab in `dir`, see `fakeCli`. */
export function fakeGlab(dir: string, answers: Readonly<Record<string, CliAnswer>>, before = ""): string {
  return fakeCli(dir, "glab", answers, before);
}

/** The arguments of every call the fake `name` in `dir` got, in order. */
export function cliCalls(dir: string, name: CliName): string[][] {
  const path = join(dir, `${name}-calls.txt`);

  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("|"));
}

/** The arguments of every call the fake gh in `dir` got, in order. */
export function ghCalls(dir: string): string[][] {
  return cliCalls(dir, "gh");
}

/** The arguments of every call the fake glab in `dir` got, in order. */
export function glabCalls(dir: string): string[][] {
  return cliCalls(dir, "glab");
}

/** The working directory of every call the fake `name` in `dir` got, in order. */
export function cliDirs(dir: string, name: CliName): string[] {
  return readFileSync(join(dir, `${name}-cwd.txt`), "utf8")
    .trim()
    .split("\n");
}

/** The JSON gh prints for a pull request. */
export function pullJson(fields: PullFields = {}): string {
  const number = fields.number ?? 12;

  return JSON.stringify({
    url: `https://api.github.com/repos/Acme/Shop/pulls/${number}`,
    html_url: fields.htmlUrl ?? `https://github.com/Acme/Shop/pull/${number}`,
    number,
    state: fields.state ?? "open",
    merged: fields.merged ?? false,
    title: fields.title ?? "Add div",
    body: fields.body === undefined ? "Adds a division helper." : fields.body,
    user: { login: "octocat" },
    head: { sha: fields.headSha ?? SHA_A, ref: "feature", repo: { id: 99 } },
    base: {
      sha: fields.baseSha ?? SHA_B,
      ref: "main",
      repo: { id: fields.repoId ?? 4242, full_name: fields.fullName ?? "Acme/Shop" },
    },
  });
}

/** What `gh api --paginate --slurp` prints: one array whose elements are the pages. */
export function slurped(...pages: readonly (readonly unknown[])[]): string {
  return JSON.stringify(pages);
}

/**
 * The answers of gh for a pull request that has no comment of any kind: three lists of one empty page. The pull
 * request is the one of `repository`, `Acme/Shop` when none is given.
 */
export function noComments(number: number, repository?: string): Record<string, CliAnswer> {
  const paths = ghPaths(number, repository);

  return {
    [paths.comments]: { stdout: slurped([]) },
    [paths.reviews]: { stdout: slurped([]) },
    [paths.conversation]: { stdout: slurped([]) },
  };
}

/** The JSON glab prints for a merge request, on one line as `--output ndjson` gives it. */
export function mergeRequestJson(fields: MergeRequestFields = {}): string {
  const iid = fields.iid ?? 12;
  const sha = fields.sha === undefined ? SHA_A : fields.sha;
  const baseSha = fields.baseSha === undefined ? SHA_B : fields.baseSha;

  const answer = {
    id: 576428090,
    iid,
    project_id: 4242,
    target_project_id: fields.projectId ?? 4242,
    source_project_id: 99,
    web_url: fields.webUrl ?? `https://gitlab.com/acme/shop/-/merge_requests/${iid}`,
    state: fields.state ?? "opened",
    title: fields.title ?? "Add div",
    description: fields.description === undefined ? "Adds a division helper." : fields.description,
    author: { username: "tanuki" },
    source_branch: "feature",
    target_branch: "main",
    sha,
    diff_refs: baseSha === null ? null : { base_sha: baseSha, head_sha: sha, start_sha: SHA_C },
  };

  return `${JSON.stringify(answer)}\n`;
}

/** What `glab api --paginate --output ndjson` prints: one entry per line, the pages one after another. */
export function jsonLines(...entries: readonly unknown[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

/**
 * The answer of glab for a merge request that has no discussion: a list that prints nothing. The merge request is the
 * one of `project`, `acme/shop` when none is given.
 */
export function noDiscussions(number: number, project?: string): Record<string, CliAnswer> {
  return { [glabPaths(number, project).discussions]: { stdout: jsonLines() } };
}

/** The position of a note in the diff as GitLab gives it: on line 7 of the new side of `src/a.ts` when nothing is set. */
export function position(fields: PositionFields = {}) {
  return {
    base_sha: SHA_B,
    start_sha: SHA_C,
    head_sha: SHA_A,
    old_path: "src/a.ts",
    new_path: "src/a.ts",
    position_type: "text",
    old_line: null,
    new_line: 7,
    line_range: null,
    ...fields,
  };
}

/** A note as GitLab gives it: a comment of ada without a position when nothing is set. */
export function note(id: number, fields: NoteFields = {}) {
  return {
    id,
    type: null,
    body: "y can be 0",
    author: { id: 1, username: "ada", name: "Ada" },
    created_at: "2026-11-20T10:00:00.000Z",
    updated_at: "2026-11-20T10:00:00.000Z",
    system: false,
    noteable_type: "MergeRequest",
    resolvable: false,
    ...fields,
  };
}

/** A discussion as GitLab gives it. */
export function discussion(id: string, ...notes: readonly unknown[]) {
  return { id, individual_note: notes.length === 1, notes };
}
