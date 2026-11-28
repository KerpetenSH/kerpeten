import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KerpetenApp } from "../../../src/app/KerpetenApp.ts";
import { GitHubCommentWriter } from "../../../src/capability/platform/GitHubCommentWriter.ts";
import { PlatformLimits } from "../../../src/capability/platform/PlatformLimits.ts";
import type { PlatformLineComment, PlatformReadLimits } from "../../../src/capability/platform/types/platform.ts";
import { runComponent } from "../../app/app-utils.ts";
import { FakeGitHub } from "./FakeGitHub.ts";
import { fakeGitHub, GITHUB_ORIGIN, gitHub, gitHubWrites, originRepo, SHA_A } from "./platform-utils.ts";
import { TestGitHubCommentWriter } from "./TestGitHubCommentWriter.ts";
import type { FakeGitHubStart } from "./types/fake-github.ts";

const COMPONENTS = [
  ...KerpetenApp.COMPONENTS.filter((component) => component !== GitHubCommentWriter),
  TestGitHubCommentWriter,
];

const LIMITS: PlatformReadLimits = { bytes: PlatformLimits.READ_BYTES, ms: PlatformLimits.READ_MS };

const POST = ["api", "--method", "POST", "--hostname", "github.com"];

const PATCH = ["api", "--method", "PATCH", "--hostname", "github.com"];

const READ_ALL = ["api", "--method", "GET", "--hostname", "github.com", "--paginate", "--slurp"];

const FROM_STDIN = ["--input", "-"];

const REVIEWS = "repos/Acme/Shop/pulls/12/reviews";

const AGAIN = "run again: what is already written is not written a second time";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new repository whose remote `origin` is at `origin`, the test repository on github.com when none is given. */
function tempDir(origin: string = GITHUB_ORIGIN): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kerpeten-writer-")));

  dirs.push(dir);

  return originRepo(dir, origin);
}

/** The writer of a new run in `dir`, with a fake GitHub there that starts as `start` says, and with the call budget `limits`. */
function writer(
  dir: string,
  start: FakeGitHubStart = {},
  limits: PlatformReadLimits = LIMITS,
): Promise<TestGitHubCommentWriter> {
  return runComponent(
    TestGitHubCommentWriter,
    { repo: dir, ghCommand: fakeGitHub(dir, start), ghLimits: limits },
    { components: COMPONENTS },
  );
}

/** A line comment on `line` of `src/a.ts`, from `startLine` when one is given, whose text ends with a marker of its own. */
function onLine(line: number, startLine = line): PlatformLineComment {
  const marker = `<!-- marker of lines ${startLine}-${line} -->`;

  return { file: "src/a.ts", startLine, endLine: line, body: `Finding on line ${line}.\n${marker}`, marker };
}

/** The lines of the comments of each review that the fake gh was sent, in the order of the calls. */
function sentLines(dir: string): number[][] {
  return gitHubWrites(dir).map((call) =>
    JSON.parse(call.input ?? "").comments.map((comment: { line: number }) => comment.line),
  );
}

describe("GitHub comment writer: the line comments", () => {
  test("sends all comments as one review at the head commit, with the JSON on standard input, and reads their ids back", async () => {
    const dir = tempDir();
    const github = await writer(dir);
    const comments = [onLine(2), onLine(9, 7)];

    expect(await github.writeLineComments(12, SHA_A, comments)).toEqual({
      outcomes: [
        { kind: "written", ref: "github:review_comment/9002" },
        { kind: "written", ref: "github:review_comment/9003" },
      ],
      problems: [],
    });

    const { calls } = gitHub(dir);

    expect(calls.map((call) => call.args)).toEqual([
      [...POST, REVIEWS, ...FROM_STDIN],
      [...READ_ALL, `${REVIEWS}/9001/comments?per_page=100`],
    ]);

    expect(JSON.parse(calls[0]?.input ?? "")).toEqual({
      commit_id: SHA_A,
      event: "COMMENT",
      comments: [
        { path: "src/a.ts", line: 2, side: "RIGHT", body: comments[0]?.body },
        { path: "src/a.ts", line: 9, side: "RIGHT", start_line: 7, start_side: "RIGHT", body: comments[1]?.body },
      ],
    });

    expect(calls[1]?.input).toBeUndefined();

    expect(gitHub(dir).lineComments.map((comment) => [comment.id, comment.line, comment.start_line])).toEqual([
      [9002, 2, null],
      [9003, 9, 7],
    ]);
  });

  test("the text of a comment is never an argument of gh", async () => {
    const dir = tempDir();
    const github = await writer(dir);
    const marker = "<!-- m -->";
    const body = `--method DELETE "$(touch pwned)" \`x\`\n${marker}`;

    await github.writeLineComments(12, SHA_A, [{ file: "src/a.ts", startLine: 2, endLine: 2, body, marker }]);

    expect(
      gitHub(dir)
        .calls.flatMap((call) => call.args)
        .join(" "),
    ).not.toContain("DELETE");

    expect(gitHub(dir).lineComments[0]?.body).toBe(body);
  });

  test("no comment is no call", async () => {
    const dir = tempDir();
    const github = await writer(dir);

    expect(await github.writeLineComments(12, SHA_A, [])).toEqual({ outcomes: [], problems: [] });
    expect(gitHub(dir).calls).toEqual([]);
  });

  test("a review GitHub refuses as invalid is cut in two until the refused comment is alone: that one is refused, the others are written", async () => {
    const dir = tempDir();
    const github = await writer(dir, { rules: { refusedLines: [4] } });
    const comments = [1, 2, 3, 4, 5].map((line) => onLine(line));
    const write = await github.writeLineComments(12, SHA_A, comments);

    expect(write.outcomes.map((outcome) => outcome.kind)).toEqual([
      "written",
      "written",
      "written",
      "refused",
      "written",
    ]);

    expect(write.outcomes[3]).toEqual({ kind: "refused", reason: `Unprocessable Entity: ${FakeGitHub.NOT_IN_DIFF}` });
    expect(write.problems).toEqual([]);

    expect(sentLines(dir)).toEqual([[1, 2, 3, 4, 5], [1, 2, 3], [4, 5], [4], [5]]);

    expect(gitHub(dir).lineComments.map((comment) => comment.line)).toEqual([1, 2, 3, 5]);

    const refs = write.outcomes.flatMap((outcome) => (outcome.kind === "written" ? [outcome.ref] : []));

    expect(refs).toEqual(gitHub(dir).lineComments.map((comment) => `github:review_comment/${comment.id}`));
  });

  test("when every comment is refused, each is refused alone and nothing is written", async () => {
    const dir = tempDir();
    const github = await writer(dir, { rules: { refusedLines: [1, 2, 3] } });
    const write = await github.writeLineComments(12, SHA_A, [onLine(1), onLine(2), onLine(3)]);

    expect(write.outcomes.map((outcome) => outcome.kind)).toEqual(["refused", "refused", "refused"]);
    expect(sentLines(dir)).toEqual([[1, 2, 3], [1, 2], [1], [2], [3]]);
    expect(gitHub(dir).lineComments).toEqual([]);
  });

  test("a pending review of the user is no refused line: every comment failed with what to do, and nothing is cut or sent again", async () => {
    const dir = tempDir();
    const github = await writer(dir, { rules: { pendingReview: true } });
    const write = await github.writeLineComments(12, SHA_A, [onLine(1), onLine(2), onLine(3)]);

    const message = `not written: your account has a review on this pull request that is not submitted yet, and GitHub takes no other review beside it: submit or delete that review on the page of the pull request and run again (GitHub answered: Unprocessable Entity: ${FakeGitHub.PENDING})`;

    expect(write).toEqual({
      outcomes: [
        { kind: "failed", message },
        { kind: "failed", message },
        { kind: "failed", message },
      ],
      problems: [],
    });

    expect(sentLines(dir)).toEqual([[1, 2, 3]]);
  });

  test("a 422 that names no line is no refused line: every comment failed with GitHub's text, and nothing is cut or sent again", async () => {
    const dir = tempDir();
    const spam = FakeGitHub.refusal(422, "Unprocessable Entity", ["Review was flagged as spam"]);
    const github = await writer(dir, { rules: { review: spam } });
    const write = await github.writeLineComments(12, SHA_A, [onLine(1), onLine(2), onLine(3)]);

    const message =
      "not written: GitHub refused the request as invalid (HTTP 422): Unprocessable Entity: Review was flagged as spam";

    expect(write.outcomes).toEqual([
      { kind: "failed", message },
      { kind: "failed", message },
      { kind: "failed", message },
    ]);

    expect(sentLines(dir)).toEqual([[1, 2, 3]]);
  });

  test("a server error leaves it unknown whether the comments of the call are written, with GitHub's text, and nothing is cut or sent again", async () => {
    const dir = tempDir();
    const github = await writer(dir, { rules: { review: FakeGitHub.refusal(502, "Server Error") } });
    const write = await github.writeLineComments(12, SHA_A, [onLine(1), onLine(2)]);
    const message = `it is not known whether GitHub wrote it: gh api failed (exit 1): gh: Server Error (HTTP 502); ${AGAIN}`;

    expect(write.outcomes).toEqual([
      { kind: "failed", message },
      { kind: "failed", message },
    ]);

    expect(sentLines(dir)).toEqual([[1, 2]]);
  });

  test("a request GitHub refused with another status from 400 to 499 wrote nothing for sure", async () => {
    const dir = tempDir();
    const github = await writer(dir, { rules: { review: FakeGitHub.refusal(403, FakeGitHub.NOT_YOURS) } });

    expect((await github.writeLineComments(12, SHA_A, [onLine(1)])).outcomes).toEqual([
      {
        kind: "failed",
        message: `not written: GitHub does not let the account gh is signed in to github.com with do this (HTTP 403): ${FakeGitHub.NOT_YOURS}`,
      },
    ]);

    expect(sentLines(dir)).toEqual([[1]]);
  });

  test("after the time limit it is not known whether GitHub wrote the comments, and the message says so", async () => {
    const dir = tempDir();

    const github = await writer(
      dir,
      { rules: { review: { hangs: true }, keepsReview: true } },
      { bytes: PlatformLimits.READ_BYTES, ms: 1500 },
    );

    const write = await github.writeLineComments(12, SHA_A, [onLine(1), onLine(2)]);
    const message = `it is not known whether GitHub wrote it: gh did not finish within 1.5 seconds; ${AGAIN}`;

    expect(write.outcomes).toEqual([
      { kind: "failed", message },
      { kind: "failed", message },
    ]);

    expect(sentLines(dir)).toEqual([[1, 2]]);
    expect(gitHub(dir).lineComments.map((comment) => comment.line)).toEqual([1, 2]);
  });

  test("an answer over the output limit leaves it unknown too", async () => {
    const dir = tempDir();
    const github = await writer(dir, {}, { bytes: 10, ms: PlatformLimits.READ_MS });
    const write = await github.writeLineComments(12, SHA_A, [onLine(1)]);

    expect(write.outcomes).toEqual([
      {
        kind: "failed",
        message: `it is not known whether GitHub wrote it: gh printed more than 10 bytes; ${AGAIN}`,
      },
    ]);
  });

  test("a gh that is signed out, one that is missing and an origin that is no GitHub repository fail every comment with what to do", async () => {
    const signedOut = await writer(tempDir(), { rules: { review: { exitCode: 4, stderr: "not logged in\n" } } });

    expect((await signedOut.writeLineComments(12, SHA_A, [onLine(1)])).outcomes).toEqual([
      {
        kind: "failed",
        message:
          "not written: gh is not signed in to github.com: run `gh auth login --hostname github.com` and run again",
      },
    ]);

    const dir = tempDir();

    const missing = await runComponent(
      TestGitHubCommentWriter,
      { repo: dir, ghCommand: join(dir, "no-gh-here"), ghLimits: LIMITS },
      { components: COMPONENTS },
    );

    const [outcome] = (await missing.writeLineComments(12, SHA_A, [onLine(1)])).outcomes;

    expect(outcome?.kind).toBe("failed");

    expect(outcome?.kind === "failed" ? outcome.message : "").toStartWith(
      "not written: gh, the GitHub CLI, is not found (",
    );

    const group = tempDir("https://github.com/acme/group/shop.git");
    const nested = await writer(group);

    expect((await nested.writeLineComments(12, SHA_A, [onLine(1)])).outcomes).toEqual([
      {
        kind: "failed",
        message:
          "not written: the origin remote names github.com/acme/group/shop, which is no GitHub repository: a repository is an owner and a name, <owner>/<name>",
      },
    ]);

    expect(gitHub(group).calls).toEqual([]);
  });

  test("a 404 to a write says that the pull request is gone or the account may not write", async () => {
    const github = await writer(tempDir(), { rules: { review: FakeGitHub.refusal(404, "Not Found") } });

    expect((await github.writeLineComments(12, SHA_A, [onLine(1)])).outcomes).toEqual([
      {
        kind: "failed",
        message:
          "not written: GitHub did not find what the write is for (HTTP 404): pull request 12 or the comment was removed, or the account gh is signed in to github.com with may not write to Acme/Shop",
      },
    ]);
  });

  test("comments whose ids cannot be read back are written all the same and carry the ref of the review, with one line that says so", async () => {
    const dir = tempDir();
    const github = await writer(dir, { rules: { readBack: FakeGitHub.refusal(502, "Server Error") } });
    const write = await github.writeLineComments(12, SHA_A, [onLine(1), onLine(2)]);

    expect(write.outcomes).toEqual([
      { kind: "written", ref: "github:review/9001" },
      { kind: "written", ref: "github:review/9001" },
    ]);

    expect(write.problems).toEqual([
      `2 of the 2 line comments of review 9001 are written, but their ids could not be read back, so they carry the ref of the review, github:review/9001: ${REVIEWS}/9001/comments: gh api failed (exit 1): gh: Server Error (HTTP 502)`,
    ]);

    expect(gitHub(dir).lineComments.map((comment) => comment.line)).toEqual([1, 2]);
  });

  test("a comment read back is known by the marker its text ends with, not by its place in the list", async () => {
    const dir = tempDir();
    const first = { id: 71, body: `GitHub changed this text.\n${onLine(2).marker}\n` };
    const second = { id: 70, body: onLine(1).body };
    const other = { id: 69, body: "No marker here." };

    const github = await writer(dir, { rules: { readBack: { stdout: JSON.stringify([[other, first], [second]]) } } });
    const write = await github.writeLineComments(12, SHA_A, [onLine(1), onLine(2), onLine(3)]);

    expect(write.outcomes).toEqual([
      { kind: "written", ref: "github:review_comment/70" },
      { kind: "written", ref: "github:review_comment/71" },
      { kind: "written", ref: "github:review/9001" },
    ]);

    expect(write.problems).toEqual([
      "1 of the 3 line comments of review 9001 are written, but their ids could not be read back, so they carry the ref of the review, github:review/9001: the review does not list them",
    ]);
  });

  test("two comments on the same lines share a marker: each gets the id of the comment with its own text, whatever the order they are read in", async () => {
    const dir = tempDir();
    const marker = onLine(2).marker;
    const first = { file: "src/a.ts", startLine: 2, endLine: 2, body: `First finding.\n${marker}`, marker };
    const second = { ...first, body: `Second finding.\n${marker}` };
    const third = { ...first, body: `Third finding.\n${marker}` };

    const listed = [
      { id: 82, body: `${second.body}\n` },
      { id: 83, body: `GitHub changed the third text.\n${marker}` },
      { id: 81, body: first.body },
    ];

    const github = await writer(dir, { rules: { readBack: { stdout: JSON.stringify([listed]) } } });
    const write = await github.writeLineComments(12, SHA_A, [first, second, third]);

    expect(write).toEqual({
      outcomes: [
        { kind: "written", ref: "github:review_comment/81" },
        { kind: "written", ref: "github:review_comment/82" },
        { kind: "written", ref: "github:review_comment/83" },
      ],
      problems: [],
    });
  });

  test("a number, a commit, a place or a text that cannot be right is refused before gh is called", async () => {
    const dir = tempDir();
    const github = await writer(dir);
    const noMarker = { ...onLine(1), body: "The marker is gone." };

    await expect(github.writeLineComments(0, SHA_A, [onLine(1)])).rejects.toThrow("not a pull request number: 0");
    await expect(github.writeLineComments(12, "HEAD", [onLine(1)])).rejects.toThrow("a commit of 40 hex characters");

    await expect(github.writeLineComments(12, SHA_A, [onLine(1, 3)])).rejects.toThrow(
      "not the place of a line comment",
    );

    await expect(github.writeLineComments(12, SHA_A, [noMarker])).rejects.toThrow("does not end with its marker");
    expect(gitHub(dir).calls).toEqual([]);
  });
});

describe("GitHub comment writer: the summary comment", () => {
  test("without a summary comment it makes one in the conversation, with the text on standard input", async () => {
    const dir = tempDir();
    const github = await writer(dir);

    expect(await github.writeSummary(12, "## Kerpeten review\n\nNothing.")).toEqual({
      kind: "written",
      ref: "github:issue_comment/9001",
      updated: false,
    });

    expect(gitHub(dir).calls).toEqual([
      {
        args: [...POST, "repos/Acme/Shop/issues/12/comments", ...FROM_STDIN],
        input: JSON.stringify({ body: "## Kerpeten review\n\nNothing." }),
      },
    ]);

    expect(gitHub(dir).conversation.map((comment) => comment.body)).toEqual(["## Kerpeten review\n\nNothing."]);
  });

  test("with the ref of the summary comment it updates that comment and makes no other", async () => {
    const dir = tempDir();
    const old = { id: 77, user: { login: "the-user" }, body: "old text", created_at: FakeGitHub.NOW };
    const github = await writer(dir, { conversation: [old] });

    expect(await github.writeSummary(12, "new text", "github:issue_comment/77")).toEqual({
      kind: "written",
      ref: "github:issue_comment/77",
      updated: true,
    });

    expect(gitHub(dir).calls).toEqual([
      {
        args: [...PATCH, "repos/Acme/Shop/issues/comments/77", ...FROM_STDIN],
        input: JSON.stringify({ body: "new text" }),
      },
    ]);

    expect(gitHub(dir).conversation).toEqual([{ ...old, body: "new text" }]);
  });

  test("a ref of the wrong kind, of another platform or of no form is refused before gh is called", async () => {
    const dir = tempDir();
    const github = await writer(dir);
    const wrong = "the summary comment of a pull request is a comment of its conversation, which";

    await expect(github.writeSummary(12, "text", "github:review_comment/77")).rejects.toThrow(
      `${wrong} github:review_comment/77 is not`,
    );

    await expect(github.writeSummary(12, "text", "github:review/77")).rejects.toThrow(
      `${wrong} github:review/77 is not`,
    );

    await expect(github.writeSummary(12, "text", "gitlab:note/77")).rejects.toThrow(`${wrong} gitlab:note/77 is not`);

    await expect(github.writeSummary(12, "text", "github:issue_comment/77/../../pulls/1")).rejects.toThrow(
      "not a comment reference",
    );

    expect(gitHub(dir).calls).toEqual([]);
  });

  test("a summary GitHub refuses as invalid wrote nothing; one it fails at leaves it unknown", async () => {
    const invalid = await writer(tempDir(), {
      rules: { summary: FakeGitHub.refusal(422, "Validation Failed", ["Body is too long"]) },
    });

    expect(await invalid.writeSummary(12, "text")).toEqual({
      kind: "failed",
      message: "not written: GitHub refused the request as invalid (HTTP 422): Validation Failed: Body is too long",
    });

    const failing = await writer(tempDir(), { rules: { summary: FakeGitHub.refusal(500, "Server Error") } });

    expect(await failing.writeSummary(12, "text", "github:issue_comment/77")).toEqual({
      kind: "failed",
      message: `it is not known whether GitHub wrote it: gh api failed (exit 1): gh: Server Error (HTTP 500); ${AGAIN}`,
    });
  });

  test("an update GitHub does not let this account make, and one of a comment that is gone, are refused and change nothing", async () => {
    const dir = tempDir();
    const other = { id: 77, user: { login: "another-account" }, body: "their text", created_at: FakeGitHub.NOW };
    const github = await writer(dir, { conversation: [other], rules: { foreignComments: [77] } });

    expect(await github.writeSummary(12, "new text", "github:issue_comment/77")).toEqual({
      kind: "refused",
      reason: `not written: GitHub does not let the account gh is signed in to github.com with do this (HTTP 403): ${FakeGitHub.NOT_YOURS}`,
    });

    expect(await github.writeSummary(12, "new text", "github:issue_comment/78")).toEqual({
      kind: "refused",
      reason:
        "not written: GitHub did not find what the write is for (HTTP 404): pull request 12 or the comment was removed, or the account gh is signed in to github.com with may not write to Acme/Shop",
    });

    expect(gitHub(dir).conversation).toEqual([other]);
  });

  test("a new summary comment GitHub does not let this account make is a failed write, not a refused update", async () => {
    const denied = await writer(tempDir(), { rules: { summary: FakeGitHub.refusal(403, FakeGitHub.NOT_YOURS) } });

    expect(await denied.writeSummary(12, "text")).toEqual({
      kind: "failed",
      message: `not written: GitHub does not let the account gh is signed in to github.com with do this (HTTP 403): ${FakeGitHub.NOT_YOURS}`,
    });
  });
});
