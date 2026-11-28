import { Inject } from "@asenajs/ioc";
import { type After, FlowStep, FlowStepBase, Use } from "@kerpetensh/harness-kit";
import { CommentRef } from "../../../capability/platform/CommentRef.ts";
import { PlatformChoice } from "../../../capability/platform/PlatformChoice.ts";
import type { PlatformLineComment, PlatformWriter, SummaryWrite } from "../../../capability/platform/types/platform.ts";
import { CommentMarker } from "../../../layer/comment/CommentMarker.ts";
import { CommentPlanner } from "../../../layer/comment/CommentPlanner.ts";
import type { CommentPlan, LineComment, WrittenComment } from "../../../layer/comment/types/comment.ts";
import type { Logger } from "../../../log/Logger.ts";
import { terminalLine } from "../../../text/text-utils.ts";
import type { CommentWrite } from "../types/review-workflow.ts";
import type { CommentPlanStep } from "./CommentPlanStep.ts";

/**
 * Writes the planned comments to the merge request, as the last flow step of a review, through the writer the run's
 * platform choice gives. With `--dry-run`, and for a review that has no plan, it writes nothing and asks for no
 * writer.
 *
 * The order is fixed:
 *
 * 1. The line comments go to the platform in one write. Each comes back written with its ref, refused, or failed.
 * 2. The plan is made final from that, by the comment planner: a refused finding goes to the summary, a failed one is
 *    stored, and the summary text is written again so that it says what is really on the merge request, the count of
 *    the findings whose write failed among it.
 * 3. The summary comment is written last. There is one per merge request: when the comments read at the start hold a
 *    summary comment of Kerpeten, known by its marker, that one gets the new text, otherwise one is made. A review
 *    without findings writes it too. When it cannot be written, its findings are stored; so is a finding the summary
 *    text leaves out because the comment would be too long.
 *
 * A comment is Kerpeten's by its marker, never by its author, so the summary comment that is there may be one this
 * account cannot change: it was written from another account, and the platform lets only some accounts change the
 * comments of others. No author is read to find that out. The platform's answer says it: when it refuses the update
 * of a summary comment, or the comment is gone, the next summary comment is tried, and when none is left a new one is
 * made. Each such comment is logged as a warning. So the summary is written, and the merge request then holds a
 * summary comment per account that cannot change the other's.
 *
 * A comment that cannot be written does not stop the others. Each is logged and gives one line of `failures`, which
 * the command reports and ends with 1 for. A second run writes no line comment twice, because the comments of the
 * first are known by their markers.
 *
 * The rule for a failure is about findings, not about calls: a finding whose text the plan was to write, on its lines
 * or in the summary, and whose text is in no written comment at the end, is a failure of the write, whatever took it
 * there. So a refused line comment is no failure while its finding is in the written summary; it is one when the
 * summary fails, which the line of the summary says, and when the summary is too long to hold the finding, which
 * gets a line of its own. A finding the summary showed in the plan and that a finding joining it pushed out is one
 * too. A finding the plan itself already left out of the summary for its length is none: the plan never was to write
 * it, and the summary says how many it leaves out.
 *
 * A review that ended in an error writes nothing: an error thrown before this flow step ends the workflow, and a
 * review whose reviewer gave no result or that the ChatGPT plan stopped has no plan to write.
 *
 * Runs of one merge request are not kept apart. The comments that are there are read at the start of a run, before
 * the models are called, and nothing is locked: two runs that overlap can both write the line comment of a finding
 * and can both make a summary comment. Nothing is lost by it. A later run takes both line comments as written, updates
 * the first summary comment and logs a warning that names the other.
 */
@FlowStep({
  name: "comment-write",
  description:
    "Writes the planned comments to the merge request: the line comments in one write, then the one summary comment, made or updated; a line comment the platform refuses goes to the summary and one that fails leaves its finding stored; with --dry-run, or without a plan, it writes nothing.",
})
export class CommentWriteStep extends FlowStepBase {
  @Inject(CommentPlanner)
  private readonly planner!: CommentPlanner;

  @Use(PlatformChoice)
  private readonly platforms!: PlatformChoice;

  /** A planned line comment as the platform takes it, with the marker that ends its text. */
  private static lineComment(comment: LineComment): PlatformLineComment {
    const { file, startLine, endLine, body } = comment;
    const marker = CommentMarker.read(body);

    if (marker === undefined) throw new Error(`the line comment on ${CommentWriteStep.place(comment)} has no marker`);

    return { file, startLine, endLine, body, marker: marker.line() };
  }

  private static place(comment: LineComment): string {
    return CommentWriteStep.lines(comment.file, comment.startLine, comment.endLine);
  }

  private static lines(file: string, startLine: number, endLine: number): string {
    return `${terminalLine(file)}:${startLine === endLine ? startLine : `${startLine}-${endLine}`}`;
  }

  /**
   * One line for each finding that a written summary leaves out for its length although the plan was to write it:
   * `meant` says for every finding whether the plan was, `listed` is the plan the summary was written from and
   * `final` the plan after it. A finding that was to have a line comment got there because the platform refused it.
   */
  private static leftOut(planned: CommentPlan, meant: readonly boolean[], listed: CommentPlan, final: CommentPlan) {
    return final.findings.flatMap((finding, index) => {
      const written = "comment_ref" in finding && finding.comment_ref !== undefined;

      if (written || meant[index] !== true || listed.findings[index]?.action !== "summary") return [];

      const refused = planned.findings[index]?.action === "inline";

      return [
        {
          place: CommentWriteStep.lines(finding.file, finding.start_line, finding.end_line),
          error: refused
            ? "not written: the platform refused a comment on its lines, and the summary comment is too long to hold it"
            : "not written: the summary comment is too long to hold it",
        },
      ];
    });
  }

  /**
   * The refs of the summary comments of Kerpeten that are on the merge request: the comments of its conversation that
   * end with the summary's marker, in the order they were read. Any other comment with that marker is somebody's copy.
   */
  private static summaries(written: readonly WrittenComment[]): string[] {
    return written
      .filter((comment) => comment.mark.kind === "summary" && CommentRef.parse(comment.ref).inConversation)
      .map((comment) => comment.ref);
  }

  public async execute(state: After<typeof CommentPlanStep>) {
    const { commentPlan, mergeRequest, written, change, config, review, judged, log } = state;

    if (state.dryRun || commentPlan === undefined || mergeRequest === undefined || written === undefined) {
      return { commentWrite: undefined };
    }

    const writer = await this.platforms.writer();

    if (writer === undefined) throw new Error(`no writer for the platform ${mergeRequest.kind}`);

    const { number } = mergeRequest;
    const failures: string[] = [];
    const planned = commentPlan.lineComments;

    const lines = await writer.writeLineComments(
      number,
      change.headSha,
      planned.map((comment) => CommentWriteStep.lineComment(comment)),
    );

    for (const [index, outcome] of lines.outcomes.entries()) {
      const comment = planned[index];
      const place = comment === undefined ? "?" : CommentWriteStep.place(comment);

      if (outcome.kind === "refused") {
        log.warn("line comment refused, its finding goes to the summary", { place, reason: outcome.reason });
      }

      if (outcome.kind === "failed") {
        log.error("line comment failed, its finding is stored", { place, error: outcome.message });
        failures.push(`line comment on ${place}: ${terminalLine(outcome.message)}`);
      }
    }

    for (const problem of lines.problems) log.warn("line comments written", { problem });

    const partialReason = review.partialReason ?? judged?.partialReason;

    const afterLines = this.planner.afterLineComments({
      plan: commentPlan,
      results: lines.outcomes,
      headSha: change.headSha,
      language: config.comment_language,
      ...(partialReason === undefined ? {} : { partialReason }),
    });

    const summaries = CommentWriteStep.summaries(written);
    const summary = await this.writeSummary(writer, number, afterLines.summary.body, summaries, log);
    const summaryRef = summary.kind === "written" ? summary.ref : undefined;

    if (summary.kind !== "written") {
      const error = summary.kind === "failed" ? summary.message : summary.reason;

      log.error("summary comment failed, its findings are stored", { error });
      failures.push(`summary comment: ${terminalLine(error)}`);
    }

    if (summaries.length > 1) {
      log.warn("more than one summary comment is on the merge request", {
        updated: summaryRef,
        all: summaries.join(","),
      });
    }

    if (summaryRef !== undefined && afterLines.summary.omitted > 0) {
      log.warn("summary comment does not show every finding, the ones left out are stored", {
        omitted: afterLines.summary.omitted,
      });
    }

    const plan = this.planner.afterSummary(afterLines, summaryRef);
    const meant = this.planner.writes(commentPlan);

    for (const left of summaryRef === undefined ? [] : CommentWriteStep.leftOut(commentPlan, meant, afterLines, plan)) {
      log.error("finding is written nowhere, it is stored", left);
      failures.push(`finding on ${left.place}: ${left.error}`);
    }

    log.info("comments written", {
      line_comments: plan.lineComments.length,
      refused: lines.outcomes.filter((outcome) => outcome.kind === "refused").length,
      failed: lines.outcomes.filter((outcome) => outcome.kind === "failed").length,
      summary: summary.kind !== "written" ? "failed" : summary.updated ? "updated" : "created",
      summary_ref: summaryRef,
    });

    const commentWrite: CommentWrite = { plan, failures };

    return { commentWrite };
  }

  /**
   * Writes the summary comment with the text `body`: updates the first of `summaries`, the summary comments that are
   * on the merge request, that the platform lets this account change, and makes a new one when there is none or none
   * can be changed. A comment the platform refuses to change is logged and left as it is.
   */
  private async writeSummary(
    writer: PlatformWriter,
    number: number,
    body: string,
    summaries: readonly string[],
    log: Logger,
  ): Promise<SummaryWrite> {
    for (const existing of summaries) {
      const updated = await writer.writeSummary(number, body, existing);

      if (updated.kind !== "refused") return updated;

      log.warn("summary comment cannot be updated by this account, another one is written", {
        comment: existing,
        reason: updated.reason,
      });
    }

    return writer.writeSummary(number, body);
  }
}
