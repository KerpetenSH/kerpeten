import type { JudgedFinding, JudgeErrorFields, ReviewerFinding } from "../../../src/harnesses/review/types/review.ts";
import { CommentableLines } from "../../../src/layer/comment/CommentableLines.ts";
import { CommentMarker } from "../../../src/layer/comment/CommentMarker.ts";
import type {
  CommentPlanInput,
  PlannedFinding,
  RankedFinding,
  WrittenComment,
} from "../../../src/layer/comment/types/comment.ts";

export const HEAD = "a".repeat(40);

export const OTHER_HEAD = "b".repeat(40);

export const NOTE = "👎 If you do not want this finding again, react with 👎; you can reply with the reason.";

export const TURKISH_NOTE = "👎 Bu bulgu tekrar gelmesin istiyorsan 👎 bas; nedenini cevap olarak yazabilirsin.";

/**
 * A patch as git writes it with three lines of context. `src/a.ts` has two hunks, whose new lines are 3 to 9 and 20
 * to 26. `src/new name.ts` was renamed and changed, with the new lines 1 to 4. `src/added.ts` is new, with the lines 1
 * and 2 and no line end after the last. `src/gone.ts` was deleted. `src/naïve "q".ts`, whose path git quotes, has the
 * new lines 1 and 2. `moved.ts` was only renamed.
 */
export const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -3,6 +3,7 @@ export function one() {",
  " line 3",
  " line 4",
  " line 5",
  "+line 6 added",
  " line 6",
  " line 7",
  " line 8",
  "@@ -19,7 +20,7 @@ export function two() {",
  " line 19",
  " line 20",
  " line 21",
  "-line 22",
  "+line 22 changed",
  " line 23",
  " line 24",
  " line 25",
  "diff --git a/src/old name.ts b/src/new name.ts",
  "similarity index 80%",
  "rename from src/old name.ts",
  "rename to src/new name.ts",
  "index 3333333..4444444 100644",
  "--- a/src/old name.ts\t",
  "+++ b/src/new name.ts\t",
  "@@ -1,3 +1,4 @@",
  " keep 1",
  "+new 2",
  " keep 2",
  " keep 3",
  "diff --git a/src/added.ts b/src/added.ts",
  "new file mode 100644",
  "index 0000000..5555555",
  "--- /dev/null",
  "+++ b/src/added.ts",
  "@@ -0,0 +1,2 @@",
  "+first",
  "+second",
  "\\ No newline at end of file",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "index 6666666..0000000",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-bye",
  "-now",
  'diff --git "a/src/na\\303\\257ve \\"q\\".ts" "b/src/na\\303\\257ve \\"q\\".ts"',
  "index 7777777..8888888 100644",
  '--- "a/src/na\\303\\257ve \\"q\\".ts"',
  '+++ "b/src/na\\303\\257ve \\"q\\".ts"',
  "@@ -1 +1,2 @@",
  " one",
  "+two",
  "diff --git a/moved.ts b/moved-here.ts",
  "similarity index 100%",
  "rename from moved.ts",
  "rename to moved-here.ts",
  "",
].join("\n");

const reviewed: ReviewerFinding = {
  file: "src/a.ts",
  start_line: 6,
  end_line: 6,
  category: "bug",
  title: "Division by zero is not handled",
  body: "`div(a, b)` returns Infinity when b is 0.",
  fix: "Check b before dividing.",
  evidence: [{ location: "src/a.ts:6" }],
};

/** A finding the judge labelled, which the scorer gave a line comment and the score 70, with the given fields over it. */
export function finding(fields: Partial<Exclude<JudgedFinding, JudgeErrorFields>> = {}): JudgedFinding {
  return {
    ...reviewed,
    verdict: "verified",
    priority: "P1",
    nature: "critical",
    fix_effort: "easy",
    rationale: "b is never checked",
    score: 70,
    action: "inline",
    ...fields,
  };
}

/** A finding the judge did not label, which is stored with its judge error. */
export function unjudged(fields: Partial<ReviewerFinding> = {}): JudgedFinding {
  return { ...reviewed, ...fields, judge_error: "model_error: overloaded", action: "stored" };
}

/** The input of a comment plan for `findings` over `PATCH` at `HEAD`, with no comment written yet, the limit 10 and English. */
export function planInput(
  findings: readonly JudgedFinding[],
  fields: Partial<CommentPlanInput> = {},
): CommentPlanInput {
  return {
    findings,
    lines: CommentableLines.of(PATCH),
    written: [],
    headSha: HEAD,
    maxInlineComments: 10,
    language: "en",
    ...fields,
  };
}

/** A line comment of Kerpeten that is already on the merge request, as its marker says it. */
export function writtenLine(file: string, startLine: number, endLine: number, headSha = HEAD): WrittenComment {
  return {
    kind: "line",
    mark: CommentMarker.finding(headSha, file, startLine, endLine).mark,
    ref: "github:review_comment/1",
  };
}

/** The titles of findings with their actions, in the order given. */
export function actions(findings: readonly PlannedFinding[]): string[] {
  return findings.map((planned) => `${planned.title}: ${planned.action}`);
}

/** The marker line of the line comment of `planned` at `HEAD`. */
export function findingMarker(planned: RankedFinding, headSha = HEAD): string {
  return CommentMarker.finding(headSha, planned.file, planned.start_line, planned.end_line).line();
}

/** The HTML a Markdown renderer makes of `text`. */
export function rendered(text: string): string {
  return Bun.markdown.html(text);
}

/**
 * What is wrong with the rendered `comment`, whose text must end with the paragraph `note` and the hidden `marker`:
 * an empty list when the note is a paragraph of its own, the marker is an HTML comment after it and no other raw HTML
 * is in the text.
 */
export function renderProblems(comment: string, note: string, marker: string): string[] {
  const html = rendered(comment);
  const tail = `<p>${note}</p>\n${marker}\n`;
  const before = html.endsWith(tail) ? html.slice(0, -tail.length) : html;
  const problems: string[] = [];

  if (!html.endsWith(tail)) problems.push(`the note and the marker do not end the comment: ${html.slice(-300)}`);
  if (comment.split("\n").at(-1) !== marker) problems.push("the marker is not the last line");
  if (before.includes("<!--")) problems.push("an HTML comment is in the text");

  if (/<\/?(?:details|summary|div|script|style|textarea|table><tr|s>|x-raw)/.test(before)) {
    problems.push(`raw HTML is in the text: ${before}`);
  }

  return problems;
}
