import { afterEach, describe, expect, test } from "bun:test";
import type { JudgeStepResult } from "../../../../src/harnesses/judge/types/judge.ts";
import type { JudgedFinding } from "../../../../src/harnesses/review/types/review.ts";
import { CommentMarker } from "../../../../src/layer/comment/CommentMarker.ts";
import type { WrittenComment } from "../../../../src/layer/comment/types/comment.ts";
import { CommentPlanStep } from "../../../../src/workflow/review/step/CommentPlanStep.ts";
import { candidates, cleanDirs, config, good, repoWithBranch, reviewComponent, reviewerRun } from "../review-utils.ts";

afterEach(cleanDirs);

const scored: JudgedFinding = {
  ...good,
  file: "src/a.ts",
  verdict: "verified",
  priority: "P0",
  nature: "critical",
  fix_effort: "easy",
  rationale: "y is never checked",
  score: 95,
  action: "inline",
};

/** The state after the score flow step of a review whose one finding the scorer gave a line comment. */
async function scoredState(repo: string, written: readonly WrittenComment[] | undefined) {
  return { ...(await candidates(repo, [good])), written, judged: undefined, findings: [scored] };
}

describe("comment plan flow step", () => {
  test("a review of no merge request has no comment plan", async () => {
    const { repo } = repoWithBranch();
    const step = await reviewComponent(CommentPlanStep);

    expect(step.execute(await scoredState(repo, undefined))).toEqual({ commentPlan: undefined });
  });

  test("a review of a merge request plans its comments from the diff, the commit and the configuration", async () => {
    const { repo, head } = repoWithBranch();
    const step = await reviewComponent(CommentPlanStep);
    const { commentPlan } = step.execute(await scoredState(repo, []));

    expect(commentPlan?.findings).toEqual([scored]);
    expect(commentPlan?.counts).toEqual({ inline: 1, summary: 0, duplicate: 0, stored: 0 });

    expect(commentPlan?.lineComments.map(({ file, startLine, endLine }) => ({ file, startLine, endLine }))).toEqual([
      { file: "src/a.ts", startLine: 2, endLine: 2 },
    ]);

    expect(CommentMarker.read(commentPlan?.lineComments[0]?.body ?? "")?.mark).toEqual(
      CommentMarker.finding(head, "src/a.ts", 2, 2).mark,
    );

    expect(CommentMarker.read(commentPlan?.summary.body ?? "")?.mark).toEqual(CommentMarker.summary(head).mark);
  });

  test("the limit and the language of the configuration and the comments already written reach the plan", async () => {
    const { repo, head } = repoWithBranch();
    const step = await reviewComponent(CommentPlanStep);
    const state = await scoredState(repo, []);

    const limited = step.execute({
      ...state,
      config: config("limits: { max_inline_comments: 0 }\ncomment_language: tr"),
    });

    expect(limited.commentPlan?.findings.map((finding) => finding.action)).toEqual(["summary"]);
    expect(limited.commentPlan?.summary.body).toStartWith("## Kerpeten incelemesi\n");

    const mark = CommentMarker.finding(head, "src/a.ts", 2, 2).mark;
    const written = [{ kind: "line" as const, mark, ref: "github:review_comment/7" }];
    const again = step.execute({ ...state, written });

    expect(again.commentPlan?.findings.map((finding) => finding.action)).toEqual(["suppressed_duplicate"]);
  });

  test("a review that ended early says so in the summary, with the reviewer's reason before the judge's", async () => {
    const { repo } = repoWithBranch();
    const step = await reviewComponent(CommentPlanStep);
    const state = await scoredState(repo, []);

    const judged: JudgeStepResult = {
      outcomes: [],
      usage: { role: "judge", provider: "anthropic", model: "m", input_tokens: 1, output_tokens: 1, calls: 1 },
      toolCalls: 0,
      unknownUsageCalls: 0,
      partialReason: "time_budget",
    };

    expect(step.execute({ ...state, judged }).commentPlan?.summary.body).toContain(
      "**Partial review:** the review stopped early (`time_budget`)",
    );

    const review = { ...reviewerRun([good]), partialReason: "tool_call_budget" as const };

    expect(step.execute({ ...state, judged, review }).commentPlan?.summary.body).toContain(
      "**Partial review:** the review stopped early (`tool_call_budget`)",
    );

    expect(step.execute(state).commentPlan?.summary.body).not.toContain("Partial review");
  });

  test("a review that is to write and whose judge could not judge any of its findings has no comment plan; a dry run of it and a review with a judged finding have, and the summary counts the others", async () => {
    const { repo } = repoWithBranch();
    const step = await reviewComponent(CommentPlanStep);
    const state = await scoredState(repo, []);
    const { verdict: _v, priority: _p, nature: _n, fix_effort: _e, rationale: _r, score: _s, ...reviewed } = scored;
    const unjudged: JudgedFinding = { ...reviewed, judge_error: "model_error: overloaded", action: "stored" };

    const none = [unjudged, { ...unjudged, title: "Other" }];

    expect(step.execute({ ...state, dryRun: false, findings: none })).toEqual({ commentPlan: undefined });

    const dry = step.execute({ ...state, dryRun: true, findings: none }).commentPlan;

    expect(dry?.counts).toEqual({ inline: 0, summary: 0, duplicate: 0, stored: 2 });
    expect(dry?.summary.body).not.toContain("nothing to report");
    expect(dry?.summary.body).toContain("Findings that could not be checked, so they are not written here: 2.");

    const mixed = step.execute({
      ...state,
      dryRun: false,
      findings: [unjudged, scored, { ...unjudged, title: "Other" }],
    });

    expect(mixed.commentPlan?.findings.map((finding) => finding.action)).toEqual(["stored", "inline", "stored"]);

    expect(mixed.commentPlan?.summary.body).toContain(
      "Findings that could not be checked, so they are not written here: 2. The output of the review run lists them.",
    );

    expect(step.execute({ ...state, findings: [] }).commentPlan?.summary.body).toContain(
      "The review found nothing to report.",
    );
  });

  test("a review whose reviewer gave no result has no comment plan", async () => {
    const { repo } = repoWithBranch();
    const step = await reviewComponent(CommentPlanStep);
    const state = await scoredState(repo, []);
    const review = { ...reviewerRun([]), completed: false, error: "no structured result" };

    expect(step.execute({ ...state, review, findings: [] })).toEqual({ commentPlan: undefined });
  });
});
