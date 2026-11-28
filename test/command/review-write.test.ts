import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@kerpetensh/harness-kit";
import { KerpetenApp } from "../../src/app/KerpetenApp.ts";
import { commit, sh, tempRepo, write } from "../capability/git/git-utils.ts";
import { FakeGitHub } from "../capability/platform/FakeGitHub.ts";
import {
  fakeCli,
  fakeGitHub,
  GITHUB_ORIGIN,
  GITLAB_ORIGIN,
  gitHub,
  gitHubWrites,
  glabCalls,
  pullJson,
} from "../capability/platform/platform-utils.ts";
import type { FakeGitHubRules, FakeIssueComment } from "../capability/platform/types/fake-github.ts";
import { mockClient } from "../test-utils.ts";

const KEY = "sk-test-secret-value-123";

const KIMI_URL = "https://api.kimi.com/coding/v1";

const ENV = { KERPETEN_TRUSTED_ENDPOINTS: `KIMI_API_KEY=${KIMI_URL}`, KIMI_API_KEY: KEY };

const CONFIG = `models:
  reviewer: { provider: anthropic, model: k3.1-pro, base_url: "${KIMI_URL}", api_key_env: KIMI_API_KEY, max_output_tokens: 3000 }
  judge: { provider: anthropic, model: k3.1-judge, base_url: "${KIMI_URL}", api_key_env: KIMI_API_KEY, max_output_tokens: 2000 }
`;

const GH_READ = ["api", "--method", "GET", "--hostname", "github.com"];

const GH_ALL = [...GH_READ, "--paginate", "--slurp"];

const POST = ["api", "--method", "POST", "--hostname", "github.com"];

const PATCH = ["api", "--method", "PATCH", "--hostname", "github.com"];

const FROM_STDIN = ["--input", "-"];

const PULL = "repos/Acme/Shop/pulls/12";

const CONVERSATION = "repos/Acme/Shop/issues/12/comments";

const READS = [
  [...GH_READ, PULL],
  [...GH_ALL, `${PULL}/comments?per_page=100`],
  [...GH_ALL, `${PULL}/reviews?per_page=100`],
  [...GH_ALL, `${CONVERSATION}?per_page=100`],
];

const NOTE = "👎 If you do not want this finding again, react with 👎; you can reply with the reason.";

const finding = {
  file: "src/a.ts",
  start_line: 2,
  end_line: 2,
  category: "bug",
  title: "Division by zero",
  body: "y can be 0",
  fix: "Throw when y is 0.",
  evidence: [{ location: "src/a.ts:2", note: "no guard" }],
};

const labels = {
  verdict: "verified",
  priority: "P1",
  nature: "edge_case",
  fix_effort: "easy",
  rationale: "y is never checked",
  evidence: [{ location: "src/a.ts:2" }],
};

const REVIEW = [{ text: "done" }, { text: JSON.stringify({ findings: [finding] }) }];

const NO_FINDINGS = [{ text: "done" }, { text: JSON.stringify({ findings: [] }) }];

const JUDGED = [{ text: "done" }, { text: JSON.stringify(labels) }];

const JUDGED_HIGH = [{ text: "done" }, { text: JSON.stringify({ ...labels, priority: "P0", nature: "critical" }) }];

const AGAIN = "run again: what is already written is not written a second time";

const UNWRITTEN =
  "Findings whose comment may be missing here, because writing it failed: 1. The output of the review run lists them.";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kerpeten-cli-write-"));

  dirs.push(dir);

  return dir;
}

/**
 * A repository on the branch `feature`, one commit after `base` on `main`, whose remote `origin` is at `origin`, on
 * github.com when none is given.
 */
function repo(origin: string = GITHUB_ORIGIN): { dir: string; base: string; head: string } {
  const dir = tempRepo("kerpeten-cli-write-repo-");

  dirs.push(dir);
  sh(dir, ["remote", "add", "origin", origin]);
  write(dir, { "src/a.ts": "export const a = 1;\n", ".kerpeten.yml": CONFIG });

  const base = commit(dir, "base");

  sh(dir, ["checkout", "-q", "-b", "feature", base]);
  write(dir, { "src/a.ts": "export const a = 1;\nexport const div = (x: number, y: number) => x / y;\n" });

  return { dir, base, head: commit(dir, "add div") };
}

/**
 * Runs the command in `cwd` with the fake GitHub first on the PATH, and a fake glab without answers beside it. With
 * `bin`, the folder of an earlier run, the GitHub of that run is used as that run left it; without it a new one
 * starts with pull request 12 at `head`, with `rules` and with the comments `conversation` in its conversation.
 */
async function run(
  cwd: string,
  argv: string[],
  options: {
    head?: string;
    base?: string;
    rules?: FakeGitHubRules;
    conversation?: readonly FakeIssueComment[];
    bin?: string;
    script?: Parameters<typeof mockClient>[0];
    judgeScript?: Parameters<typeof mockClient>[0];
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const bin = options.bin ?? tempDir();
  const reviewerMock = mockClient(options.script ?? REVIEW);
  const judgeMock = mockClient(options.judgeScript ?? JUDGED_HIGH);
  let created = 0;

  if (options.bin === undefined) {
    const pull = pullJson({
      ...(options.head === undefined ? {} : { headSha: options.head }),
      ...(options.base === undefined ? {} : { baseSha: options.base }),
    });

    fakeGitHub(bin, {
      pull,
      ...(options.rules === undefined ? {} : { rules: options.rules }),
      ...(options.conversation === undefined ? {} : { conversation: options.conversation }),
    });

    fakeCli(bin, "glab", {});
  }

  const code = await KerpetenApp.run(
    {
      io: { out: (line) => out.push(line), err: (line) => err.push(line) },
      env: { ...ENV, PATH: `${bin}:${process.env.PATH ?? ""}` },
      cwd,
      now: () => 0,
      createClient: () => (created++ === 0 ? reviewerMock.client : judgeMock.client),
    },
    argv,
  );

  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    bin,
    calls: [...reviewerMock.calls, ...judgeMock.calls],
  };
}

/** The lines of stderr that the command reports itself, without the lines of the log. */
function reported(err: string): string[] {
  return err.split("\n").filter((line) => line.startsWith("kerpeten review: "));
}

describe("kerpeten review --mr: the comments are written to the pull request", () => {
  test("writes the line comment as a review at the head commit and the summary comment, after the reads and the models, and shows their refs", async () => {
    const { dir, base, head } = repo();
    const result = await run(dir, ["review", "--mr", "12"], { head, base });

    expect(result.err).not.toContain(" ERROR ");
    expect(result.code).toBe(ExitCode.OK);
    expect(result.calls.length).toBeGreaterThan(0);

    expect(result.out.split("\n").slice(2, 7)).toEqual([
      "findings: 1",
      "comment plan: 1 line comments, 0 in the summary, 0 already written, 0 stored",
      "comments written: 1 line comments, summary comment github:issue_comment/9003",
      "- src/a.ts:2-2 [bug] Division by zero",
      "  verdict verified, priority P0, nature critical, fix_effort easy, score 95, action inline, comment_ref github:review_comment/9002",
    ]);

    const github = gitHub(result.bin);
    const lineBody = `**Division by zero** · bug · P0\n\ny can be 0\n\n**Fix:** Throw when y is 0.\n\n${NOTE}\n<!-- kerpeten:finding v1 head=${head} file=c3JjL2EudHM lines=2-2 -->`;

    const summaryBody = [
      "## Kerpeten review",
      `Reviewed commit ${head}. Line comments in this run: 1.`,
      `<!-- kerpeten:summary v1 head=${head} -->`,
    ].join("\n\n");

    expect(github.calls.map((call) => call.args)).toEqual([
      ...READS,
      [...GH_READ, PULL],
      [...POST, `${PULL}/reviews`, ...FROM_STDIN],
      [...GH_ALL, `${PULL}/reviews/9001/comments?per_page=100`],
      [...POST, CONVERSATION, ...FROM_STDIN],
    ]);

    expect(gitHubWrites(result.bin).map((call) => JSON.parse(call.input ?? ""))).toEqual([
      {
        commit_id: head,
        event: "COMMENT",
        comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: lineBody }],
      },
      { body: summaryBody },
    ]);

    expect(github.reviews.map((review) => [review.id, review.commit_id])).toEqual([[9001, head]]);

    expect(github.lineComments.map((comment) => [comment.id, comment.path, comment.line])).toEqual([
      [9002, "src/a.ts", 2],
    ]);

    expect(github.conversation.map((comment) => [comment.id, comment.body])).toEqual([[9003, summaryBody]]);
    expect(reported(result.err)).toEqual([]);

    expect(result.err).toContain(
      '"comments written" command=review line_comments=1 refused=0 failed=0 summary=created summary_ref=github:issue_comment/9003',
    );
  });

  test("--json gives every written finding and comment its comment_ref, and keeps the shape of a dry run", async () => {
    const { dir, base, head } = repo();
    const result = await run(dir, ["review", "--mr", "12", "--json"], { head, base });

    expect(result.code).toBe(ExitCode.OK);

    const printed = JSON.parse(result.out);

    expect(Object.keys(printed)).toEqual(["merge_request", "findings", "comment_plan", "usage"]);

    expect(
      printed.findings.map((item: { action: string; comment_ref?: string }) => [item.action, item.comment_ref]),
    ).toEqual([["inline", "github:review_comment/9002"]]);

    expect(Object.keys(printed.findings[0]).at(-1)).toBe("comment_ref");

    expect(printed.comment_plan.line_comments.map((comment: { comment_ref: string }) => comment.comment_ref)).toEqual([
      "github:review_comment/9002",
    ]);

    expect(printed.comment_plan.summary.comment_ref).toBe("github:issue_comment/9003");
    expect(printed.comment_plan.summary.body).toBe(gitHub(result.bin).conversation[0]?.body ?? "");
  });

  test("a finding of the summary carries the ref of the summary comment", async () => {
    const { dir, base, head } = repo();
    const result = await run(dir, ["review", "--mr", "12", "--json"], { head, base, judgeScript: JUDGED });
    const printed = JSON.parse(result.out);

    expect(result.code).toBe(ExitCode.OK);

    expect(
      printed.findings.map((item: { action: string; comment_ref?: string }) => [item.action, item.comment_ref]),
    ).toEqual([["summary", "github:issue_comment/9001"]]);

    expect(gitHub(result.bin).lineComments).toEqual([]);
    expect(gitHub(result.bin).conversation[0]?.body).toContain("### Division by zero\n`src/a.ts:2` · bug · P1");
    expect(gitHubWrites(result.bin).length).toBe(1);
  });

  test("a second run writes no line comment twice and updates the same summary comment", async () => {
    const { dir, base, head } = repo();
    const first = await run(dir, ["review", "--mr", "12"], { head, base });

    expect(first.code).toBe(ExitCode.OK);

    const before = gitHub(first.bin);
    const second = await run(dir, ["review", "--mr", "12"], { bin: first.bin });

    expect(second.code).toBe(ExitCode.OK);

    expect(second.out.split("\n").slice(3, 7)).toEqual([
      "comment plan: 0 line comments, 0 in the summary, 1 already written, 0 stored",
      "comments written: 0 line comments, summary comment github:issue_comment/9003",
      "- src/a.ts:2-2 [bug] Division by zero",
      "  verdict verified, priority P0, nature critical, fix_effort easy, score 95, action suppressed_duplicate",
    ]);

    const after = gitHub(first.bin);

    expect(after.calls.slice(before.calls.length).map((call) => call.args)).toEqual([
      ...READS,
      [...GH_READ, PULL],
      [...PATCH, "repos/Acme/Shop/issues/comments/9003", ...FROM_STDIN],
    ]);

    expect(after.reviews).toEqual(before.reviews);
    expect(after.lineComments).toEqual(before.lineComments);
    expect(after.conversation.map((comment) => comment.id)).toEqual([9003]);

    expect(after.conversation[0]?.body).toBe(
      [
        "## Kerpeten review",
        `Reviewed commit ${head}. Line comments in this run: 0. Findings that already had a line comment: 1.`,
        `<!-- kerpeten:summary v1 head=${head} -->`,
      ].join("\n\n"),
    );

    expect(second.err).toContain("summary=updated summary_ref=github:issue_comment/9003");
  });

  test("a review without findings writes the summary comment too", async () => {
    const { dir, base, head } = repo();
    const result = await run(dir, ["review", "--mr", "12"], { head, base, script: NO_FINDINGS });

    expect(result.code).toBe(ExitCode.OK);
    expect(result.out).toContain("comments written: 0 line comments, summary comment github:issue_comment/9001");

    expect(gitHub(result.bin).conversation.map((comment) => comment.body)).toEqual([
      [
        "## Kerpeten review",
        `Reviewed commit ${head}. Line comments in this run: 0.`,
        "The review found nothing to report.",
        `<!-- kerpeten:summary v1 head=${head} -->`,
      ].join("\n\n"),
    ]);

    expect(gitHubWrites(result.bin).length).toBe(1);
  });

  test("a mention and an issue reference a model wrote reach the pull request as code", async () => {
    const { dir, base, head } = repo();
    const acting = { ...finding, title: "@octocat broke #12", body: "cc @acme/reviewers, see acme/shop#7" };
    const script = [{ text: "done" }, { text: JSON.stringify({ findings: [acting] }) }];
    const result = await run(dir, ["review", "--mr", "12"], { head, base, script });

    expect(result.code).toBe(ExitCode.OK);

    const body = gitHub(result.bin).lineComments[0]?.body ?? "";

    expect(body).toStartWith("**`@octocat` broke `#12`** · bug · P0\n\ncc `@acme/reviewers`, see `acme/shop#7`\n\n");
    expect(body.replace(/`[^`]*`/g, "")).not.toMatch(/@\w|#\d/);
  });
});

describe("kerpeten review --mr: a comment that cannot be written", () => {
  test("a line comment GitHub refuses goes to the summary, with the summary's ref, and the review ends with 0", async () => {
    const { dir, base, head } = repo();
    const result = await run(dir, ["review", "--mr", "12"], { head, base, rules: { refusedLines: [2] } });

    expect(result.code).toBe(ExitCode.OK);

    expect(result.out.split("\n").slice(3, 7)).toEqual([
      "comment plan: 0 line comments, 1 in the summary, 0 already written, 0 stored",
      "comments written: 0 line comments, summary comment github:issue_comment/9001",
      "- src/a.ts:2-2 [bug] Division by zero",
      "  verdict verified, priority P0, nature critical, fix_effort easy, score 95, action summary, comment_ref github:issue_comment/9001",
    ]);

    const github = gitHub(result.bin);

    expect(github.lineComments).toEqual([]);
    expect(github.conversation[0]?.body).toContain("Line comments in this run: 0.");
    expect(github.conversation[0]?.body).toContain("### Division by zero\n`src/a.ts:2` · bug · P0\n\ny can be 0");
    expect(reported(result.err)).toEqual([]);

    expect(result.err).toContain(
      `WARN "line comment refused, its finding goes to the summary" command=review place=src/a.ts:2 reason="Unprocessable Entity: ${FakeGitHub.NOT_IN_DIFF}"`,
    );
  });

  test("a line comment that fails leaves its finding stored: the findings are printed, one line on stderr says what was not written, the summary counts it and does not say that nothing was found, and the review ends with 1", async () => {
    const { dir, base, head } = repo();
    const rules = { review: FakeGitHub.refusal(502, "Server Error") };
    const result = await run(dir, ["review", "--mr", "12"], { head, base, rules });

    expect(result.code).toBe(ExitCode.FAILED);

    expect(result.out.split("\n").slice(3, 7)).toEqual([
      "comment plan: 0 line comments, 0 in the summary, 0 already written, 1 stored",
      "comments written: 0 line comments, summary comment github:issue_comment/9001",
      "- src/a.ts:2-2 [bug] Division by zero",
      "  verdict verified, priority P0, nature critical, fix_effort easy, score 95, action stored",
    ]);

    expect(reported(result.err)).toEqual([
      `kerpeten review: line comment on src/a.ts:2: it is not known whether GitHub wrote it: gh api failed (exit 1): gh: Server Error (HTTP 502); ${AGAIN}`,
    ]);

    const github = gitHub(result.bin);

    expect(github.lineComments).toEqual([]);

    expect(github.conversation.map((comment) => comment.body)).toEqual([
      [
        "## Kerpeten review",
        `Reviewed commit ${head}. Line comments in this run: 0.`,
        UNWRITTEN,
        `<!-- kerpeten:summary v1 head=${head} -->`,
      ].join("\n\n"),
    ]);

    expect(gitHubWrites(result.bin).length).toBe(2);

    const json = await run(dir, ["review", "--mr", "12", "--json"], { head, base, rules });
    const printed = JSON.parse(json.out);

    expect(json.code).toBe(ExitCode.FAILED);
    expect(printed.findings.map((item: { action: string }) => item.action)).toEqual(["stored"]);
    expect("comment_ref" in printed.findings[0]).toBe(false);
    expect(printed.comment_plan.line_comments).toEqual([]);
  });

  test("a summary comment that fails leaves its findings stored and ends the review with 1, after the line comments were written", async () => {
    const { dir, base, head } = repo();
    const rules = { summary: FakeGitHub.refusal(500, "Server Error") };
    const result = await run(dir, ["review", "--mr", "12"], { head, base, rules });

    expect(result.code).toBe(ExitCode.FAILED);
    expect(result.out).toContain("comments written: 1 line comments, summary comment not written");
    expect(result.out).toContain("score 95, action inline, comment_ref github:review_comment/9002");

    expect(reported(result.err)).toEqual([
      `kerpeten review: summary comment: it is not known whether GitHub wrote it: gh api failed (exit 1): gh: Server Error (HTTP 500); ${AGAIN}`,
    ]);

    expect(gitHub(result.bin).lineComments.length).toBe(1);
    expect(gitHub(result.bin).conversation).toEqual([]);

    const listed = await run(dir, ["review", "--mr", "12", "--json"], { head, base, rules, judgeScript: JUDGED });
    const printed = JSON.parse(listed.out);

    expect(listed.code).toBe(ExitCode.FAILED);
    expect(printed.findings.map((item: { action: string }) => item.action)).toEqual(["stored"]);
    expect("comment_ref" in printed.findings[0]).toBe(false);
    expect("comment_ref" in printed.comment_plan.summary).toBe(false);
  });

  test("a review GitHub refuses as invalid for a reason that names no line is a failed write: it is sent once, reported with GitHub's text, and the review ends with 1", async () => {
    const { dir, base, head } = repo();
    const rules = { review: FakeGitHub.refusal(422, "Unprocessable Entity", ["Review was flagged as spam"]) };
    const result = await run(dir, ["review", "--mr", "12"], { head, base, rules });

    expect(result.code).toBe(ExitCode.FAILED);
    expect(result.out).toContain("score 95, action stored");

    expect(reported(result.err)).toEqual([
      "kerpeten review: line comment on src/a.ts:2: not written: GitHub refused the request as invalid (HTTP 422): Unprocessable Entity: Review was flagged as spam",
    ]);

    expect(gitHubWrites(result.bin).map((call) => call.args.at(-3))).toEqual([`${PULL}/reviews`, CONVERSATION]);
    expect(gitHub(result.bin).conversation[0]?.body).toContain(UNWRITTEN);
    expect(gitHub(result.bin).conversation[0]?.body).not.toContain("nothing to report");
  });

  test("a summary comment of another account that GitHub does not let this account change is left: a new summary is written, and the next run updates that one", async () => {
    const { dir, base, head } = repo();

    const theirs = {
      id: 77,
      user: { login: "another-account" },
      body: `## Kerpeten review\n\nTheir review.\n\n<!-- kerpeten:summary v1 head=${"c".repeat(40)} -->`,
      created_at: FakeGitHub.NOW,
    };

    const first = await run(dir, ["review", "--mr", "12"], {
      head,
      base,
      conversation: [theirs],
      rules: { foreignComments: [77] },
    });

    expect(first.code).toBe(ExitCode.OK);
    expect(first.out).toContain("comments written: 1 line comments, summary comment github:issue_comment/9003");
    expect(reported(first.err)).toEqual([]);

    expect(first.err).toContain(
      `WARN "summary comment cannot be updated by this account, another one is written" command=review comment=github:issue_comment/77 reason="not written: GitHub does not let the account gh is signed in to github.com with do this (HTTP 403): ${FakeGitHub.NOT_YOURS}"`,
    );

    expect(gitHubWrites(first.bin).map((call) => call.args.slice(2, 3).concat(call.args.at(-3) ?? ""))).toEqual([
      ["POST", `${PULL}/reviews`],
      ["PATCH", "repos/Acme/Shop/issues/comments/77"],
      ["POST", CONVERSATION],
    ]);

    expect(gitHub(first.bin).conversation.map((comment) => [comment.id, comment.user.login])).toEqual([
      [77, "another-account"],
      [9003, "the-user"],
    ]);

    expect(gitHub(first.bin).conversation[0]).toEqual(theirs);

    const before = gitHubWrites(first.bin).length;
    const second = await run(dir, ["review", "--mr", "12"], { bin: first.bin });

    expect(second.code).toBe(ExitCode.OK);
    expect(second.out).toContain("comments written: 0 line comments, summary comment github:issue_comment/9003");

    expect(
      gitHubWrites(first.bin)
        .slice(before)
        .map((call) => call.args.slice(2, 3).concat(call.args.at(-3) ?? "")),
    ).toEqual([
      ["PATCH", "repos/Acme/Shop/issues/comments/77"],
      ["PATCH", "repos/Acme/Shop/issues/comments/9003"],
    ]);

    expect(gitHub(first.bin).conversation.map((comment) => comment.id)).toEqual([77, 9003]);
    expect(gitHub(first.bin).conversation[0]).toEqual(theirs);
    expect(gitHub(first.bin).conversation[1]?.body).toContain("Findings that already had a line comment: 1.");
  });

  test("a pending review of the user stops the line comments with what to do, and the review ends with 1", async () => {
    const { dir, base, head } = repo();
    const result = await run(dir, ["review", "--mr", "12"], { head, base, rules: { pendingReview: true } });

    expect(result.code).toBe(ExitCode.FAILED);

    expect(reported(result.err)).toEqual([
      `kerpeten review: line comment on src/a.ts:2: not written: your account has a review on this pull request that is not submitted yet, and GitHub takes no other review beside it: submit or delete that review on the page of the pull request and run again (GitHub answered: Unprocessable Entity: ${FakeGitHub.PENDING})`,
    ]);
  });
});

describe("kerpeten review --mr: a review that writes nothing at all", () => {
  /** A summary comment of an earlier run that is on the pull request at `head`. */
  function goodSummary(head: string): FakeIssueComment {
    return {
      id: 77,
      user: { login: FakeGitHub.USER },
      body: `## Kerpeten review\n\nA good summary of an earlier run.\n\n<!-- kerpeten:summary v1 head=${head} -->`,
      created_at: FakeGitHub.NOW,
    };
  }

  test("when the judge could not judge any finding, no comment is written and the summary that is there stays: one line says so, the findings are printed, and the review ends with 1", async () => {
    const { dir, base, head } = repo();
    const conversation = [goodSummary(head)];
    const result = await run(dir, ["review", "--mr", "12"], { head, base, conversation, judgeScript: [] });

    expect(result.code).toBe(ExitCode.FAILED);

    expect(reported(result.err)).toEqual([
      "kerpeten review: no comment was written: the judge could not judge the 1 finding; the output shows it with its judge_error",
    ]);

    expect(result.out).toContain("findings: 1\n- src/a.ts:2-2 [bug] Division by zero\n  judge_error ");
    expect(result.out).toContain(", action stored");
    expect(result.out).not.toContain("comment plan:");
    expect(result.out).not.toContain("comments written");
    expect(gitHub(result.bin).calls.map((call) => call.args)).toEqual(READS);
    expect(gitHub(result.bin).conversation).toEqual(conversation);

    const dry = await run(dir, ["review", "--dry-run", "--mr", "12"], { head, base, conversation, judgeScript: [] });

    expect(dry.code).toBe(ExitCode.OK);
    expect(reported(dry.err)).toEqual([]);
    expect(dry.out).toContain("comment plan: 0 line comments, 0 in the summary, 0 already written, 1 stored");
    expect(dry.out).toContain("- src/a.ts:2-2 [bug] Division by zero\n  judge_error ");
    expect(gitHubWrites(dry.bin)).toEqual([]);
  });

  test("when the judge could not judge one finding and refuted the other, the summary is written and counts the one it could not judge: it does not say that nothing was found", async () => {
    const { dir, base } = repo();

    write(dir, { ".kerpeten.yml": `${CONFIG}limits: { max_judge_parallel: 1 }\n` });

    const head = commit(dir, "judge one finding at a time");
    const findings = [finding, { ...finding, title: "Never judged" }];
    const script = [{ text: "done" }, { text: JSON.stringify({ findings }) }];
    const judgeScript = [{ text: "done" }, { text: JSON.stringify({ ...labels, verdict: "refuted" }) }];
    const result = await run(dir, ["review", "--mr", "12"], { head, base, script, judgeScript });

    expect(result.code).toBe(ExitCode.OK);
    expect(reported(result.err)).toEqual([]);
    expect(result.out).toContain("comment plan: 0 line comments, 0 in the summary, 0 already written, 2 stored");
    expect(result.out).toContain("comments written: 0 line comments, summary comment github:issue_comment/9001");
    expect(result.out).toContain("- src/a.ts:2-2 [bug] Never judged\n  judge_error ");

    expect(gitHub(result.bin).conversation.map((comment) => comment.body)).toEqual([
      [
        "## Kerpeten review",
        `Reviewed commit ${head}. Line comments in this run: 0.`,
        "Findings that could not be checked, so they are not written here: 1. The output of the review run lists them.",
        `<!-- kerpeten:summary v1 head=${head} -->`,
      ].join("\n\n"),
    ]);
  });

  test("a pull request that got a new commit during the review gets no comment: it is read once more before the write, one line says so, and the review ends with 1", async () => {
    const { dir, base, head } = repo();
    const moved = "d".repeat(40);
    const conversation = [goodSummary(head)];
    const result = await run(dir, ["review", "--mr", "12"], { head, base, conversation, rules: { movesTo: moved } });

    expect(result.code).toBe(ExitCode.FAILED);

    expect(reported(result.err)).toEqual([
      `kerpeten review: no comment was written: pull request 12 moved to commit ${moved} during the review, which is of commit ${head}; run again to review the new commit`,
    ]);

    expect(result.out.split("\n").slice(3, 7)).toEqual([
      "comment plan: 0 line comments, 0 in the summary, 0 already written, 1 stored",
      "comments written: 0 line comments, summary comment not written",
      "- src/a.ts:2-2 [bug] Division by zero",
      "  verdict verified, priority P0, nature critical, fix_effort easy, score 95, action stored",
    ]);

    expect(result.out).not.toContain("comment_ref");
    expect(gitHub(result.bin).calls.map((call) => call.args)).toEqual([...READS, [...GH_READ, PULL]]);
    expect(gitHub(result.bin).conversation).toEqual(conversation);
    expect(gitHub(result.bin).lineComments).toEqual([]);
  });
});

describe("kerpeten review: what is never written", () => {
  test("--dry-run --mr writes nothing: gh only reads, and no finding has a comment_ref", async () => {
    const { dir, base, head } = repo();
    const result = await run(dir, ["review", "--dry-run", "--mr", "12"], { head, base });

    expect(result.code).toBe(ExitCode.OK);

    expect(result.out.split("\n").slice(2, 6)).toEqual([
      "findings: 1",
      "comment plan: 1 line comments, 0 in the summary, 0 already written, 0 stored",
      "- src/a.ts:2-2 [bug] Division by zero",
      "  verdict verified, priority P0, nature critical, fix_effort easy, score 95, action inline",
    ]);

    const github = gitHub(result.bin);

    expect(github.calls.map((call) => call.args)).toEqual(READS);
    expect(gitHubWrites(result.bin)).toEqual([]);
    expect([github.reviews, github.lineComments, github.conversation]).toEqual([[], [], []]);
    expect(result.out).not.toContain("comment_ref");
    expect(result.out).not.toContain("comments written");
    expect(result.err).not.toContain("comments written");

    const json = await run(dir, ["review", "--dry-run", "--mr", "12", "--json"], { head, base });

    expect(json.out).not.toContain("comment_ref");
    expect(gitHubWrites(json.bin)).toEqual([]);
  });

  test("a pull request at another commit than HEAD stops the review before anything is written or a model is called", async () => {
    const { dir, base } = repo();
    const result = await run(dir, ["review", "--mr", "12"], { head: "c".repeat(40), base });

    expect(result.code).toBe(ExitCode.USAGE);
    expect(result.calls.length).toBe(0);
    expect(gitHubWrites(result.bin)).toEqual([]);
  });

  test("a merge request on GitLab is refused without --dry-run, before glab or a model is called, and says to use --dry-run", async () => {
    const { dir } = repo(GITLAB_ORIGIN);
    const result = await run(dir, ["review", "--mr", "12"]);

    expect(result.code).toBe(ExitCode.USAGE);

    expect(reported(result.err)).toEqual([
      "kerpeten review: --mr 12: Kerpeten cannot write comments to a merge request of this platform yet, only to a pull request on GitHub: run with --dry-run to see the comments the review would write",
    ]);

    expect(result.out).toBe("");
    expect(result.calls.length).toBe(0);
    expect(glabCalls(result.bin)).toEqual([]);
    expect(gitHub(result.bin).calls).toEqual([]);
  });

  test("a review without --dry-run and without --mr is a usage error that says what to do, before anything is read", async () => {
    const { dir } = repo();
    const result = await run(dir, ["review"]);

    expect(result.code).toBe(ExitCode.USAGE);

    expect(result.err).toBe(
      "kerpeten review: a review without --dry-run writes its comments to a pull request, and this one names none, so it has nowhere to write: give --mr <n> to review pull request n and write to it, or --dry-run to only print the findings",
    );

    expect(result.calls.length).toBe(0);
    expect(gitHub(result.bin).calls).toEqual([]);
  });
});
