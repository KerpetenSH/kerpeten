import {
  type After,
  type OptionalGap,
  type PermissionGrant,
  PermissionGroupError,
  Workflow,
  WorkflowBase,
} from "@kerpetensh/harness-kit";
import { deadlines } from "../../harnesses/harnesses-utils.ts";
import { ReviewInputError } from "../../harnesses/review/ReviewInputError.ts";
import type { Deadlines } from "../../harnesses/types/harnesses.ts";
import { ReviewReport } from "./ReviewReport.ts";
import { CandidateStep } from "./step/CandidateStep.ts";
import { ChangeStep } from "./step/ChangeStep.ts";
import { CommentPlanStep } from "./step/CommentPlanStep.ts";
import { CommentWriteStep } from "./step/CommentWriteStep.ts";
import { JudgeStep } from "./step/JudgeStep.ts";
import { MergeRequestStep } from "./step/MergeRequestStep.ts";
import { ReviewerStep } from "./step/ReviewerStep.ts";
import { ScoreStep } from "./step/ScoreStep.ts";
import { WrittenCommentStep } from "./step/WrittenCommentStep.ts";
import type { ReviewInput, ReviewResult } from "./types/review-workflow.ts";

/**
 * The local review: reads the merge request when the review is of one, reads the change and the comments Kerpeten
 * already wrote to the merge request, runs the reviewer, filters its findings, judges and scores the kept ones, plans
 * the comments of the merge request, writes them unless the review is a dry run, and reports the result. A dry run
 * and a review of no merge request write nothing. An empty change ends after the change flow step, and writes
 * nothing either. The kit checks the run's grant against the reviewer and the judge before git is touched. Expected
 * failures and partial runs are part of the result, and so is a comment that could not be written; a wrong input, a
 * refused grant among them, throws `ReviewInputError`.
 */
@Workflow({
  name: "review",
  description:
    "Reviews the change between the base branch and HEAD, or the change of a merge request whose last commit is HEAD: reads the change, runs the reviewer, keeps the findings that point at real lines, has the judge check them, scores them, plans the comments of a merge request, writes them unless the review is a dry run and reports the result.",
  steps: [
    MergeRequestStep,
    ChangeStep,
    WrittenCommentStep,
    ReviewerStep,
    CandidateStep,
    JudgeStep,
    ScoreStep,
    CommentPlanStep,
    CommentWriteStep,
  ],
})
export class ReviewWorkflow extends WorkflowBase<ReviewInput, After<typeof CommentWriteStep>, ReviewResult> {
  public static deadlines(start: number, minutes: number): Deadlines {
    return deadlines(start, minutes);
  }

  protected override group(input: ReviewInput): string | undefined {
    return input.group;
  }

  /** Logs each optional use of the reviewer's and the judge's tools that the run's grant does not give. */
  protected override admit(input: ReviewInput, _grant: PermissionGrant, gaps: readonly OptionalGap[]): void {
    for (const gap of gaps) input.log.info("optional capability not given", { ...gap });
  }

  /** A permission group the program does not have, or one the kit refused, is a wrong input; every other error is thrown as it is. */
  protected override rescue(error: unknown): never {
    if (error instanceof PermissionGroupError) throw new ReviewInputError(error.message);

    throw error;
  }

  protected finish(state: After<typeof CommentWriteStep>): ReviewResult {
    return ReviewReport.of(state.change, state);
  }
}
