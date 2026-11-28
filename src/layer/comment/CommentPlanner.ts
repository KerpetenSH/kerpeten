import { Service } from "@asenajs/ioc";
import type { JudgedFinding } from "../../harnesses/review/types/review.ts";
import type { CommentableLines } from "./CommentableLines.ts";
import { CommentTexts } from "./CommentTexts.ts";
import { CommentWords } from "./CommentWords.ts";
import type {
  CommentPlan,
  CommentPlanInput,
  LineCommentResult,
  LineWriteInput,
  PlannedAction,
  PlannedFinding,
  RankedFinding,
} from "./types/comment.ts";
import { WrittenFindings } from "./WrittenFindings.ts";

/**
 * Decides what a review would write to its merge request: one action for every judged finding, and the texts of the
 * line comments and of the summary comment. Pure: no network, no clock, no model and no randomness, so the same input
 * always gives the same plan. It writes nothing.
 *
 * The rules, in this order:
 *
 * 1. A finding the scorer stored stays stored: a refuted one, one the judge did not label and one under the summary
 *    threshold. It is never written.
 * 2. A finding that a line comment of Kerpeten on the merge request already stands for, at the same commit, file and
 *    lines, is a duplicate and is not written again.
 * 3. A finding the scorer gave a line comment gets one when its whole range lies inside one hunk of its file on the
 *    new side of the diff; otherwise it goes to the summary.
 * 4. At most `maxInlineComments` line comments are written in one run. When more findings qualify, the ones with the
 *    highest score keep their line and the others go to the summary.
 * 5. A finding the scorer gave the summary goes to the summary.
 *
 * Where scores are equal, the file, then the first line, then the title decide, and after them the last line, the
 * body, the fix and the category, so the order never depends on the order the findings came in. The line comments and
 * the findings of the summary are in that order, highest score first.
 *
 * The plan is also what says what was written, in two more steps that are as pure as the first. The planner still
 * writes nothing: it is told what became of each comment.
 *
 * 6. `afterLineComments`, once the line comments were given to the platform: a finding whose line comment is written
 *    keeps `inline` and carries the ref of that comment. One whose lines the platform refused goes to the summary.
 *    One whose write failed is stored. The summary text is written again, so its count of line comments and its
 *    findings say what is really there, and it counts the findings whose write failed: a summary never says that
 *    the review found nothing while such a finding exists.
 * 7. `afterSummary`, once the summary comment was given to the platform: every finding the summary text shows
 *    carries the ref of the summary comment. A finding the text leaves out because the comment would be too long is
 *    stored: a finding has a ref only when its text is in the comment. When the summary could not be written, all
 *    its findings are stored.
 */
@Service("kerpeten:comment-planner")
export class CommentPlanner {
  public plan(input: CommentPlanInput): CommentPlan {
    const { findings, lines, headSha, maxInlineComments } = input;

    if (!Number.isSafeInteger(maxInlineComments) || maxInlineComments < 0) {
      throw new RangeError(`not a count of line comments: ${String(maxInlineComments)}`);
    }

    const texts = new CommentTexts(CommentWords.of(input.language), headSha);
    const written = new WrittenFindings(input.written);

    const first = findings.map((finding) => ({
      finding,
      action: CommentPlanner.first(finding, written.has(headSha, finding), lines),
    }));

    const overLimit = new Set(
      first
        .filter((entry) => entry.action === "inline")
        .sort((one, other) => CommentPlanner.byRank(one.finding, other.finding))
        .slice(maxInlineComments),
    );

    const planned = first.map((entry) =>
      CommentPlanner.planned(entry.finding, overLimit.has(entry) ? "summary" : entry.action),
    );

    const inline = CommentPlanner.ranked(planned, "inline");
    const listed = CommentPlanner.ranked(planned, "summary");
    const duplicate = planned.filter((finding) => finding.action === "suppressed_duplicate").length;

    return {
      findings: planned,
      lineComments: inline.map((finding) => texts.lineComment(finding)),
      summary: texts.summary(listed, {
        lineComments: inline.length,
        alreadyWritten: duplicate,
        ...(input.partialReason === undefined ? {} : { partialReason: input.partialReason }),
      }),
      counts: {
        inline: inline.length,
        summary: listed.length,
        duplicate,
        stored: planned.filter((finding) => finding.action === "stored").length,
      },
    };
  }

  /**
   * The plan after its line comments were given to the platform, with one result for each line comment in the plan's
   * order. The line comments of the new plan are the written ones, each with its ref.
   */
  public afterLineComments(input: LineWriteInput): CommentPlan {
    const { plan, results } = input;

    const inline = plan.findings
      .map((finding, index) => ({ finding, index }))
      .filter((entry) => entry.finding.action === "inline")
      .sort((one, other) => CommentPlanner.byRank(one.finding, other.finding));

    if (results.length !== plan.lineComments.length || inline.length !== plan.lineComments.length) {
      throw new RangeError(
        `a plan of ${plan.lineComments.length} line comments got ${results.length} results for ${inline.length} findings on lines`,
      );
    }

    for (const [rank, { finding }] of inline.entries()) {
      const comment = plan.lineComments[rank];

      if (
        comment?.file !== finding.file ||
        comment.startLine !== finding.start_line ||
        comment.endLine !== finding.end_line
      ) {
        throw new RangeError(`line comment ${rank + 1} of the plan is not the one of its finding`);
      }
    }

    const result = new Map(inline.map((entry, rank) => [entry.index, results[rank]]));
    const findings = plan.findings.map((finding, index) => CommentPlanner.written(finding, result.get(index)));
    const listed = CommentPlanner.ranked(findings, "summary");

    const lineComments = plan.lineComments.flatMap((comment, index) => {
      const written = results[index];

      return written?.kind === "written" ? [{ ...comment, ref: written.ref }] : [];
    });

    const texts = new CommentTexts(CommentWords.of(input.language), input.headSha);

    return {
      findings,
      lineComments,
      summary: texts.summary(listed, {
        lineComments: lineComments.length,
        alreadyWritten: plan.counts.duplicate,
        unwritten: results.filter((written) => written.kind === "failed").length,
        ...(input.partialReason === undefined ? {} : { partialReason: input.partialReason }),
      }),
      counts: {
        inline: lineComments.length,
        summary: listed.length,
        duplicate: plan.counts.duplicate,
        stored: findings.filter((finding) => finding.action === "stored").length,
      },
    };
  }

  /**
   * The plan after its summary comment was given to the platform. With `ref`, the ref of the written summary comment,
   * every finding the summary text shows carries it; the findings the text leaves out, the last ones in the order of
   * the summary, are stored. Without a ref the summary was not written, and all its findings are stored.
   */
  public afterSummary(plan: CommentPlan, ref: string | undefined): CommentPlan {
    const listed = plan.findings.filter((finding) => finding.action === "summary").length;
    const shown = ref === undefined ? new Set<number>() : CommentPlanner.shown(plan);

    const findings = plan.findings.map((finding, index) => {
      if ("judge_error" in finding || finding.action !== "summary") return finding;

      return ref !== undefined && shown.has(index)
        ? { ...finding, comment_ref: ref }
        : CommentPlanner.planned(finding, "stored");
    });

    return {
      ...plan,
      findings,
      summary: ref === undefined ? plan.summary : { ...plan.summary, ref },
      counts: { ...plan.counts, summary: shown.size, stored: plan.counts.stored + listed - shown.size },
    };
  }

  /**
   * For every finding of `plan`, in the plan's order, whether the plan writes its text: a finding with a line comment,
   * and a finding of the summary that the summary text shows. A finding the summary leaves out because the comment
   * would be too long is not written by the plan, and neither is a stored finding or a duplicate.
   */
  public writes(plan: CommentPlan): boolean[] {
    const shown = CommentPlanner.shown(plan);

    return plan.findings.map((finding, index) => finding.action === "inline" || shown.has(index));
  }

  /**
   * The places in `plan.findings` of the findings the summary text of the plan shows: the findings of the summary in
   * the summary's order, without the last ones that the text leaves out.
   */
  private static shown(plan: CommentPlan): Set<number> {
    const listed = plan.findings
      .map((finding, index) => ({ finding, index }))
      .filter((entry) => entry.finding.action === "summary")
      .sort((one, other) => CommentPlanner.byRank(one.finding, other.finding));

    return new Set(listed.slice(0, listed.length - plan.summary.omitted).map((entry) => entry.index));
  }

  /** A finding after its line comment was given to the platform; a finding that had no line comment stays as it is. */
  private static written(finding: PlannedFinding, result: LineCommentResult | undefined): PlannedFinding {
    if (result === undefined || "judge_error" in finding) return finding;

    if (result.kind === "written") return { ...finding, comment_ref: result.ref };

    return { ...finding, action: result.kind === "refused" ? "summary" : "stored" };
  }

  /** The action of a finding before the limit of line comments is applied. */
  private static first(finding: JudgedFinding, written: boolean, lines: CommentableLines): PlannedAction {
    if (finding.action === "stored") return "stored";

    if (written) return "suppressed_duplicate";

    if (finding.action === "summary") return "summary";

    return lines.holds(finding.file, finding.start_line, finding.end_line) ? "inline" : "summary";
  }

  private static planned(finding: JudgedFinding | PlannedFinding, action: PlannedAction): PlannedFinding {
    return "judge_error" in finding ? finding : { ...finding, action };
  }

  private static ranked(findings: readonly PlannedFinding[], action: PlannedAction): PlannedFinding[] {
    return findings.filter((finding) => finding.action === action).sort(CommentPlanner.byRank);
  }

  private static byRank(first: RankedFinding, second: RankedFinding): number {
    return (
      CommentPlanner.score(second) - CommentPlanner.score(first) ||
      CommentPlanner.order(first.file, second.file) ||
      first.start_line - second.start_line ||
      CommentPlanner.order(first.title, second.title) ||
      first.end_line - second.end_line ||
      CommentPlanner.order(first.body, second.body) ||
      CommentPlanner.order(first.fix, second.fix) ||
      CommentPlanner.order(first.category, second.category)
    );
  }

  private static score(finding: RankedFinding): number {
    return "judge_error" in finding ? 0 : finding.score;
  }

  /** The order of two texts by their characters, the same on every machine and in every language setting. */
  private static order(first: string, second: string): number {
    if (first === second) return 0;

    return first < second ? -1 : 1;
  }
}
