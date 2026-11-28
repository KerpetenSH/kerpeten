import { Inject } from "@asenajs/ioc";
import { type After, FlowStep, FlowStepBase } from "@kerpetensh/harness-kit";
import { CommentableLines } from "../../../layer/comment/CommentableLines.ts";
import { CommentPlanner } from "../../../layer/comment/CommentPlanner.ts";
import { judgedNothing } from "../review-utils.ts";
import type { ScoreStep } from "./ScoreStep.ts";

/**
 * Plans the comments of a review of a merge request: gives every finding the action a posted review would take and
 * writes the texts of the line comments and of the summary comment. It writes nothing to the merge request: the
 * comment write flow step does that, after it. A review of no merge request has no plan, and neither has one whose
 * reviewer gave no result, because there is nothing true to say about it. The same holds for a review the ChatGPT
 * plan stopped, in the reviewer or in the judge: the command ends such a review with an error and prints no finding,
 * so no comment is planned from what it has, and none is written. And it holds for a review that is to write and
 * whose judge could not judge any of its findings: such a review checked none of what it found, so it writes no
 * comment and the summary that is on the merge request stays. A dry run of such a review has a plan, in which every
 * finding is stored, and so has a review in which the judge judged some findings; the summary counts the findings
 * that were not judged.
 */
@FlowStep({
  name: "comment-plan",
  description:
    "Plans the comments of a review of a merge request: the action of every finding and the texts of the line comments and the summary comment, without writing them; a review without a merge request, one whose reviewer gave no result, one the ChatGPT plan stopped and one that is to write although its judge could not judge any finding have no plan.",
})
export class CommentPlanStep extends FlowStepBase {
  @Inject(CommentPlanner)
  private readonly planner!: CommentPlanner;

  public execute(state: After<typeof ScoreStep>) {
    const { written, change, config, review, judged, log } = state;

    const stopped = state.plan?.adapter.failure !== undefined;

    if (written === undefined || !review.completed || stopped) return { commentPlan: undefined };

    if (!state.dryRun && judgedNothing(state.findings)) {
      log.warn("no comment plan: the judge could not judge any finding", { findings: state.findings.length });

      return { commentPlan: undefined };
    }

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
