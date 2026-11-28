import type { Finding } from "../../../api/types/api.generated.ts";
import type {
  JudgedFinding,
  JudgeErrorFields,
  JudgeLabelFields,
  ReviewerFinding,
} from "../../../harnesses/review/types/review.ts";
import type { CommentableLines } from "../CommentableLines.ts";

/**
 * What a review does with a finding on a merge request: a comment on its lines, an entry of the summary comment,
 * nothing because it is only stored, or nothing because a line comment for it is already there.
 */
export type PlannedAction = Extract<Finding["action"], "inline" | "summary" | "stored" | "suppressed_duplicate">;

/**
 * A judged finding with the action the comment plan gives it. A finding the judge did not label stays stored.
 * `comment_ref` is there once the comments are written: for the action `inline` the ref of the finding's line comment,
 * for `summary` the ref of the summary comment. A stored finding and a duplicate carry none, and neither does any
 * finding of a plan that was not written.
 */
export type PlannedFinding =
  | (ReviewerFinding &
      Omit<JudgeLabelFields, "action"> & { readonly action: PlannedAction; readonly comment_ref?: string })
  | (ReviewerFinding & JudgeErrorFields);

/** A finding as the comment plan orders and writes it: judged, with the scorer's action or the plan's. */
export type RankedFinding = JudgedFinding | PlannedFinding;

/** Where a finding points: its file and its first and last line. */
export type FindingPlace = Pick<Finding, "file" | "start_line" | "end_line">;

/** Lines of a file from `start` to `end`, both counted. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** What the hidden marker of a line comment says: the commit the review was of, and the finding's file and lines. */
export interface FindingMark {
  readonly kind: "finding";
  readonly version: number;
  readonly headSha: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** What the hidden marker of the summary comment says: the commit the review was of. */
export interface SummaryMark {
  readonly kind: "summary";
  readonly version: number;
  readonly headSha: string;
}

export type CommentMark = FindingMark | SummaryMark;

/**
 * A comment of Kerpeten that is already on the merge request: whether it sits on lines or belongs to the merge
 * request as a whole, what its marker says, and the ref that names it on its platform. The marker makes it
 * Kerpeten's, never its author.
 */
export interface WrittenComment {
  readonly kind: "line" | "general";
  readonly mark: CommentMark;
  readonly ref: string;
}

/**
 * What the comment plan is made from. `partialReason` is given when the review ended early. `language` is the comment
 * language of the configuration; it chooses the fixed texts.
 */
export interface CommentPlanInput {
  readonly findings: readonly JudgedFinding[];
  readonly lines: CommentableLines;
  readonly written: readonly WrittenComment[];
  readonly headSha: string;
  readonly maxInlineComments: number;
  readonly language: string;
  readonly partialReason?: string;
}

/**
 * A comment on lines of a file, with the text to write. `cut` says that a part of the finding's text did not fit.
 * `ref` names the comment on its platform once it is written.
 */
export interface LineComment {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
  readonly cut: boolean;
  readonly ref?: string;
}

/**
 * The one summary comment of a merge request, with the text to write. `omitted` counts the findings of the summary
 * that the text does not show because it would be too long; the text says the same number. `ref` names the comment
 * on its platform once it is written.
 */
export interface SummaryComment {
  readonly body: string;
  readonly omitted: number;
  readonly ref?: string;
}

/** How many findings got each action. */
export interface CommentPlanCounts {
  readonly inline: number;
  readonly summary: number;
  readonly duplicate: number;
  readonly stored: number;
}

/**
 * What a review would write to a merge request: every finding in the order it was given, with its action, the line
 * comments and the summary comment. Nothing of it is written by the plan itself. After the write, the plan says what
 * was written: the line comments are the written ones, and the comments and the findings carry their refs.
 */
export interface CommentPlan {
  readonly findings: readonly PlannedFinding[];
  readonly lineComments: readonly LineComment[];
  readonly summary: SummaryComment;
  readonly counts: CommentPlanCounts;
}

/**
 * What became of one planned line comment when it was given to the platform: it was written and `ref` names it, the
 * platform refused a comment on its lines, or the write failed.
 */
export type LineCommentResult =
  | { readonly kind: "written"; readonly ref: string }
  | { readonly kind: "refused" }
  | { readonly kind: "failed" };

/**
 * What the plan after the line comments is made from: the plan, one result for each of its line comments in their
 * order, and what the summary text is written with, as the plan was made with it.
 */
export interface LineWriteInput {
  readonly plan: CommentPlan;
  readonly results: readonly LineCommentResult[];
  readonly headSha: string;
  readonly language: string;
  readonly partialReason?: string;
}

/**
 * What the summary comment says beside its findings. `unwritten` counts the findings whose line comment was given to
 * the platform and failed; it is left out before anything is written. `unjudged` counts the findings the judge could
 * not judge, which are stored and never written.
 */
export interface SummaryFacts {
  readonly lineComments: number;
  readonly alreadyWritten: number;
  readonly unwritten?: number;
  readonly unjudged?: number;
  readonly partialReason?: string;
}

/** The fixed texts of a comment in one language. */
export interface CommentWordSet {
  readonly heading: string;
  readonly fix: string;
  readonly thumbsDown: string;
  readonly nothing: string;
  readonly untitled: string;
  readonly cut: string;
  reviewed(commit: string, lineComments: number, alreadyWritten: number): string;
  unwritten(count: number): string;
  unjudged(count: number): string;
  partial(reason: string): string;
  omitted(count: number): string;
}

/** An open fenced code block: the character and the length of its fence, and how far the fence was indented. */
export interface CodeFence {
  readonly char: string;
  readonly length: number;
  readonly indent: number;
}
