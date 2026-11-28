import { type After, FlowStep, FlowStepBase, Use } from "@kerpetensh/harness-kit";
import { PlatformChoice } from "../../../capability/platform/PlatformChoice.ts";
import { PlatformError } from "../../../capability/platform/PlatformError.ts";
import { PlatformWords } from "../../../capability/platform/PlatformWords.ts";
import type { PlatformComment, PlatformComments } from "../../../capability/platform/types/platform.ts";
import { CommentMarker } from "../../../layer/comment/CommentMarker.ts";
import type { WrittenComment } from "../../../layer/comment/types/comment.ts";
import { terminalLine } from "../../../text/text-utils.ts";
import { mergeRequestReadError } from "../review-utils.ts";
import type { ReviewedMergeRequest } from "../types/review-workflow.ts";
import type { ChangeStep } from "./ChangeStep.ts";

/**
 * Reads the comments that are already on the merge request and keeps the ones Kerpeten wrote, so the comment plan
 * knows which findings are written. A comment is Kerpeten's by the hidden marker that ends its text, never by its
 * author: a local run writes from the user's own account.
 *
 * It runs after the change is read and before the reviewer, so the cheap checks of the working copy come first and a
 * platform that cannot give the comments stops the review before any model is called. The platform is the one the
 * run's platform choice gives, the same the merge request was read from. When the comments could not all be read, the
 * review cannot tell what is written and would write it twice, so it stops with a platform error, in the words of the
 * platform. A review of no merge request reads nothing and chooses no platform.
 */
@FlowStep({
  name: "written-comments",
  description:
    "Reads the comments already on the merge request and keeps the ones Kerpeten wrote, known by their hidden marker, before any model call; comments that cannot all be read stop the review, and a review without a merge request reads none.",
})
export class WrittenCommentStep extends FlowStepBase {
  @Use(PlatformChoice)
  private readonly platforms!: PlatformChoice;

  private static written(comments: readonly PlatformComment[]): WrittenComment[] {
    return comments.flatMap((comment) => {
      const marker = CommentMarker.read(comment.body);

      return marker === undefined ? [] : [{ kind: comment.kind, mark: marker.mark, ref: comment.ref }];
    });
  }

  public async execute(state: After<typeof ChangeStep>) {
    const { mergeRequest, log } = state;

    const written: readonly WrittenComment[] | undefined =
      mergeRequest === undefined ? undefined : WrittenCommentStep.written(await this.read(mergeRequest));

    if (written !== undefined) {
      log.info("merge request comments read", {
        kerpeten_line: written.filter((comment) => comment.kind === "line" && comment.mark.kind === "finding").length,
        kerpeten_summary: written.filter((comment) => comment.mark.kind === "summary").length,
      });
    }

    return { written };
  }

  private async read(mergeRequest: ReviewedMergeRequest): Promise<readonly PlatformComment[]> {
    const { number, kind } = mergeRequest;
    let read: PlatformComments;

    try {
      const platform = await this.platforms.platform();

      read = await platform.comments(number);
    } catch (error) {
      throw mergeRequestReadError(number, error);
    }

    if (read.complete) return read.comments;

    const problems = read.problems.map((problem) => terminalLine(problem)).join("; ");

    throw new PlatformError(
      "failed",
      `--mr ${number}: the comments of the ${PlatformWords.of(kind).noun} could not all be read, so the review cannot tell which findings are already written: ${problems}`,
    );
  }
}
