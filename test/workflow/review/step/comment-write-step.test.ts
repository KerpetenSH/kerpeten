import { afterEach, describe, expect, test } from "bun:test";
import type { Run } from "@kerpetensh/harness-kit";
import { PlatformChoice } from "../../../../src/capability/platform/PlatformChoice.ts";
import { PlatformError } from "../../../../src/capability/platform/PlatformError.ts";
import type {
  LineCommentOutcome,
  MergeRequest,
  SummaryWrite,
} from "../../../../src/capability/platform/types/platform.ts";
import type { JudgedFinding } from "../../../../src/harnesses/review/types/review.ts";
import { CommentMarker } from "../../../../src/layer/comment/CommentMarker.ts";
import type { WrittenComment } from "../../../../src/layer/comment/types/comment.ts";
import { CommentPlanStep } from "../../../../src/workflow/review/step/CommentPlanStep.ts";
import { CommentWriteStep } from "../../../../src/workflow/review/step/CommentWriteStep.ts";
import type { ReviewedMergeRequest } from "../../../../src/workflow/review/types/review-workflow.ts";
import { runStep } from "../../../app/app-utils.ts";
import { capturingLogger } from "../../../harnesses/harnesses-utils.ts";
import { GivenPlatformChoice } from "../GivenPlatformChoice.ts";
import { RecordingWriter } from "../RecordingWriter.ts";
import { candidates, cleanDirs, good, repoWithBranch, reviewComponent } from "../review-utils.ts";

afterEach(cleanDirs);

const labelled = {
  ...good,
  file: "src/a.ts",
  verdict: "verified",
  priority: "P0",
  nature: "critical",
  fix_effort: "easy",
  rationale: "y is never checked",
} as const;

const onLine2: JudgedFinding = { ...labelled, title: "On line 2", score: 95, action: "inline" };

const onLine1: JudgedFinding = {
  ...labelled,
  title: "On line 1",
  start_line: 1,
  end_line: 1,
  score: 90,
  action: "inline",
};

const listed: JudgedFinding = {
  ...labelled,
  title: "Listed",
  start_line: 1,
  end_line: 2,
  score: 40,
  action: "summary",
};

const low: JudgedFinding = { ...labelled, title: "Low", score: 10, action: "stored" };

const SUMMARY_REF = "github:issue_comment/900";

/**
 * The state after the comment plan flow step of a review of pull request 12 that is no dry run, with `findings` and
 * with the comments of Kerpeten that are `written` on it; `log` gets its log lines.
 */
async function planned(
  findings: readonly JudgedFinding[],
  written: (head: string) => readonly WrittenComment[] = () => [],
) {
  const { repo, head } = repoWithBranch();
  const captured = capturingLogger();

  const mergeRequest: ReviewedMergeRequest = {
    kind: "github",
    host: "github.com",
    projectId: "4242",
    number: 12,
    title: "Add div",
    description: "",
    state: "open",
    headSha: head,
    baseSha: "b".repeat(40),
    baseRef: "main",
    tenant: "default",
  };

  const scored = {
    ...(await candidates(repo, [good])),
    dryRun: false,
    log: captured.log,
    mergeRequest,
    written: written(head),
    judged: undefined,
    findings: [...findings],
  };

  const state = { ...scored, ...(await reviewComponent(CommentPlanStep)).execute(scored) };

  return { state, head, lines: captured.lines };
}

/** Runs the comment write flow step on `state` with a writer that answers as `lines` and `summary` say. */
async function write(
  state: Awaited<ReturnType<typeof planned>>["state"],
  lines: Readonly<Record<number, LineCommentOutcome>> = {},
  summary?: SummaryWrite,
  problems: readonly string[] = [],
  foreign: readonly string[] = [],
  current: MergeRequest | Error | undefined = state.mergeRequest,
) {
  const writer = new RecordingWriter(lines, summary, problems, foreign);
  const choice = new GivenPlatformChoice(writer, current);

  const { commentWrite } = await runStep(await reviewComponent(CommentWriteStep), state, {
    give: (run) => run.give(PlatformChoice, choice),
  });

  return { commentWrite, calls: writer.calls, reads: choice.reads };
}

describe("comment write flow step", () => {
  test("writes the line comments first, at the head commit and each with its marker, and the summary last", async () => {
    const { state, head } = await planned([onLine1, listed, onLine2, low]);
    const { commentWrite, calls } = await write(state);
    const plan = state.commentPlan;

    expect(calls.map((call) => call.kind)).toEqual(["lines", "summary"]);

    expect(calls[0]).toEqual({
      kind: "lines",
      number: 12,
      headSha: head,
      comments: [
        {
          file: "src/a.ts",
          startLine: 2,
          endLine: 2,
          body: plan?.lineComments[0]?.body ?? "",
          marker: CommentMarker.finding(head, "src/a.ts", 2, 2).line(),
        },
        {
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          body: plan?.lineComments[1]?.body ?? "",
          marker: CommentMarker.finding(head, "src/a.ts", 1, 1).line(),
        },
      ],
    });

    expect(calls[1]).toEqual({ kind: "summary", number: 12, body: plan?.summary.body ?? "", existing: undefined });

    expect(commentWrite?.failures).toEqual([]);

    expect(
      commentWrite?.plan?.findings.map((finding) => [
        finding.title,
        finding.action,
        "comment_ref" in finding ? finding.comment_ref : undefined,
      ]),
    ).toEqual([
      ["On line 1", "inline", "github:review_comment/1"],
      ["Listed", "summary", SUMMARY_REF],
      ["On line 2", "inline", "github:review_comment/2"],
      ["Low", "stored", undefined],
    ]);

    expect(commentWrite?.plan?.lineComments.map((comment) => comment.ref)).toEqual([
      "github:review_comment/2",
      "github:review_comment/1",
    ]);

    expect(commentWrite?.plan?.summary.ref).toBe(SUMMARY_REF);
  });

  test("a refused line comment sends its finding to the summary that is written, and is no failure", async () => {
    const { state, lines } = await planned([onLine1, onLine2]);
    const refused = { kind: "refused", reason: "Line could not be resolved" } as const;
    const { commentWrite, calls } = await write(state, { 1: refused });
    const summary = calls[1]?.kind === "summary" ? calls[1].body : "";

    expect(state.commentPlan?.summary.body).toContain("Line comments in this run: 2.");
    expect(state.commentPlan?.summary.body).not.toContain("### On line 1");
    expect(summary).toContain("Line comments in this run: 1.");
    expect(summary).toContain("### On line 1\n`src/a.ts:1` · bug · P0");
    expect(summary).toBe(commentWrite?.plan?.summary.body ?? "");

    expect(
      commentWrite?.plan?.findings.map((finding) => [
        finding.action,
        "comment_ref" in finding ? finding.comment_ref : undefined,
      ]),
    ).toEqual([
      ["summary", SUMMARY_REF],
      ["inline", "github:review_comment/2"],
    ]);

    expect(commentWrite?.failures).toEqual([]);

    expect(lines).toContainEqual({
      level: "warn",
      message: "line comment refused, its finding goes to the summary",
      fields: { place: "src/a.ts:1", reason: "Line could not be resolved" },
    });
  });

  test("a failed line comment leaves its finding stored, is logged and gives one line, and the others and the summary are written", async () => {
    const { state, lines } = await planned([onLine1, onLine2, listed]);
    const failed = { kind: "failed", message: "not written: gh api failed (exit 1): HTTP 502" } as const;
    const { commentWrite, calls } = await write(state, { 2: failed });

    expect(calls.map((call) => call.kind)).toEqual(["lines", "summary"]);

    expect(
      commentWrite?.plan?.findings.map((finding) => [
        finding.title,
        finding.action,
        "comment_ref" in finding ? finding.comment_ref : undefined,
      ]),
    ).toEqual([
      ["On line 1", "inline", "github:review_comment/1"],
      ["On line 2", "stored", undefined],
      ["Listed", "summary", SUMMARY_REF],
    ]);

    expect(commentWrite?.failures).toEqual([
      "line comment on src/a.ts:2: not written: gh api failed (exit 1): HTTP 502",
    ]);

    expect(commentWrite?.plan?.summary.body).toContain("Line comments in this run: 1.");
    expect(commentWrite?.plan?.summary.body).not.toContain("### On line 2");

    expect(lines).toContainEqual({
      level: "error",
      message: "line comment failed, its finding is stored",
      fields: { place: "src/a.ts:2", error: "not written: gh api failed (exit 1): HTTP 502" },
    });
  });

  test("a summary that cannot be written leaves its findings stored and gives one line; the line comments stay written", async () => {
    const { state, lines } = await planned([onLine2, listed]);
    const failed = { kind: "failed", message: "not written: gh api failed (exit 1): HTTP 500" } as const;
    const { commentWrite } = await write(state, {}, failed);

    expect(
      commentWrite?.plan?.findings.map((finding) => [
        finding.action,
        "comment_ref" in finding ? finding.comment_ref : undefined,
      ]),
    ).toEqual([
      ["inline", "github:review_comment/2"],
      ["stored", undefined],
    ]);

    expect(commentWrite?.plan?.summary.ref).toBeUndefined();
    expect(commentWrite?.failures).toEqual(["summary comment: not written: gh api failed (exit 1): HTTP 500"]);

    expect(lines).toContainEqual({
      level: "error",
      message: "summary comment failed, its findings are stored",
      fields: { error: "not written: gh api failed (exit 1): HTTP 500" },
    });

    expect(lines).toContainEqual({
      level: "info",
      message: "comments written",
      fields: { line_comments: 1, refused: 0, failed: 0, summary: "failed", summary_ref: undefined },
    });
  });

  /** Comments that are on the pull request of `head`: copies of the summary's marker, and two summary comments, 77 and 78. */
  function twoSummaries(head: string): WrittenComment[] {
    const other = "c".repeat(40);

    return [
      { kind: "line", mark: CommentMarker.finding(other, "src/a.ts", 2, 2).mark, ref: "github:review_comment/5" },
      { kind: "general", mark: CommentMarker.summary(head).mark, ref: "github:review/6" },
      { kind: "line", mark: CommentMarker.summary(head).mark, ref: "github:review_comment/7" },
      { kind: "general", mark: CommentMarker.summary(other).mark, ref: "github:issue_comment/77" },
      { kind: "general", mark: CommentMarker.summary(head).mark, ref: "github:issue_comment/78" },
    ];
  }

  test("the summary comment of Kerpeten that is on the merge request is updated: the first comment of the conversation with the summary's marker", async () => {
    const { state, lines } = await planned([onLine2], twoSummaries);
    const { commentWrite, calls } = await write(state);

    expect(calls.slice(1)).toMatchObject([{ kind: "summary", existing: "github:issue_comment/77" }]);
    expect(commentWrite?.plan?.summary.ref).toBe("github:issue_comment/77");
    expect(commentWrite?.failures).toEqual([]);

    expect(lines).toContainEqual({
      level: "warn",
      message: "more than one summary comment is on the merge request",
      fields: { updated: "github:issue_comment/77", all: "github:issue_comment/77,github:issue_comment/78" },
    });

    expect(lines).toContainEqual({
      level: "info",
      message: "comments written",
      fields: { line_comments: 1, refused: 0, failed: 0, summary: "updated", summary_ref: "github:issue_comment/77" },
    });
  });

  test("a summary comment this account cannot change is left, with a warning, and the next one is updated", async () => {
    const { state, lines } = await planned([onLine2, listed], twoSummaries);
    const { commentWrite, calls } = await write(state, {}, undefined, [], ["github:issue_comment/77"]);

    expect(calls.slice(1)).toMatchObject([
      { kind: "summary", existing: "github:issue_comment/77" },
      { kind: "summary", existing: "github:issue_comment/78" },
    ]);

    expect(commentWrite?.plan?.summary.ref).toBe("github:issue_comment/78");
    expect(commentWrite?.failures).toEqual([]);

    expect(
      commentWrite?.plan?.findings.map((finding) => ("comment_ref" in finding ? finding.comment_ref : undefined)),
    ).toEqual(["github:review_comment/2", "github:issue_comment/78"]);

    expect(lines).toContainEqual({
      level: "warn",
      message: "summary comment cannot be updated by this account, another one is written",
      fields: {
        comment: "github:issue_comment/77",
        reason: "not written: the platform does not let this account change github:issue_comment/77",
      },
    });
  });

  test("when this account can change none of the summary comments, a new one is made, and the summary is written", async () => {
    const { state, lines } = await planned([onLine2], twoSummaries);
    const foreign = ["github:issue_comment/77", "github:issue_comment/78"];
    const { commentWrite, calls } = await write(state, {}, undefined, [], foreign);

    expect(calls.slice(1)).toMatchObject([
      { kind: "summary", existing: "github:issue_comment/77" },
      { kind: "summary", existing: "github:issue_comment/78" },
      { kind: "summary", existing: undefined },
    ]);

    expect(commentWrite?.plan?.summary.ref).toBe(SUMMARY_REF);
    expect(commentWrite?.failures).toEqual([]);
    expect(lines.filter((line) => line.message.startsWith("summary comment cannot be updated")).length).toBe(2);

    expect(lines).toContainEqual({
      level: "info",
      message: "comments written",
      fields: { line_comments: 1, refused: 0, failed: 0, summary: "created", summary_ref: SUMMARY_REF },
    });
  });

  test("an update that fails for another reason is not tried on another comment and makes no new one: the summary failed", async () => {
    const { state } = await planned([onLine2, listed], twoSummaries);
    const failed = { kind: "failed", message: "it is not known whether GitHub wrote it: gh api failed" } as const;
    const { commentWrite, calls } = await write(state, {}, failed);

    expect(calls.slice(1)).toMatchObject([{ kind: "summary", existing: "github:issue_comment/77" }]);
    expect(commentWrite?.failures).toEqual(["summary comment: it is not known whether GitHub wrote it: gh api failed"]);
    expect(commentWrite?.plan?.findings.map((finding) => finding.action)).toEqual(["inline", "stored"]);
  });

  /** Findings of the summary with long texts: `count` of them fill most of the room of one summary comment. */
  function longListed(count: number): JudgedFinding[] {
    return Array.from({ length: count }, (_, index) => ({
      ...labelled,
      title: `Long ${index + 1}`,
      body: `Long ${index + 1} ${"x".repeat(9_000)}`,
      start_line: index + 10,
      end_line: index + 10,
      score: 80 - index,
      action: "summary" as const,
    }));
  }

  test("a refused line finding that the summary has no room for is written nowhere: that is a failure with a line of its own", async () => {
    const lowest: JudgedFinding = { ...onLine2, body: `Refused ${"x".repeat(9_000)}`, score: 60 };
    const { state, lines } = await planned([lowest, ...longListed(6)]);
    const refused = { kind: "refused", reason: "Line could not be resolved" } as const;

    expect(state.commentPlan?.summary.omitted).toBe(0);

    const { commentWrite } = await write(state, { 2: refused });

    expect(commentWrite?.plan?.summary.omitted).toBe(1);
    expect(commentWrite?.plan?.summary.ref).toBe(SUMMARY_REF);
    expect(commentWrite?.plan?.summary.body).not.toContain("### On line 2");

    expect(commentWrite?.plan?.findings.map((finding) => finding.action)).toEqual([
      "stored",
      "summary",
      "summary",
      "summary",
      "summary",
      "summary",
      "summary",
    ]);

    expect(commentWrite?.failures).toEqual([
      "finding on src/a.ts:2: not written: the platform refused a comment on its lines, and the summary comment is too long to hold it",
    ]);

    expect(lines).toContainEqual({
      level: "error",
      message: "finding is written nowhere, it is stored",
      fields: {
        place: "src/a.ts:2",
        error:
          "not written: the platform refused a comment on its lines, and the summary comment is too long to hold it",
      },
    });
  });

  test("a finding the planned summary showed, pushed out by a refused line finding that joined it, is a failure too", async () => {
    const highest: JudgedFinding = { ...onLine2, body: `Refused ${"x".repeat(9_000)}`, score: 99 };
    const { state } = await planned([...longListed(6), highest]);
    const refused = { kind: "refused", reason: "Line could not be resolved" } as const;
    const { commentWrite } = await write(state, { 2: refused });

    expect(commentWrite?.plan?.summary.body).toContain("### On line 2");
    expect(commentWrite?.plan?.summary.body).not.toContain("### Long 6");

    expect(
      commentWrite?.plan?.findings.map((finding) => ("comment_ref" in finding ? finding.comment_ref : finding.action)),
    ).toEqual([SUMMARY_REF, SUMMARY_REF, SUMMARY_REF, SUMMARY_REF, SUMMARY_REF, "stored", SUMMARY_REF]);

    expect(commentWrite?.failures).toEqual([
      "finding on src/a.ts:15: not written: the summary comment is too long to hold it",
    ]);
  });

  test("a finding the plan itself left out of the summary for its length is stored and is no failure", async () => {
    const { state, lines } = await planned([onLine2, ...longListed(8)]);

    expect(state.commentPlan?.summary.omitted).toBe(2);

    const { commentWrite } = await write(state);

    expect(commentWrite?.failures).toEqual([]);

    expect(commentWrite?.plan?.findings.map((finding) => finding.action)).toEqual([
      "inline",
      "summary",
      "summary",
      "summary",
      "summary",
      "summary",
      "summary",
      "stored",
      "stored",
    ]);

    expect(lines).toContainEqual({
      level: "warn",
      message: "summary comment does not show every finding, the ones left out are stored",
      fields: { omitted: 2 },
    });
  });

  test("a review without findings writes no line comment and still writes the summary", async () => {
    const { state } = await planned([]);
    const { commentWrite, calls } = await write(state);

    expect(calls[0]).toMatchObject({ kind: "lines", comments: [] });
    expect(calls[1]?.kind === "summary" ? calls[1].body : "").toContain("The review found nothing to report.");
    expect(commentWrite?.plan?.summary.ref).toBe(SUMMARY_REF);
    expect(commentWrite?.failures).toEqual([]);
  });

  test("the pull request is read once more right before the write, and a head that is still the reviewed commit lets the write go on", async () => {
    const { state } = await planned([onLine2]);
    const { calls, reads, commentWrite } = await write(state);

    expect(reads).toBe(1);
    expect(calls.map((call) => call.kind)).toEqual(["lines", "summary"]);
    expect(commentWrite?.failures).toEqual([]);
  });

  test("a pull request that moved to another commit during the review gets no comment: one line says so, and the plan stays unwritten", async () => {
    const { state, head, lines } = await planned([onLine2, listed]);
    const moved = { ...state.mergeRequest, headSha: "d".repeat(40) };
    const { commentWrite, calls } = await write(state, {}, undefined, [], [], moved);
    const line = `no comment was written: pull request 12 moved to commit ${"d".repeat(40)} during the review, which is of commit ${head}; run again to review the new commit`;

    expect(calls).toEqual([]);
    expect(commentWrite?.failures).toEqual([line]);
    expect(commentWrite?.plan?.findings.map((finding) => finding.action)).toEqual(["stored", "stored"]);
    expect(commentWrite?.plan?.findings.filter((finding) => "comment_ref" in finding)).toEqual([]);
    expect(commentWrite?.plan?.lineComments).toEqual([]);
    expect(commentWrite?.plan?.summary.ref).toBeUndefined();
    expect(commentWrite?.plan?.counts).toEqual({ inline: 0, summary: 0, duplicate: 0, stored: 2 });
    expect(lines).toContainEqual({ level: "error", message: "no comment written", fields: { error: line } });
  });

  test("a pull request that cannot be read again before the write gets no comment either", async () => {
    const { state } = await planned([onLine2]);
    const failed = new PlatformError("failed", "gh api failed (exit 1): gh: Server Error (HTTP 502)");
    const { commentWrite, calls } = await write(state, {}, undefined, [], [], failed);

    expect(calls).toEqual([]);

    expect(commentWrite?.failures).toEqual([
      "no comment was written: pull request 12 could not be read again before the write, so it is not known whether it is still at the reviewed commit: gh api failed (exit 1): gh: Server Error (HTTP 502)",
    ]);
  });

  test("a review whose judge could not judge any finding has no plan, and a run that was to write says in one line that nothing was written", async () => {
    const unjudged = (title: string): JudgedFinding => ({
      ...good,
      file: "src/a.ts",
      title,
      judge_error: "model_error: overloaded",
      action: "stored",
    });

    const { state, lines } = await planned([unjudged("One"), unjudged("Two"), unjudged("Three")]);

    expect(state.commentPlan).toBeUndefined();

    const { commentWrite, calls, reads } = await write(state);

    const line =
      "no comment was written: the judge could not judge any of the 3 findings; the output shows them with their judge_error";

    expect(calls).toEqual([]);
    expect(reads).toBe(0);
    expect(commentWrite).toEqual({ plan: undefined, failures: [line] });
    expect(lines).toContainEqual({ level: "error", message: "no comment written", fields: { error: line } });

    const step = await reviewComponent(CommentWriteStep);
    const give = { give: (run: Run) => void run.give(PlatformChoice, new GivenPlatformChoice(new RecordingWriter())) };

    expect(await runStep(step, { ...state, dryRun: true }, give)).toEqual({ commentWrite: undefined });
  });

  test("what the writer says beside the outcomes is logged as a warning", async () => {
    const { state, lines } = await planned([onLine2]);

    await write(state, {}, undefined, ["1 of the 1 line comments of review 9 are written, but their ids are unknown"]);

    expect(lines).toContainEqual({
      level: "warn",
      message: "line comments written",
      fields: { problem: "1 of the 1 line comments of review 9 are written, but their ids are unknown" },
    });
  });

  test("a dry run, a review of no merge request and a review without a plan write nothing and ask for no writer", async () => {
    const { state } = await planned([onLine2]);
    const step = await reviewComponent(CommentWriteStep);

    const refusing = { give: (run: Run) => void run.give(PlatformChoice, new GivenPlatformChoice()) };

    for (const quiet of [
      { ...state, dryRun: true },
      { ...state, mergeRequest: undefined, written: undefined },
      { ...state, commentPlan: undefined },
    ]) {
      expect(await runStep(step, quiet, refusing)).toEqual({ commentWrite: undefined });
    }

    await expect(runStep(step, state, refusing)).rejects.toThrow("no writer for the platform github");
  });
});
