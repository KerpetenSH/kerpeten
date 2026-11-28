import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionGroupSet, Run } from "@kerpetensh/harness-kit";
import { KerpetenApp } from "../../../src/app/KerpetenApp.ts";
import { GitHubPlatform } from "../../../src/capability/platform/GitHubPlatform.ts";
import { LimitedOutput } from "../../../src/capability/platform/LimitedOutput.ts";
import { PlatformError } from "../../../src/capability/platform/PlatformError.ts";
import { PlatformLimits } from "../../../src/capability/platform/PlatformLimits.ts";
import { SlurpedPages } from "../../../src/capability/platform/SlurpedPages.ts";
import type { PlatformFailure, PlatformReadLimits } from "../../../src/capability/platform/types/platform.ts";
import { runComponent } from "../../app/app-utils.ts";
import { sh } from "../git/git-utils.ts";
import {
  cliDirs,
  fakeGh,
  GITHUB_ORIGIN,
  ghCalls,
  ghPaths,
  originRepo,
  pullJson,
  SHA_A,
  SHA_B,
  SHA_C,
  slurped,
} from "./platform-utils.ts";
import { TestGitHubPlatform } from "./TestGitHubPlatform.ts";
import type { GhAnswer } from "./types/platform.ts";

const COMPONENTS = [...KerpetenApp.COMPONENTS.filter((component) => component !== GitHubPlatform), TestGitHubPlatform];

const READ = ["api", "--method", "GET", "--hostname", "github.com"];

const LIMITS: PlatformReadLimits = { bytes: PlatformLimits.READ_BYTES, ms: PlatformLimits.READ_MS };

const paths = ghPaths(12);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new repository whose remote `origin` is at `origin`, the test repository on github.com when none is given. */
function tempDir(origin: string = GITHUB_ORIGIN): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kerpeten-platform-")));

  dirs.push(dir);

  return originRepo(dir, origin === "no origin" ? undefined : origin);
}

/** The platform of a new run in `dir`, with a fake gh there that gives `answers`, and with the read budget `limits`. */
function platform(
  dir: string,
  answers: Readonly<Record<string, GhAnswer>>,
  limits: PlatformReadLimits = LIMITS,
): Promise<TestGitHubPlatform> {
  return runComponent(
    TestGitHubPlatform,
    { repo: dir, ghCommand: fakeGh(dir, answers), ghLimits: limits },
    { components: COMPONENTS },
  );
}

async function failure(read: Promise<unknown>): Promise<PlatformError> {
  try {
    await read;
  } catch (error) {
    if (error instanceof PlatformError) return error;

    throw error;
  }

  throw new Error("the read did not fail");
}

const lineComment = {
  id: 101,
  user: { login: "ada" },
  body: "y can be 0",
  path: "src/a.ts",
  subject_type: "line",
  side: "RIGHT",
  start_side: null,
  line: 7,
  start_line: null,
  original_line: 7,
  original_start_line: null,
  commit_id: SHA_A,
  original_commit_id: SHA_B,
  created_at: "2026-11-20T10:00:00Z",
};

const emptyLists = {
  [paths.comments]: { stdout: slurped([]) },
  [paths.reviews]: { stdout: slurped([]) },
  [paths.conversation]: { stdout: slurped([]) },
};

describe("GitHub platform: the pull request", () => {
  test("asks gh for the pull request with one GET in the run's repository and gives it in the platform's words", async () => {
    const dir = tempDir();
    const github = await platform(dir, { [paths.pull]: { stdout: pullJson() } });

    expect(await github.mergeRequest(12)).toEqual({
      kind: "github",
      host: "github.com",
      projectId: "4242",
      number: 12,
      title: "Add div",
      description: "Adds a division helper.",
      state: "open",
      headSha: SHA_A,
      baseSha: SHA_B,
      baseRef: "main",
    });

    expect(ghCalls(dir)).toEqual([[...READ, "repos/Acme/Shop/pulls/12"]]);
    expect(cliDirs(dir, "gh")).toEqual([dir]);
  });

  test("the host is the one of html_url in lowercase without the scheme, and the project id is a string", async () => {
    const hosts: [string, string][] = [
      ["https://GitHub.Example.COM/Acme/Shop/pull/12", "github.example.com"],
      ["https://ghe.example.com:8443/Acme/Shop/pull/12", "ghe.example.com:8443"],
    ];

    for (const [htmlUrl, host] of hosts) {
      const github = await platform(tempDir(), { [paths.pull]: { stdout: pullJson({ htmlUrl, repoId: 987654321 }) } });
      const read = await github.mergeRequest(12);

      expect(read.host).toBe(host);
      expect(read.projectId).toBe("987654321");
    }
  });

  test("a merged pull request is merged, a closed one closed, and a missing description is empty", async () => {
    const merged = await platform(tempDir(), {
      [paths.pull]: { stdout: pullJson({ state: "closed", merged: true, body: null }) },
    });

    const closed = await platform(tempDir(), { [paths.pull]: { stdout: pullJson({ state: "closed" }) } });

    expect(await merged.mergeRequest(12)).toMatchObject({ state: "merged", description: "" });
    expect((await closed.mergeRequest(12)).state).toBe("closed");
  });

  test("each failure of gh is a platform error that says what to do", async () => {
    const cases: [GhAnswer, PlatformFailure, string][] = [
      [
        { exitCode: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login\n" },
        "signed_out",
        "gh is not signed in to github.com: run `gh auth login --hostname github.com` and run again",
      ],
      [
        { exitCode: 1, stderr: "gh: Bad credentials (HTTP 401)\n", stdout: '{"message":"Bad credentials"}' },
        "signed_out",
        "gh is not signed in to github.com: run `gh auth login --hostname github.com` and run again",
      ],
      [
        { exitCode: 1, stderr: "gh: Not Found (HTTP 404)\n", stdout: '{"message":"Not Found","status":"404"}' },
        "not_found",
        "pull request 12 was not found in github.com/Acme/Shop, the repository of the origin remote: check the number, and that gh is signed in to github.com with an account that can read the repository; a pull request of another repository, such as the one a fork was made from, is not read",
      ],
      [
        {
          exitCode: 1,
          stderr: "error connecting to github.com\ncheck your internet connection or https://githubstatus.com\n",
        },
        "failed",
        "gh api failed (exit 1): error connecting to github.com check your internet connection or https://githubstatus.com",
      ],
      [
        { exitCode: 1, stderr: "\n  gh: Server Error (HTTP 502)\n\n" },
        "failed",
        "gh api failed (exit 1): gh: Server Error (HTTP 502)",
      ],
      [{ exitCode: 3 }, "failed", "gh api failed (exit 3): it gave no error text"],
    ];

    for (const [answer, kind, message] of cases) {
      const error = await failure((await platform(tempDir(), { [paths.pull]: answer })).mergeRequest(12));

      expect({ kind: error.kind, message: error.message }).toEqual({ kind, message });
    }
  });

  test("a gh that is not installed is a platform error that says to install it", async () => {
    const dir = tempDir();

    const github = await runComponent(
      TestGitHubPlatform,
      { repo: dir, ghCommand: join(dir, "no-gh-here"), ghLimits: LIMITS },
      { components: COMPONENTS },
    );

    for (const read of [github.mergeRequest(12), github.comments(12)]) {
      const error = await failure(read);

      expect(error.kind).toBe("cli_missing");
      expect(error.message).toStartWith("gh, the GitHub CLI, is not found (");
      expect(error.message).toEndWith("): install it from https://cli.github.com and run again");
    }
  });

  test("an answer that is not the pull request asked for is a platform error, not a guess", async () => {
    const cases: [string, string][] = [
      ["<html>busy</html>", "the answer of gh for pull request 12 cannot be read: it is no JSON"],
      [pullJson({ number: 13 }), "the answer of gh for pull request 12 cannot be read: it is pull request 13"],
      [pullJson({ headSha: "HEAD" }), "the answer of gh for pull request 12 cannot be read: head.sha: "],
      [pullJson({ baseSha: "--upload-pack=x" }), "the answer of gh for pull request 12 cannot be read: base.sha: "],
      [pullJson({ state: "draft" }), "the answer of gh for pull request 12 cannot be read: state: "],
      [
        pullJson({ htmlUrl: "github.com/a/b" }),
        "the answer of gh for pull request 12 cannot be read: html_url is no URL",
      ],
    ];

    for (const [stdout, message] of cases) {
      const error = await failure((await platform(tempDir(), { [paths.pull]: { stdout } })).mergeRequest(12));

      expect(error.kind).toBe("failed");
      expect(error.message).toStartWith(message);
    }
  });

  test("a number that is no whole number of 1 or more is refused before gh is called", async () => {
    const dir = tempDir();
    const github = await platform(dir, {});

    for (const number of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(github.mergeRequest(number)).rejects.toThrow("not a pull request number");
      await expect(github.comments(number)).rejects.toThrow("not a pull request number");
    }

    expect(ghCalls(dir)).toEqual([]);
  });
});

describe("GitHub platform: the comments", () => {
  test("reads the three lists to their last page, each with one GET, 100 entries a page", async () => {
    const dir = tempDir();
    const github = await platform(dir, emptyLists);

    expect(await github.comments(12)).toEqual({ comments: [], complete: true, problems: [] });

    expect(ghCalls(dir)).toEqual([
      [...READ, "--paginate", "--slurp", "repos/Acme/Shop/pulls/12/comments?per_page=100"],
      [...READ, "--paginate", "--slurp", "repos/Acme/Shop/pulls/12/reviews?per_page=100"],
      [...READ, "--paginate", "--slurp", "repos/Acme/Shop/issues/12/comments?per_page=100"],
    ]);
  });

  test("gives the comments on lines of every page, with replies, ranges, outdated places and missing authors", async () => {
    const reply = { ...lineComment, id: 102, user: { login: "bob" }, body: "it cannot", in_reply_to_id: 101 };
    const range = { ...lineComment, id: 103, line: 9, start_line: 4, start_side: "RIGHT" };

    const outdated = {
      ...lineComment,
      id: 104,
      user: null,
      start_side: "RIGHT",
      line: null,
      original_line: 30,
      original_start_line: 28,
    };

    const wholeFile = { ...lineComment, id: 105, line: null, original_line: null };
    const fileSubject = { ...lineComment, id: 106, subject_type: "file", line: 1, original_line: 1 };

    const github = await platform(tempDir(), {
      ...emptyLists,
      [paths.comments]: { stdout: slurped([lineComment, reply], [range, outdated, wholeFile, fileSubject]) },
    });

    const onLine = { kind: "line", file: "src/a.ts", side: "new", createdAt: "2026-11-20T10:00:00Z" } as const;
    const onFile = { ...onLine, author: "ada", body: "y can be 0", lines: null, side: null, replyTo: null };

    expect(await github.comments(12)).toEqual({
      comments: [
        {
          ...onLine,
          id: "101",
          ref: "github:review_comment/101",
          author: "ada",
          body: "y can be 0",
          lines: { start: 7, end: 7 },
          commit: SHA_A,
          replyTo: null,
        },
        {
          ...onLine,
          id: "102",
          ref: "github:review_comment/102",
          author: "bob",
          body: "it cannot",
          lines: { start: 7, end: 7 },
          commit: SHA_A,
          replyTo: "101",
        },
        {
          ...onLine,
          id: "103",
          ref: "github:review_comment/103",
          author: "ada",
          body: "y can be 0",
          lines: { start: 4, end: 9 },
          commit: SHA_A,
          replyTo: null,
        },
        {
          ...onLine,
          id: "104",
          ref: "github:review_comment/104",
          author: null,
          body: "y can be 0",
          lines: { start: 28, end: 30 },
          commit: SHA_B,
          replyTo: null,
        },
        { ...onFile, id: "105", ref: "github:review_comment/105", commit: SHA_B },
        { ...onFile, id: "106", ref: "github:review_comment/106", commit: SHA_A },
      ],
      complete: true,
      problems: [],
    });
  });

  test("a comment says which side its lines are on: the old side for a line the change removed", async () => {
    const removed = { ...lineComment, id: 111, side: "LEFT", line: 320, original_line: 320 };
    const removedRange = { ...removed, id: 112, start_side: "LEFT", start_line: 318, original_start_line: 318 };

    const outdatedRemoved = {
      ...removedRange,
      id: 113,
      line: null,
      start_line: null,
      original_line: 30,
      original_start_line: 28,
    };

    const crossing = {
      ...lineComment,
      id: 114,
      side: "RIGHT",
      start_side: "LEFT",
      line: 598,
      start_line: 581,
      original_line: 592,
      original_start_line: 581,
    };

    const crossingBack = { ...crossing, id: 115, side: "LEFT", start_side: "RIGHT", line: 40, start_line: 44 };
    const outdatedCrossing = { ...crossing, id: 116, line: null, start_line: null };

    const github = await platform(tempDir(), {
      ...emptyLists,
      [paths.comments]: {
        stdout: slurped([removed, removedRange, outdatedRemoved, crossing, crossingBack, outdatedCrossing]),
      },
    });

    const read = await github.comments(12);

    expect(read.complete).toBe(true);

    expect(read.comments.map(({ id, file, lines, side, commit }) => ({ id, file, lines, side, commit }))).toEqual([
      { id: "111", file: "src/a.ts", lines: { start: 320, end: 320 }, side: "old", commit: SHA_A },
      { id: "112", file: "src/a.ts", lines: { start: 318, end: 320 }, side: "old", commit: SHA_A },
      { id: "113", file: "src/a.ts", lines: { start: 28, end: 30 }, side: "old", commit: SHA_B },
      { id: "114", file: "src/a.ts", lines: { start: 598, end: 598 }, side: "new", commit: SHA_A },
      { id: "115", file: "src/a.ts", lines: { start: 40, end: 40 }, side: "old", commit: SHA_A },
      { id: "116", file: "src/a.ts", lines: { start: 592, end: 592 }, side: "new", commit: SHA_B },
    ]);
  });

  test("a comment on lines whose side gh does not name cannot be read: its side is not guessed", async () => {
    const { side: _side, ...sideless } = lineComment;

    const github = await platform(tempDir(), {
      ...emptyLists,
      [paths.comments]: { stdout: slurped([lineComment, sideless, { ...lineComment, id: 103, side: "CENTER" }]) },
    });

    const read = await github.comments(12);

    expect(read.comments.map((comment) => comment.id)).toEqual(["101"]);
    expect(read.complete).toBe(false);
    expect(read.problems).toEqual(["repos/Acme/Shop/pulls/12/comments: 2 of 3 entries cannot be read"]);
  });

  test("a review with a body and a comment of the conversation are general comments; a review without a body is none", async () => {
    const reviews = [
      {
        id: 201,
        user: { login: "ada" },
        body: "Looks risky.",
        state: "CHANGES_REQUESTED",
        commit_id: SHA_C,
        submitted_at: "2026-11-21T08:00:00Z",
      },
      { id: 202, user: { login: "bob" }, body: "", state: "APPROVED", commit_id: SHA_C, submitted_at: "x" },
      { id: 203, user: null, body: null, state: "COMMENTED", commit_id: null },
      { id: 204, user: null, body: "Draft thoughts.", state: "PENDING", commit_id: null },
    ];

    const conversation = [{ id: 301, user: { login: "cy" }, body: "Why now?", created_at: "2026-11-22T09:00:00Z" }];

    const github = await platform(tempDir(), {
      ...emptyLists,
      [paths.reviews]: { stdout: slurped(reviews) },
      [paths.conversation]: { stdout: slurped(conversation) },
    });

    const general = { kind: "general", file: null, lines: null, side: null, replyTo: null } as const;

    expect(await github.comments(12)).toEqual({
      comments: [
        {
          ...general,
          id: "201",
          ref: "github:review/201",
          author: "ada",
          body: "Looks risky.",
          commit: SHA_C,
          createdAt: "2026-11-21T08:00:00Z",
        },
        {
          ...general,
          id: "204",
          ref: "github:review/204",
          author: null,
          body: "Draft thoughts.",
          commit: null,
          createdAt: null,
        },
        {
          ...general,
          id: "301",
          ref: "github:issue_comment/301",
          author: "cy",
          body: "Why now?",
          commit: null,
          createdAt: "2026-11-22T09:00:00Z",
        },
      ],
      complete: true,
      problems: [],
    });
  });

  test("a list gh did not read to its end makes the result incomplete, with the pages that were read", async () => {
    const second = { ...lineComment, id: 102 };
    const cut = `[${JSON.stringify([lineComment])},${JSON.stringify([second])},[{"id":103,"body":"cut he`;

    const github = await platform(tempDir(), {
      ...emptyLists,
      [paths.comments]: { stdout: cut, stderr: "gh: Server Error (HTTP 502)\n", exitCode: 1 },
      [paths.conversation]: {
        stdout: slurped([{ id: 301, user: { login: "cy" }, body: "Why now?", created_at: "2026-11-22T09:00:00Z" }]),
      },
    });

    const read = await github.comments(12);

    expect(read.complete).toBe(false);
    expect(read.comments.map((comment) => comment.id)).toEqual(["101", "102", "301"]);

    expect(read.problems).toEqual([
      "repos/Acme/Shop/pulls/12/comments: gh api failed (exit 1): gh: Server Error (HTTP 502)",
    ]);
  });

  test("a failed read is incomplete also when what gh printed is whole", async () => {
    const github = await platform(tempDir(), {
      ...emptyLists,
      [paths.reviews]: { stdout: slurped([]), stderr: "gh: rate limit\n", exitCode: 1 },
    });

    expect(await github.comments(12)).toEqual({
      comments: [],
      complete: false,
      problems: ["repos/Acme/Shop/pulls/12/reviews: gh api failed (exit 1): gh: rate limit"],
    });
  });

  test("an answer that is no list of pages, and an entry that cannot be read, make the result incomplete", async () => {
    const github = await platform(tempDir(), {
      [paths.comments]: { stdout: slurped([lineComment, { id: "x" }, { ...lineComment, id: 103, commit_id: "HEAD" }]) },
      [paths.reviews]: { stdout: "<html>busy</html>" },
      [paths.conversation]: { stdout: '{"message":"Server Error"}' },
    });

    const read = await github.comments(12);

    expect(read.complete).toBe(false);
    expect(read.comments.map((comment) => comment.id)).toEqual(["101"]);

    expect(read.problems).toEqual([
      "repos/Acme/Shop/pulls/12/comments: 2 of 3 entries cannot be read",
      "repos/Acme/Shop/pulls/12/reviews: the answer of gh is not the list of pages it should be",
      "repos/Acme/Shop/issues/12/comments: the answer of gh is not the list of pages it should be",
    ]);
  });

  test("a missing sign-in and an unknown pull request are errors, not an incomplete result", async () => {
    const cases: [GhAnswer, PlatformFailure][] = [
      [{ exitCode: 4, stderr: "gh auth login\n" }, "signed_out"],
      [{ exitCode: 1, stderr: "gh: Requires authentication (HTTP 401)\n" }, "signed_out"],
      [{ exitCode: 1, stderr: "gh: Not Found (HTTP 404)\n", stdout: '{"message":"Not Found"}' }, "not_found"],
    ];

    for (const [answer, kind] of cases) {
      const github = await platform(tempDir(), { ...emptyLists, [paths.reviews]: answer });

      expect((await failure(github.comments(12))).kind).toBe(kind);
    }
  });
});

describe("GitHub platform: the repository of the origin remote", () => {
  const NEEDS =
    "a review of a pull request or merge request reads it from the project of the origin remote, so the remote must be the address of a project on GitHub or GitLab";

  test("every call names the host and the repository of the origin remote, whatever form its URL has", async () => {
    const origins: [string, string, string][] = [
      ["git@github.com:Acme/Shop.git", "github.com", "Acme/Shop"],
      ["ssh://git@github.com:2222/Acme/Shop.git", "github.com", "Acme/Shop"],
      ["https::https://github.com/Acme/Shop.git", "github.com", "Acme/Shop"],
      ["https://reader:not-a-token@GHE.Example.com/Team/App", "ghe.example.com", "Team/App"],
    ];

    for (const [origin, host, repository] of origins) {
      const dir = tempDir(origin);
      const asked = ghPaths(12, repository);

      const github = await platform(dir, {
        [asked.pull]: { stdout: pullJson({ fullName: repository }) },
        [asked.comments]: { stdout: slurped([]) },
        [asked.reviews]: { stdout: slurped([]) },
        [asked.conversation]: { stdout: slurped([]) },
      });

      expect((await github.mergeRequest(12)).number).toBe(12);
      expect((await github.comments(12)).complete).toBe(true);

      const read = ["api", "--method", "GET", "--hostname", host];

      expect(ghCalls(dir)).toEqual([
        [...read, `repos/${repository}/pulls/12`],
        [...read, "--paginate", "--slurp", `repos/${repository}/pulls/12/comments?per_page=100`],
        [...read, "--paginate", "--slurp", `repos/${repository}/pulls/12/reviews?per_page=100`],
        [...read, "--paginate", "--slurp", `repos/${repository}/issues/12/comments?per_page=100`],
      ]);
    }
  });

  test("another remote plays no part: gh is left nothing to choose", async () => {
    const dir = tempDir();

    sh(dir, ["remote", "add", "upstream", "https://github.com/Other/Shop.git"]);

    const github = await platform(dir, { [paths.pull]: { stdout: pullJson() } });

    await github.mergeRequest(12);

    expect(ghCalls(dir)).toEqual([[...READ, "repos/Acme/Shop/pulls/12"]]);
    expect(ghCalls(dir).flat().join(" ")).not.toMatch(/[{}]|Other/);
  });

  test("an answer of another repository is a platform error, and upper or lower case makes no other repository", async () => {
    const other = await platform(tempDir(), { [paths.pull]: { stdout: pullJson({ fullName: "Other/Shop" }) } });
    const error = await failure(other.mergeRequest(12));

    expect({ kind: error.kind, message: error.message }).toEqual({
      kind: "failed",
      message:
        'gh answered with a pull request of "Other/Shop", not of Acme/Shop, the repository of the origin remote; when the repository was renamed or moved, point the origin remote at its new address and run again',
    });

    const sameInLowerCase = await platform(tempDir(), {
      [paths.pull]: { stdout: pullJson({ fullName: "acme/shop" }) },
    });

    expect((await sameInLowerCase.mergeRequest(12)).number).toBe(12);
  });

  test("a repository without an origin remote, and an origin that names no repository on GitHub, stop before gh is called", async () => {
    const cases: [string, string][] = [
      [
        "no origin",
        "this repository has no origin remote: a review of a pull request or merge request reads it from the project of the origin remote, so add one with `git remote add origin <address of the project>`",
      ],
      ["/srv/git/shop.git", `the origin remote is a path on this machine: ${NEEDS}`],
      [
        "git@github.com:Acme/Group/Shop.git",
        "the origin remote names github.com/Acme/Group/Shop, which is no GitHub repository: a repository is an owner and a name, <owner>/<name>",
      ],
      [
        "https://github.com/Shop",
        "the origin remote names github.com/Shop, which is no GitHub repository: a repository is an owner and a name, <owner>/<name>",
      ],
    ];

    for (const [origin, message] of cases) {
      const dir = tempDir(origin);
      const github = await platform(dir, {});

      for (const read of [github.mergeRequest(12), github.comments(12)]) {
        const error = await failure(read);

        expect({ kind: error.kind, message: error.message }).toEqual({ kind: "no_repository", message });
      }

      expect(ghCalls(dir)).toEqual([]);
    }
  });

  test("nothing of a remote adds an argument, a second endpoint or a query to a call of gh", async () => {
    const refused = [
      "git@github.com:Acme/Shop --method DELETE",
      "https://github.com/Acme/Shop?per_page=1&page=2",
      "https://github.com/Acme/Shop#x",
      "git@github.com:Acme/Shop/../../user/repos",
      "https://github.com/Acme/Shop/../../orgs",
      "https://github.com/Acme/Shop%2Fpulls%2F1",
      "git@github.com:{owner}/{repo}",
      "git@github.com:Acme/Shop/pulls/1/comments",
      "git@--method=DELETE:Acme/Shop",
      "ext::sh -c 'gh api --method DELETE repos/Acme/Shop'",
    ];

    for (const origin of refused) {
      const dir = tempDir(origin);
      const github = await platform(dir, {});

      expect((await failure(github.mergeRequest(12))).kind).toBe("no_repository");
      expect((await failure(github.comments(12))).kind).toBe("no_repository");
      expect(ghCalls(dir)).toEqual([]);
    }

    const dir = tempDir("git@github.com:--method/-XDELETE.git");
    const github = await platform(dir, {});

    expect((await failure(github.mergeRequest(12))).kind).toBe("failed");
    expect(ghCalls(dir)).toEqual([[...READ, "repos/--method/-XDELETE/pulls/12"]]);
  });

  test("a missing sign-in names the host of the origin remote", async () => {
    const dir = tempDir("https://ghe.example.com/Team/App.git");
    const asked = ghPaths(12, "Team/App");
    const github = await platform(dir, { [asked.pull]: { exitCode: 1, stderr: "gh: Bad credentials (HTTP 401)\n" } });

    expect((await failure(github.mergeRequest(12))).message).toBe(
      "gh is not signed in to ghe.example.com: run `gh auth login --hostname ghe.example.com` and run again",
    );
  });
});

describe("GitHub platform: the budget of a read", () => {
  const second = { ...lineComment, id: 102 };
  const third = { ...lineComment, id: 103 };
  const twoPages = `[${JSON.stringify([lineComment])},${JSON.stringify([second])}`;
  const threePages = `${twoPages},${JSON.stringify([third])}]`;
  const list = "repos/Acme/Shop/pulls/12/comments";

  test("the budget is 20,000,000 bytes and two minutes for every read", () => {
    expect(LIMITS).toEqual({ bytes: 20_000_000, ms: 120_000 });
  });

  test("a list larger than the byte limit stops there: the pages that stand whole are kept and the result is incomplete", async () => {
    const bytes = twoPages.length + 5;
    const dir = tempDir();

    const github = await platform(
      dir,
      { ...emptyLists, [paths.comments]: { stdout: threePages } },
      { bytes, ms: LIMITS.ms },
    );

    const read = await github.comments(12);

    expect(read.comments.map((comment) => comment.id)).toEqual(["101", "102"]);
    expect(read.complete).toBe(false);
    expect(read.problems).toEqual([`${list}: gh printed more than ${bytes} bytes, and the read stopped there`]);
    expect(ghCalls(dir).length).toBe(3);
  });

  test("a list of exactly the byte limit is whole", async () => {
    const github = await platform(
      tempDir(),
      { ...emptyLists, [paths.comments]: { stdout: threePages } },
      { bytes: threePages.length, ms: LIMITS.ms },
    );

    const read = await github.comments(12);

    expect(read.comments.map((comment) => comment.id)).toEqual(["101", "102", "103"]);
    expect(read).toMatchObject({ complete: true, problems: [] });
  });

  test("a list gh does not finish within the time limit stops there, with the pages it printed, and says so", async () => {
    const github = await platform(
      tempDir(),
      { ...emptyLists, [paths.comments]: { stdout: `${twoPages},`, hangs: true } },
      { bytes: LIMITS.bytes, ms: 300 },
    );

    const started = Date.now();
    const read = await github.comments(12);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(read.comments.map((comment) => comment.id)).toEqual(["101", "102"]);
    expect(read.complete).toBe(false);
    expect(read.problems).toEqual([`${list}: gh did not finish within 0.3 seconds, and the read stopped there`]);
  });

  test("a pull request read that reaches a limit is a platform error that names the limit", async () => {
    const cases: [GhAnswer, PlatformReadLimits, string][] = [
      [
        { stdout: pullJson(), hangs: true },
        { bytes: LIMITS.bytes, ms: 300 },
        "pull request 12 was not read: gh did not finish within 0.3 seconds, and the read stopped there",
      ],
      [
        { stdout: pullJson() },
        { bytes: 100, ms: LIMITS.ms },
        "pull request 12 was not read: gh printed more than 100 bytes, and the read stopped there",
      ],
    ];

    for (const [answer, limits, message] of cases) {
      const error = await failure((await platform(tempDir(), { [paths.pull]: answer }, limits)).mergeRequest(12));

      expect({ kind: error.kind, message: error.message }).toEqual({ kind: "failed", message });
    }
  });

  test("an output keeps the bytes up to its limit and says when the program printed more", () => {
    const output = new LimitedOutput(5);

    expect(output.take(Buffer.from("abc"))).toBe(true);
    expect(output.take(Buffer.from("de"))).toBe(true);
    expect(output.over).toBe(false);
    expect(output.take(Buffer.from("fgh"))).toBe(false);
    expect(output.over).toBe(true);
    expect(output.bytes.toString()).toBe("abcde");

    const cut = new LimitedOutput(4);

    expect(cut.take(Buffer.from("abcdefgh"))).toBe(false);
    expect(cut.bytes.toString()).toBe("abcd");
    expect(new LimitedOutput(0).bytes.length).toBe(0);
  });
});

describe("GitHub platform: the environment of gh", () => {
  test("gh gets the program's environment without the variables that force colors", async () => {
    const dir = tempDir();

    const env = {
      PATH: process.env.PATH ?? "",
      GH_TOKEN: "ghp_PLATFORM_TEST_TOKEN",
      GH_HOST: "ghe.example.com",
      CLICOLOR_FORCE: "1",
      GH_FORCE_TTY: "100%",
      UNSET: undefined,
    };

    const { app } = await KerpetenApp.start({ io: { out: () => {}, err: () => {} }, env }, COMPONENTS);

    try {
      const ghCommand = fakeGh(dir, { [paths.pull]: { stdout: pullJson() } }, `env > '${join(dir, "env.txt")}'`);

      const run = new Run(
        { group: PermissionGroupSet.ALL, every: true },
        { values: { repo: dir, ghCommand, ghLimits: LIMITS }, container: app.container, test: true },
      );

      await (await run.ready(TestGitHubPlatform)).mergeRequest(12);
    } finally {
      await app.stop();
    }

    const names = readFileSync(join(dir, "env.txt"), "utf8")
      .split("\n")
      .map((line) => line.split("=")[0]);

    expect(names).toContain("GH_TOKEN");
    expect(names).toContain("GH_HOST");
    expect(names).toContain("PATH");
    expect(names).not.toContain("CLICOLOR_FORCE");
    expect(names).not.toContain("GH_FORCE_TTY");
    expect(names).not.toContain("UNSET");
  });
});

describe("slurped pages", () => {
  test("pages that are whole give their entries in order", () => {
    expect(SlurpedPages.read("[[1,2],[3]]")).toMatchObject({ items: [1, 2, 3], whole: true });
    expect(SlurpedPages.read("[[]]")).toMatchObject({ items: [], whole: true });
    expect(SlurpedPages.read("[]")).toMatchObject({ items: [], whole: true });
  });

  test("a cut text keeps the pages before the cut, whatever brackets and quotes their strings hold", () => {
    const tricky = [{ body: 'a "quoted" ]] [[ }{ \\ text' }, { body: "]," }];
    const cut = `[${JSON.stringify(tricky)},[{"body":"cut in a string ]`;

    expect(SlurpedPages.read(cut)).toMatchObject({ items: tricky, whole: false });
    expect(SlurpedPages.read(`  [${JSON.stringify(tricky)},`)).toMatchObject({ items: tricky, whole: false });
  });

  test("what is no page is left out and the text is not whole", () => {
    expect(SlurpedPages.read('[[1],{"message":"Server Error"}]')).toMatchObject({ items: [1], whole: false });
    expect(SlurpedPages.read('[[1],{"message":"Server Error"}')).toMatchObject({ items: [1], whole: false });
    expect(SlurpedPages.read('{"errors":[[1,2]]}')).toMatchObject({ items: [], whole: false });
    expect(SlurpedPages.read("")).toMatchObject({ items: [], whole: false });
    expect(SlurpedPages.read("null")).toMatchObject({ items: [], whole: false });
    expect(SlurpedPages.read("\u001b[1;37m[\u001b[m[1]]")).toMatchObject({ items: [], whole: false });
  });
});
