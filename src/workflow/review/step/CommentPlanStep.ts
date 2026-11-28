import { Inject } from "@asenajs/ioc";
import { type After, FlowStep, FlowStepBase } from "@kerpetensh/harness-kit";
import { CommentableLines } from "../../../layer/comment/CommentableLines.ts";
import { CommentPlanner } from "../../../layer/comment/CommentPlanner.ts";
import type { ScoreStep } from "./ScoreStep.ts";

/**
 * Plans the comments of a review of a merge request: gives every finding the action a posted review would take and
 * writes the texts of the line comments and of the summary comment. It writes nothing to the merge request: the
 * comment write flow step does that, after it. A review of no merge request has no plan, and neither has one whose
 * reviewer gave no result, because there is nothing true to say about it. The same holds for a review the ChatGPT
 * plan stopped, in the reviewer or in the judge: the command ends such a review with an error and prints no finding,
 * so no comment is planned from what it has, and none is written.
 */
@FlowStep({
  name: "comment-plan",
  description:
    "Plans the comments of a review of a merge request: the action of every finding and the texts of the line comments and the summary comment, without writing them; a review without a merge request, one whose reviewer gave no result and one the ChatGPT plan stopped have no plan.",
})
export class CommentPlanStep extends FlowStepBase {
  @Inject(CommentPlanner)
  private readonly planner!: CommentPlanner;

  public execute(state: After<typeof ScoreStep>) {
    const { written, change, config, review, judged, log } = state;

    const stopped = state.plan?.adapter.failure !== undefined;

    if (written === undefined || !review.completed || stopped) return { commentPlan: undefined };

    const partialReason = review.partialReason ?? judged?.partialReason;

    const commentPlan = this.planner.plan({
      findings: state.findings,
      lines: CommentableLines.of(change.patch),
      written,
      headSha: change.headSha,
      maxInlineComments: config.limits.max_inline_comments,
      language: config.comment_language,
      ...(partialReason === undefined ? {} : { partialReason }),
    });

    const cut = commentPlan.lineComments.filter((comment) => comment.cut).length;

    log.info("comment plan", { ...commentPlan.counts });

    if (cut > 0) log.warn("line comments cut to the comment limit", { comments: cut });

    if (commentPlan.summary.omitted > 0) {
      log.warn("summary comment does not show every finding", { omitted: commentPlan.summary.omitted });
    }

    return { commentPlan };
  }
}
