import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionGroupSet, Run } from "@kerpetensh/harness-kit";
import { KerpetenApp } from "../../../src/app/KerpetenApp.ts";
import { GitLabPlatform } from "../../../src/capability/platform/GitLabPlatform.ts";
import { JsonLines } from "../../../src/capability/platform/JsonLines.ts";
import { PlatformError } from "../../../src/capability/platform/PlatformError.ts";
import { PlatformLimits } from "../../../src/capability/platform/PlatformLimits.ts";
import type { PlatformFailure, PlatformReadLimits } from "../../../src/capability/platform/types/platform.ts";
import { runComponent } from "../../app/app-utils.ts";
import { sh } from "../git/git-utils.ts";
import {
  cliDirs,
  discussion,
  fakeGlab,
  GITLAB_ORIGIN,
  glabCalls,
  glabPaths,
  jsonLines,
  mergeRequestJson,
  note,
  originRepo,
  position,
  SHA_A,
  SHA_B,
  SHA_C,
} from "./platform-utils.ts";
import { TestGitLabPlatform } from "./TestGitLabPlatform.ts";
import type { CliAnswer } from "./types/platform.ts";

const COMPONENTS = [...KerpetenApp.COMPONENTS.filter((component) => component !== GitLabPlatform), TestGitLabPlatform];

const READ = ["api", "--method", "GET", "--output", "ndjson", "--hostname", "gitlab.com"];

const LIMITS: PlatformReadLimits = { bytes: PlatformLimits.READ_BYTES, ms: PlatformLimits.READ_MS };

const DISCUSSIONS = "projects/acme%2Fshop/merge_requests/12/discussions";

const paths = glabPaths(12);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new repository whose remote `origin` is at `origin`, the test project on gitlab.com when none is given. */
function tempDir(origin: string = GITLAB_ORIGIN): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kerpeten-platform-")));

  dirs.push(dir);

  return originRepo(dir, origin === "no origin" ? undefined : origin);
}

/** The platform of a new run in `dir`, with a fake glab there that gives `answers`, and with the read budget `limits`. */
function platform(
  dir: string,
  answers: Readonly<Record<string, CliAnswer>>,
  limits: PlatformReadLimits = LIMITS,
): Promise<TestGitLabPlatform> {
  return runComponent(
    TestGitLabPlatform,
    { repo: dir, glabCommand: fakeGlab(dir, answers), glabLimits: limits },
    { components: COMPONENTS },
  );
}

/** The comments the platform reads when glab prints `stdout` for the discussions. */
async function commentsOf(stdout: string) {
  return (await platform(tempDir(), { [paths.discussions]: { stdout } })).comments(12);
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

const NOT_FOUND: CliAnswer = {
  exitCode: 1,
  stderr: "glab: 404 Not found (HTTP 404)\n",
  stdout: '{"message":"404 Not found"}',
};

const NO_SUCH_HOST: CliAnswer = {
  exitCode: 1,
  stderr: [
    "          ",
    "   ERROR  ",
    "          ",
    '  Get "https://gitlab.com/api/v4/projects/acme%2Fshop/merge_requests/12": dial tcp: lookup                       ',
    "  gitlab.com: no such host.                                                                               ",
    "",
  ].join("\n"),
};

const NOT_FOUND_MESSAGE =
  "merge request 12 was not found in gitlab.com/acme/shop, the project of the origin remote: check the number; GitLab gives the same answer for a private project that glab cannot read, so check too that glab is signed in to gitlab.com (`glab auth login --hostname gitlab.com`) with an account that can read the project; a merge request of another project, such as the one a fork was made from, is not read";

const SIGNED_OUT_MESSAGE =
  "GitLab at gitlab.com did not accept the sign-in of glab (HTTP 401): run `glab auth login --hostname gitlab.com`, or correct the token in GITLAB_TOKEN when that variable is set, and run again";

const general = { kind: "general", file: null, lines: null, side: null, commit: null } as const;

const onLine = {
  kind: "line",
  file: "src/a.ts",
  side: "new",
  commit: SHA_A,
  createdAt: "2026-11-20T10:00:00.000Z",
} as const;

describe("GitLab platform: the merge request", () => {
  test("asks glab for the merge request with one GET in the run's repository and gives it in the platform's words", async () => {
    const dir = tempDir();
    const gitlab = await platform(dir, { [paths.mergeRequest]: { stdout: mergeRequestJson() } });

    expect(await gitlab.mergeRequest(12)).toEqual({
      kind: "gitlab",
      host: "gitlab.com",
      projectId: "4242",
      number: 12,
      title: "Add div",
      description: "Adds a division helper.",
      state: "open",
      headSha: SHA_A,
      baseSha: SHA_B,
      baseRef: "main",
    });

    expect(glabCalls(dir)).toEqual([[...READ, "projects/acme%2Fshop/merge_requests/12"]]);
    expect(cliDirs(dir, "glab")).toEqual([dir]);
  });

  test("the host is the one of web_url in lowercase without the scheme, and the project id is a string", async () => {
    const hosts: [string, string][] = [
      ["https://GitLab.Example.COM/acme/shop/-/merge_requests/12", "gitlab.example.com"],
      ["https://git.example.com:8443/acme/shop/-/merge_requests/12", "git.example.com:8443"],
    ];

    for (const [webUrl, host] of hosts) {
      const gitlab = await platform(tempDir(), {
        [paths.mergeRequest]: { stdout: mergeRequestJson({ webUrl, projectId: 987654321 }) },
      });

      const read = await gitlab.mergeRequest(12);

      expect(read.host).toBe(host);
      expect(read.projectId).toBe("987654321");
    }
  });

  test("an opened merge request is open, a closed one closed, a merged one merged, and a missing description is empty", async () => {
    const states: [string, string][] = [
      ["opened", "open"],
      ["closed", "closed"],
      ["merged", "merged"],
    ];

    for (const [state, expected] of states) {
      const gitlab = await platform(tempDir(), {
        [paths.mergeRequest]: { stdout: mergeRequestJson({ state, description: null }) },
      });

      expect(await gitlab.mergeRequest(12)).toMatchObject({ state: expected, description: "" });
    }
  });

  test("a locked merge request, an unknown state and a merge request without a diff are errors that say why", async () => {
    const cases: [string, string][] = [
      [
        mergeRequestJson({ state: "locked" }),
        "merge request 12 is locked: GitLab is merging it right now, so run again when the merge is done",
      ],
      [mergeRequestJson({ state: "draft" }), "the answer of glab for merge request 12 cannot be read: state: "],
      [
        mergeRequestJson({ baseSha: null }),
        "merge request 12 has no diff yet, GitLab names no commits for it: push a commit to its branch, or wait until GitLab has made the diff, and run again",
      ],
      [mergeRequestJson({ sha: null }), "merge request 12 has no diff yet, GitLab names no commits for it: "],
    ];

    for (const [stdout, message] of cases) {
      const error = await failure((await platform(tempDir(), { [paths.mergeRequest]: { stdout } })).mergeRequest(12));

      expect(error.kind).toBe("failed");
      expect(error.message).toStartWith(message);
    }
  });

  test("each failure of glab is a platform error that says what to do", async () => {
    const cases: [CliAnswer, PlatformFailure, string][] = [
      [
        { exitCode: 1, stderr: "glab: 401 Unauthorized (HTTP 401)\n", stdout: '{"message":"401 Unauthorized"}' },
        "signed_out",
        SIGNED_OUT_MESSAGE,
      ],
      [
        { exitCode: 1, stderr: "glab: HTTP 401\n", stdout: '{"error":"invalid_token"}' },
        "signed_out",
        SIGNED_OUT_MESSAGE,
      ],
      [NOT_FOUND, "not_found", NOT_FOUND_MESSAGE],
      [
        {
          exitCode: 1,
          stderr:
            '! GITLAB_TOKEN is set, but "gitlab.com" is neither the default host nor a configured host, so glab did not send the credential to it. To authenticate to this host, run glab auth login --hostname gitlab.com.\nglab: 404 Project Not Found (HTTP 404)\n',
          stdout: '{"message":"404 Project Not Found"}',
        },
        "not_found",
        NOT_FOUND_MESSAGE,
      ],
      [
        NO_SUCH_HOST,
        "failed",
        'glab api failed (exit 1): Get "https://gitlab.com/api/v4/projects/acme%2Fshop/merge_requests/12": dial tcp: lookup gitlab.com: no such host.',
      ],
      [
        { exitCode: 1, stderr: "glab: 502 Bad Gateway (HTTP 502)\n" },
        "failed",
        "glab api failed (exit 1): glab: 502 Bad Gateway (HTTP 502)",
      ],
      [
        { exitCode: 1, stderr: "          \n   ERROR  \n          \n  the keyring is\n  locked.  \n" },
        "failed",
        "glab api failed (exit 1): the keyring is locked.",
      ],
      [{ exitCode: 3 }, "failed", "glab api failed (exit 3): it gave no error text"],
    ];

    for (const [answer, kind, message] of cases) {
      const error = await failure((await platform(tempDir(), { [paths.mergeRequest]: answer })).mergeRequest(12));

      expect({ kind: error.kind, message: error.message }).toEqual({ kind, message });
    }
  });

  test("a glab that is not installed is a platform error that says to install it", async () => {
    const dir = tempDir();

    const gitlab = await runComponent(
      TestGitLabPlatform,
      { repo: dir, glabCommand: join(dir, "no-glab-here"), glabLimits: LIMITS },
      { components: COMPONENTS },
    );

    for (const read of [gitlab.mergeRequest(12), gitlab.comments(12)]) {
      const error = await failure(read);

      expect(error.kind).toBe("cli_missing");
      expect(error.message).toStartWith("glab, the GitLab CLI, is not found (");
      expect(error.message).toEndWith("): install it from https://gitlab.com/gitlab-org/cli and run again");
    }
  });

  test("an answer that is not the merge request asked for is a platform error, not a guess", async () => {
    const cases: [string, string][] = [
      ["<html>busy</html>", "the answer of glab for merge request 12 cannot be read: it is no JSON"],
      [mergeRequestJson().slice(0, 40), "the answer of glab for merge request 12 cannot be read: it is no JSON"],
      [mergeRequestJson({ iid: 13 }), "the answer of glab for merge request 12 cannot be read: it is merge request 13"],
      [mergeRequestJson({ sha: "HEAD" }), "the answer of glab for merge request 12 cannot be read: sha: "],
      [
        mergeRequestJson({ baseSha: "--upload-pack=x" }),
        "the answer of glab for merge request 12 cannot be read: diff_refs.base_sha: ",
      ],
      [mergeRequestJson({ sha: "a".repeat(64) }), "the answer of glab for merge request 12 cannot be read: sha: "],
      [
        mergeRequestJson({ webUrl: "gitlab.com/a/b" }),
        "the answer of glab for merge request 12 cannot be read: web_url is no URL",
      ],
    ];

    for (const [stdout, message] of cases) {
      const error = await failure((await platform(tempDir(), { [paths.mergeRequest]: { stdout } })).mergeRequest(12));

      expect(error.kind).toBe("failed");
      expect(error.message).toStartWith(message);
    }
  });

  test("the number is the one inside the project, not GitLab's id of the merge request", async () => {
    const answer = JSON.parse(mergeRequestJson({ iid: 12 }));

    expect(answer.id).not.toBe(12);

    const gitlab = await platform(tempDir(), { [paths.mergeRequest]: { stdout: JSON.stringify(answer) } });

    expect((await gitlab.mergeRequest(12)).number).toBe(12);
  });

  test("a number that is no whole number of 1 or more is refused before glab is called", async () => {
    const dir = tempDir();
    const gitlab = await platform(dir, {});

    for (const number of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(gitlab.mergeRequest(number)).rejects.toThrow("not a merge request number");
      await expect(gitlab.comments(number)).rejects.toThrow("not a merge request number");
    }

    expect(glabCalls(dir)).toEqual([]);
  });
});

describe("GitLab platform: the comments", () => {
  test("reads the discussions to their last page with one GET, 100 entries a page", async () => {
    const dir = tempDir();
    const gitlab = await platform(dir, { [paths.discussions]: { stdout: "" } });

    expect(await gitlab.comments(12)).toEqual({ comments: [], complete: true, problems: [] });
    expect(glabCalls(dir)).toEqual([[...READ, "--paginate", `${DISCUSSIONS}?per_page=100`]]);
    expect(cliDirs(dir, "glab")).toEqual([dir]);
  });

  test("gives the notes of every page in order; a note outside the diff is a general comment", async () => {
    const pages = jsonLines(
      discussion("d1", note(101)),
      discussion("d2", note(102, { type: "DiscussionNote", body: "Why now?", author: { username: "cy" } })),
      discussion("d3", note(103, { author: null, created_at: "2026-11-22T09:00:00.000Z" })),
    );

    expect(await commentsOf(pages)).toEqual({
      comments: [
        {
          ...general,
          id: "101",
          ref: "gitlab:note/101",
          author: "ada",
          body: "y can be 0",
          replyTo: null,
          createdAt: "2026-11-20T10:00:00.000Z",
        },
        {
          ...general,
          id: "102",
          ref: "gitlab:note/102",
          author: "cy",
          body: "Why now?",
          replyTo: null,
          createdAt: "2026-11-20T10:00:00.000Z",
        },
        {
          ...general,
          id: "103",
          ref: "gitlab:note/103",
          author: null,
          body: "y can be 0",
          replyTo: null,
          createdAt: "2026-11-22T09:00:00.000Z",
        },
      ],
      complete: true,
      problems: [],
    });
  });

  test("the lines GitLab writes itself are no comments, alone or inside a discussion", async () => {
    const moved = note(202, { type: "DiffNote", system: true, body: "changed this line", position: position() });

    const read = await commentsOf(
      jsonLines(
        discussion("d1", note(201, { system: true, body: "added 1 commit" })),
        discussion(
          "d2",
          note(203, { type: "DiffNote", position: position() }),
          moved,
          note(204, { type: "DiffNote", body: "fixed", position: position() }),
        ),
        discussion("d3", { ...moved, id: 205 }, note(206, { type: "DiffNote", position: position() })),
        discussion("d4", note(207, { system: true }), note(208, { system: true })),
      ),
    );

    expect(read.complete).toBe(true);

    expect(read.comments.map((comment) => [comment.id, comment.replyTo])).toEqual([
      ["203", null],
      ["204", "203"],
      ["206", null],
    ]);
  });

  test("a note in the diff is a line comment: one line, a range, an unchanged line, a whole file", async () => {
    const range = {
      start: { line_code: "x_3_4", type: "new", old_line: null, new_line: 4 },
      end: { line_code: "x_3_9", type: "new", old_line: null, new_line: 9 },
    };

    const mixed = {
      start: { line_code: "x_203_230", type: "new", old_line: null, new_line: 230 },
      end: { line_code: "x_205_233", type: null, old_line: 205, new_line: 233 },
    };

    const file = { base_sha: SHA_B, start_sha: SHA_C, head_sha: SHA_A, old_path: "src/a.ts", new_path: "src/a.ts" };

    const read = await commentsOf(
      jsonLines(
        discussion("d1", note(301, { type: "DiffNote", position: position() })),
        discussion("d2", note(302, { type: "DiffNote", position: position({ new_line: 9, line_range: range }) })),
        discussion("d3", note(303, { type: "DiffNote", position: position({ old_line: 36, new_line: 35 }) })),
        discussion(
          "d4",
          note(304, { type: "DiffNote", position: position({ old_line: 205, new_line: 233, line_range: mixed }) }),
        ),
        discussion("d5", note(305, { type: "DiffNote", position: { ...file, position_type: "file" } })),
        discussion(
          "d6",
          note(306, {
            type: "DiffNote",
            position: { ...file, position_type: "image", x: 1, y: 2, width: 3, height: 4 },
          }),
        ),
        discussion("d7", note(307, { type: "DiffNote", position: position({ old_path: null, head_sha: SHA_C }) })),
        discussion("d8", note(308, { type: "DiffNote", position: position({ new_line: null }) })),
      ),
    );

    const comment = { ...onLine, author: "ada", body: "y can be 0", replyTo: null };

    expect(read).toEqual({
      comments: [
        { ...comment, id: "301", ref: "gitlab:note/301", lines: { start: 7, end: 7 } },
        { ...comment, id: "302", ref: "gitlab:note/302", lines: { start: 4, end: 9 } },
        { ...comment, id: "303", ref: "gitlab:note/303", lines: { start: 35, end: 35 } },
        { ...comment, id: "304", ref: "gitlab:note/304", lines: { start: 230, end: 233 } },
        { ...comment, id: "305", ref: "gitlab:note/305", lines: null, side: null },
        { ...comment, id: "306", ref: "gitlab:note/306", lines: null, side: null },
        { ...comment, id: "307", ref: "gitlab:note/307", lines: { start: 7, end: 7 }, commit: SHA_C },
        { ...comment, id: "308", ref: "gitlab:note/308", lines: null, side: null },
      ],
      complete: true,
      problems: [],
    });
  });

  test("a note on a removed line is on the old side: the line before the change, the file by its new path, the head commit", async () => {
    const removed = position({ old_path: "src/old.ts", new_path: "src/a.ts", old_line: 5, new_line: null });

    const range = {
      start: { line_code: "x_3_3", type: "old", old_line: 3, new_line: null },
      end: { line_code: "x_5_3", type: "old", old_line: 5, new_line: null },
    };

    const crossing = {
      start: { line_code: "x_2_2", type: "new", old_line: null, new_line: 2 },
      end: { line_code: "x_5_3", type: "old", old_line: 5, new_line: null },
    };

    const read = await commentsOf(
      jsonLines(
        discussion(
          "d1",
          note(401, { type: "DiffNote", position: removed }),
          note(402, { type: "DiffNote", body: "it was dead code", author: { username: "bob" }, position: removed }),
        ),
        discussion("d2", note(403, { type: "DiffNote", position: { ...removed, line_range: range } })),
        discussion("d3", note(404, { type: "DiffNote", position: { ...removed, line_range: crossing } })),
        discussion("d4", note(405, { type: "DiffNote", position: { ...removed, new_path: null } })),
      ),
    );

    const comment = { ...onLine, side: "old", author: "ada", body: "y can be 0", replyTo: null } as const;

    expect(read).toEqual({
      comments: [
        { ...comment, id: "401", ref: "gitlab:note/401", lines: { start: 5, end: 5 } },
        {
          ...comment,
          id: "402",
          ref: "gitlab:note/402",
          lines: { start: 5, end: 5 },
          author: "bob",
          body: "it was dead code",
          replyTo: "401",
        },
        { ...comment, id: "403", ref: "gitlab:note/403", lines: { start: 3, end: 5 } },
        { ...comment, id: "404", ref: "gitlab:note/404", lines: { start: 5, end: 5 } },
        { ...comment, id: "405", ref: "gitlab:note/405", lines: { start: 5, end: 5 }, file: "src/old.ts" },
      ],
      complete: true,
      problems: [],
    });
  });

  test("in a discussion the first note starts the thread and every later note answers the first", async () => {
    const read = await commentsOf(
      jsonLines(
        discussion(
          "d1",
          note(501, { type: "DiffNote", position: position() }),
          note(502, { type: "DiffNote", position: position() }),
          note(503, { type: "DiffNote", position: position() }),
        ),
        discussion("d2", note(504, { type: "DiscussionNote" }), note(505, { type: "DiscussionNote" })),
        discussion("d3", note(506)),
      ),
    );

    expect(read.comments.map((comment) => [comment.id, comment.kind, comment.replyTo])).toEqual([
      ["501", "line", null],
      ["502", "line", "501"],
      ["503", "line", "501"],
      ["504", "general", null],
      ["505", "general", "504"],
      ["506", "general", null],
    ]);
  });

  test("a read glab did not finish makes the result incomplete, with the entries before the cut", async () => {
    const read = await (
      await platform(tempDir(), {
        [paths.discussions]: {
          stdout: `${jsonLines(discussion("d1", note(601)), discussion("d2", note(602)))}{"message":"502 Bad Gateway"}`,
          stderr: "glab: 502 Bad Gateway (HTTP 502)\n",
          exitCode: 1,
        },
      })
    ).comments(12);

    expect(read.complete).toBe(false);
    expect(read.comments.map((comment) => comment.id)).toEqual(["601", "602"]);
    expect(read.problems).toEqual([`${DISCUSSIONS}: glab api failed (exit 1): glab: 502 Bad Gateway (HTTP 502)`]);
  });

  test("a failed read is incomplete also when what glab printed is whole", async () => {
    const read = await (
      await platform(tempDir(), {
        [paths.discussions]: {
          stdout: jsonLines(discussion("d1", note(601))),
          stderr: "glab: 429 Too Many Requests (HTTP 429)\n",
          exitCode: 1,
        },
      })
    ).comments(12);

    expect(read.comments.map((comment) => comment.id)).toEqual(["601"]);
    expect(read.complete).toBe(false);
    expect(read.problems).toEqual([`${DISCUSSIONS}: glab api failed (exit 1): glab: 429 Too Many Requests (HTTP 429)`]);
  });

  test("an answer that is not lines of entries makes the result incomplete, also when glab ends with 0", async () => {
    const cutLine = `${jsonLines(discussion("d1", note(601)))}{"id":"d2","notes":[{"id":602,"body":"cut he`;
    const notLines = "the answer of glab is not the lines of entries it should be";

    expect(await commentsOf(cutLine)).toEqual({
      comments: [expect.objectContaining({ id: "601" })],
      complete: false,
      problems: [`${DISCUSSIONS}: ${notLines}`],
    });

    expect(await commentsOf("<html>\nbusy\n</html>\n")).toEqual({
      comments: [],
      complete: false,
      problems: [`${DISCUSSIONS}: ${notLines}`],
    });

    expect(await commentsOf(`${jsonLines(discussion("d1", note(601)))}\n`)).toMatchObject({
      complete: false,
      problems: [`${DISCUSSIONS}: ${notLines}`],
    });
  });

  test("an entry that cannot be read makes the result incomplete and is never given half", async () => {
    const read = await commentsOf(
      jsonLines(
        discussion("d1", note(701)),
        { message: "500 Internal Server Error" },
        discussion("d3", note(703), { id: "x" }),
        discussion("d4", note(704, { type: "DiffNote", position: position({ head_sha: "HEAD" }) })),
        discussion("d5", note(705, { type: "DiffNote", position: position({ position_type: "video" }) })),
        discussion("d6", note(706, { type: "DiffNote", position: position({ old_path: null, new_path: null }) })),
        discussion("d7", note(707)),
      ),
    );

    expect(read.complete).toBe(false);
    expect(read.comments.map((comment) => comment.id)).toEqual(["701", "707"]);
    expect(read.problems).toEqual([`${DISCUSSIONS}: 5 of 7 entries cannot be read`]);
  });

  test("a sign-in GitLab does not accept and an unknown merge request are errors, not an incomplete result", async () => {
    const cases: [CliAnswer, PlatformFailure][] = [
      [{ exitCode: 1, stderr: "glab: 401 Unauthorized (HTTP 401)\n" }, "signed_out"],
      [NOT_FOUND, "not_found"],
    ];

    for (const [answer, kind] of cases) {
      const gitlab = await platform(tempDir(), { [paths.discussions]: answer });

      expect((await failure(gitlab.comments(12))).kind).toBe(kind);
    }
  });
});

describe("GitLab platform: the project of the origin remote", () => {
  test("every call names the host and the full path of the project of the origin remote, as one encoded segment", async () => {
    const origins: [string, string, string][] = [
      ["https://gitlab.com/acme/shop.git", "gitlab.com", "acme/shop"],
      ["ssh://git@gitlab.com:2222/acme/shop.git", "gitlab.com", "acme/shop"],
      ["https::https://gitlab.com/acme/shop.git", "gitlab.com", "acme/shop"],
      ["git@Git.Example.com:Acme/Group/Sub-Group/shop.v2.git", "git.example.com", "Acme/Group/Sub-Group/shop.v2"],
    ];

    for (const [origin, host, project] of origins) {
      const dir = tempDir(origin);
      const asked = glabPaths(12, project);

      const gitlab = await platform(dir, {
        [asked.mergeRequest]: {
          stdout: mergeRequestJson({ webUrl: `https://${host}/${project}/-/merge_requests/12` }),
        },
        [asked.discussions]: { stdout: "" },
      });

      expect((await gitlab.mergeRequest(12)).number).toBe(12);
      expect((await gitlab.comments(12)).complete).toBe(true);

      const read = ["api", "--method", "GET", "--output", "ndjson", "--hostname", host];
      const segment = project.replaceAll("/", "%2F");

      expect(glabCalls(dir)).toEqual([
        [...read, `projects/${segment}/merge_requests/12`],
        [...read, "--paginate", `projects/${segment}/merge_requests/12/discussions?per_page=100`],
      ]);
    }
  });

  test("another remote plays no part: glab is left nothing to choose", async () => {
    const dir = tempDir();

    sh(dir, ["remote", "add", "upstream", "https://gitlab.com/other/shop.git"]);
    sh(dir, ["config", "remote.upstream.glab-resolved", "base"]);

    const gitlab = await platform(dir, { [paths.mergeRequest]: { stdout: mergeRequestJson() } });

    await gitlab.mergeRequest(12);

    expect(glabCalls(dir)).toEqual([[...READ, "projects/acme%2Fshop/merge_requests/12"]]);
    expect(glabCalls(dir).flat().join(" ")).not.toMatch(/:fullpath|other/);
  });

  test("an answer of another project is a platform error; the old form of web_url and another case are the same project", async () => {
    const other = await platform(tempDir(), {
      [paths.mergeRequest]: {
        stdout: mergeRequestJson({ webUrl: "https://gitlab.com/other/shop/-/merge_requests/12" }),
      },
    });

    const error = await failure(other.mergeRequest(12));

    expect({ kind: error.kind, message: error.message }).toEqual({
      kind: "failed",
      message:
        'glab answered with a merge request of "other/shop", not of acme/shop, the project of the origin remote; when the project was renamed or moved, point the origin remote at its new address and run again',
    });

    for (const webUrl of [
      "https://gitlab.com/acme/shop/merge_requests/12",
      "https://gitlab.com/Acme/Shop/-/merge_requests/12",
      "https://gitlab.com/acme/shop/-/merge_requests/12/",
    ]) {
      const same = await platform(tempDir(), { [paths.mergeRequest]: { stdout: mergeRequestJson({ webUrl }) } });

      expect((await same.mergeRequest(12)).number).toBe(12);
    }

    const noProject = await platform(tempDir(), {
      [paths.mergeRequest]: { stdout: mergeRequestJson({ webUrl: "https://gitlab.com/dashboard" }) },
    });

    expect((await failure(noProject.mergeRequest(12))).message).toBe(
      "the answer of glab for merge request 12 cannot be read: web_url names no project",
    );
  });

  test("a repository without an origin remote, and an origin that names no project on GitLab, stop before glab is called", async () => {
    const cases: [string, string][] = [
      ["no origin", "this repository has no origin remote: "],
      ["../shop.git", "the origin remote is a path on this machine: "],
      [
        "https://gitlab.com/shop.git",
        "the origin remote names gitlab.com/shop, which is no GitLab project: a project is a namespace and a name, <namespace>/<name>",
      ],
    ];

    for (const [origin, message] of cases) {
      const dir = tempDir(origin);
      const gitlab = await platform(dir, {});

      for (const read of [gitlab.mergeRequest(12), gitlab.comments(12)]) {
        const error = await failure(read);

        expect(error.kind).toBe("no_repository");
        expect(error.message).toStartWith(message);
      }

      expect(glabCalls(dir)).toEqual([]);
    }
  });

  test("nothing of a remote adds an argument, a second endpoint or a query to a call of glab", async () => {
    const refused = [
      "git@gitlab.com:acme/shop --method DELETE",
      "https://gitlab.com/acme/shop?per_page=1",
      "git@gitlab.com:acme/shop/../../users",
      "https://gitlab.com/acme/shop%2F..%2F..%2Fusers",
      "git@gitlab.com::fullpath/x",
      "git@gitlab.com:acme/:id",
      "git@--hostname=evil.example:acme/shop",
    ];

    for (const origin of refused) {
      const dir = tempDir(origin);
      const gitlab = await platform(dir, {});

      expect((await failure(gitlab.mergeRequest(12))).kind).toBe("no_repository");
      expect((await failure(gitlab.comments(12))).kind).toBe("no_repository");
      expect(glabCalls(dir)).toEqual([]);
    }

    const dir = tempDir("git@gitlab.com:--method/-XDELETE/merge_requests.git");
    const gitlab = await platform(dir, {});

    expect((await failure(gitlab.mergeRequest(12))).kind).toBe("failed");
    expect(glabCalls(dir)).toEqual([[...READ, "projects/--method%2F-XDELETE%2Fmerge_requests/merge_requests/12"]]);
  });

  test("a sign-in that is not accepted names the host of the origin remote", async () => {
    const dir = tempDir("https://git.example.com/acme/shop.git");

    const gitlab = await platform(dir, {
      [paths.mergeRequest]: { exitCode: 1, stderr: "glab: 401 Unauthorized (HTTP 401)\n" },
    });

    expect((await failure(gitlab.mergeRequest(12))).message).toBe(
      "GitLab at git.example.com did not accept the sign-in of glab (HTTP 401): run `glab auth login --hostname git.example.com`, or correct the token in GITLAB_TOKEN when that variable is set, and run again",
    );
  });
});

describe("GitLab platform: the budget of a read", () => {
  const twoLines = jsonLines(discussion("d1", note(601)), discussion("d2", note(602)));
  const threeLines = `${twoLines}${jsonLines(discussion("d3", note(603)))}`;

  test("discussions larger than the byte limit stop there: the entries that stand whole are kept and the result is incomplete", async () => {
    const bytes = twoLines.length + 5;
    const gitlab = await platform(tempDir(), { [paths.discussions]: { stdout: threeLines } }, { ...LIMITS, bytes });
    const read = await gitlab.comments(12);

    expect(read.comments.map((comment) => comment.id)).toEqual(["601", "602"]);
    expect(read.complete).toBe(false);

    expect(read.problems).toEqual([
      `${DISCUSSIONS}: glab printed more than ${bytes} bytes, and the read stopped there`,
    ]);
  });

  test("discussions of exactly the byte limit are whole", async () => {
    const gitlab = await platform(
      tempDir(),
      { [paths.discussions]: { stdout: threeLines } },
      { ...LIMITS, bytes: threeLines.length },
    );

    expect(await gitlab.comments(12)).toMatchObject({ complete: true, problems: [] });
  });

  test("discussions glab does not finish within the time limit stop there, with the entries it printed, and say so", async () => {
    const gitlab = await platform(
      tempDir(),
      { [paths.discussions]: { stdout: twoLines, hangs: true } },
      { ...LIMITS, ms: 300 },
    );

    const started = Date.now();
    const read = await gitlab.comments(12);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(read.comments.map((comment) => comment.id)).toEqual(["601", "602"]);
    expect(read.complete).toBe(false);

    expect(read.problems).toEqual([
      `${DISCUSSIONS}: glab did not finish within 0.3 seconds, and the read stopped there`,
    ]);
  });

  test("a merge request read that reaches a limit is a platform error that names the limit", async () => {
    const cases: [CliAnswer, PlatformReadLimits, string][] = [
      [
        { stdout: mergeRequestJson(), hangs: true },
        { ...LIMITS, ms: 300 },
        "merge request 12 was not read: glab did not finish within 0.3 seconds, and the read stopped there",
      ],
      [
        { stdout: mergeRequestJson() },
        { ...LIMITS, bytes: 100 },
        "merge request 12 was not read: glab printed more than 100 bytes, and the read stopped there",
      ],
    ];

    for (const [answer, limits, message] of cases) {
      const gitlab = await platform(tempDir(), { [paths.mergeRequest]: answer }, limits);
      const error = await failure(gitlab.mergeRequest(12));

      expect({ kind: error.kind, message: error.message }).toEqual({ kind: "failed", message });
    }
  });
});

describe("GitLab platform: the environment of glab", () => {
  test("glab gets the program's environment, with colors and its look for a new version turned off", async () => {
    const dir = tempDir();

    const env = {
      PATH: process.env.PATH ?? "",
      GITLAB_TOKEN: "gitlab-token-of-the-platform-test",
      GITLAB_HOST: "gitlab.example.com",
      GLAB_COLOR: "always",
      GLAB_CHECK_UPDATE: "true",
      UNSET: undefined,
    };

    const { app } = await KerpetenApp.start({ io: { out: () => {}, err: () => {} }, env }, COMPONENTS);

    try {
      const glabCommand = fakeGlab(
        dir,
        { [paths.mergeRequest]: { stdout: mergeRequestJson() } },
        `env > '${join(dir, "env.txt")}'`,
      );

      const run = new Run(
        { group: PermissionGroupSet.ALL, every: true },
        { values: { repo: dir, glabCommand, glabLimits: LIMITS }, container: app.container, test: true },
      );

      await (await run.ready(TestGitLabPlatform)).mergeRequest(12);
    } finally {
      await app.stop();
    }

    const lines = readFileSync(join(dir, "env.txt"), "utf8").split("\n");

    expect(lines).toContain("GITLAB_TOKEN=gitlab-token-of-the-platform-test");
    expect(lines).toContain("GITLAB_HOST=gitlab.example.com");
    expect(lines).toContain(`PATH=${env.PATH}`);
    expect(lines).toContain("GLAB_COLOR=never");
    expect(lines).toContain("GLAB_CHECK_UPDATE=false");
    expect(lines.filter((line) => line.startsWith("GLAB_COLOR=")).length).toBe(1);
    expect(lines.filter((line) => line.startsWith("GLAB_CHECK_UPDATE=")).length).toBe(1);
    expect(lines.map((line) => line.split("=")[0])).not.toContain("UNSET");
  });
});

describe("JSON lines", () => {
  test("lines that are whole give their entries in order", () => {
    expect(JsonLines.read('{"a":1}\n[2]\n3\n')).toMatchObject({ items: [{ a: 1 }, [2], 3], whole: true });

    expect(JsonLines.read('{"body":"a line\\nbreak and a ] }"}\n')).toMatchObject({
      items: [{ body: "a line\nbreak and a ] }" }],
      whole: true,
    });

    expect(JsonLines.read("")).toMatchObject({ items: [], whole: true });
  });

  test("a text that does not end in a newline keeps the lines before its tail and is not whole", () => {
    expect(JsonLines.read('{"a":1}\n{"b":2')).toMatchObject({ items: [{ a: 1 }], whole: false });
    expect(JsonLines.read('{"a":1}\n{"message":"502 Bad Gateway"}')).toMatchObject({ items: [{ a: 1 }], whole: false });
    expect(JsonLines.read('{"a":1}')).toMatchObject({ items: [], whole: false });
  });

  test("a line that is no JSON is left out and the text is not whole", () => {
    expect(JsonLines.read('{"a":1}\n<html>\n{"b":2}\n')).toMatchObject({ items: [{ a: 1 }, { b: 2 }], whole: false });
    expect(JsonLines.read('{"a":1}\n\n')).toMatchObject({ items: [{ a: 1 }], whole: false });
    expect(JsonLines.read('\u001b[1m{\u001b[0m"a":1}\n')).toMatchObject({ items: [], whole: false });
  });
});
