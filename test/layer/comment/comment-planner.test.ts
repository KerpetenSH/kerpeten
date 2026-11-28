import { describe, expect, test } from "bun:test";
import { CommentMarker } from "../../../src/layer/comment/CommentMarker.ts";
import { CommentPlanner } from "../../../src/layer/comment/CommentPlanner.ts";
import type { WrittenComment } from "../../../src/layer/comment/types/comment.ts";
import { component } from "../../harnesses/harnesses-utils.ts";
import {
  actions,
  finding,
  findingMarker,
  HEAD,
  NOTE,
  OTHER_HEAD,
  planInput,
  TURKISH_NOTE,
  unjudged,
  writtenLine,
} from "./comment-utils.ts";

const planner = await component(CommentPlanner, [CommentPlanner]);

const SUMMARY_MARKER = `<!-- kerpeten:summary v1 head=${HEAD} -->`;

const REF = "github:review_comment/501";

const SUMMARY_REF = "github:issue_comment/900";

const NOTHING = [
  "## Kerpeten review",
  `Reviewed commit ${HEAD}. Line comments in this run: 0.`,
  "The review found nothing to report.",
  SUMMARY_MARKER,
].join("\n\n");

describe("comment planner: stored findings", () => {
  test("a refuted finding, one the judge did not label and one under the threshold stay stored and are never written", () => {
    const refuted = finding({ title: "Refuted", verdict: "refuted", score: 0, action: "stored" });
    const low = finding({ title: "Low", score: 15, action: "stored" });
    const failed = unjudged({ title: "Unjudged" });
    const plan = planner.plan(planInput([refuted, low, failed]));

    expect(actions(plan.findings)).toEqual(["Refuted: stored", "Low: stored", "Unjudged: stored"]);
    expect(plan.findings).toEqual([refuted, low, failed]);
    expect(plan.lineComments).toEqual([]);
    expect(plan.counts).toEqual({ inline: 0, summary: 0, duplicate: 0, stored: 3 });

    expect(plan.summary).toEqual({
      body: [
        "## Kerpeten review",
        `Reviewed commit ${HEAD}. Line comments in this run: 0.`,
        "Findings that could not be checked, so they are not written here: 1. The output of the review run lists them.",
        SUMMARY_MARKER,
      ].join("\n\n"),
      omitted: 0,
    });

    expect(planner.plan(planInput([refuted, low])).summary).toEqual({ body: NOTHING, omitted: 0 });
  });

  test("the count of the findings the judge could not judge stays in the summary that is written again after the line comments", () => {
    const plan = planner.plan(planInput([finding(), unjudged({ title: "Unjudged" }), unjudged({ title: "Other" })]));
    const counted = "Findings that could not be checked, so they are not written here: 2.";

    expect(plan.summary.body).toContain(`Line comments in this run: 1.\n\n${counted}`);

    const after = planner.afterLineComments({ plan, results: [{ kind: "failed" }], headSha: HEAD, language: "en" });

    expect(after.summary.body).toContain(
      `Line comments in this run: 0.\n\nFindings whose comment may be missing here, because writing it failed: 1. The output of the review run lists them.\n\n${counted}`,
    );

    expect(after.summary.body).not.toContain("nothing to report");
  });

  test("a stored finding stays stored when a line comment for its lines is already written", () => {
    const low = finding({ title: "Low", score: 15, action: "stored" });
    const plan = planner.plan(planInput([low, unjudged()], { written: [writtenLine("src/a.ts", 6, 6)] }));

    expect(plan.findings.map((planned) => planned.action)).toEqual(["stored", "stored"]);
    expect(plan.counts).toEqual({ inline: 0, summary: 0, duplicate: 0, stored: 2 });
  });

  test("a run without a finding still has a summary, which says that nothing was found", () => {
    const plan = planner.plan(planInput([]));

    expect(plan).toEqual({
      findings: [],
      lineComments: [],
      summary: { body: NOTHING, omitted: 0 },
      counts: { inline: 0, summary: 0, duplicate: 0, stored: 0 },
    });
  });
});

describe("comment planner: findings that are already written", () => {
  test("a line comment of Kerpeten with the same commit, file and lines makes the finding a duplicate that is not written", () => {
    const first = finding({ title: "Written" });
    const second = finding({ title: "New", start_line: 22, end_line: 23 });
    const plan = planner.plan(planInput([first, second], { written: [writtenLine("src/a.ts", 6, 6)] }));

    expect(actions(plan.findings)).toEqual(["Written: suppressed_duplicate", "New: inline"]);
    expect(plan.lineComments.map((comment) => comment.startLine)).toEqual([22]);
    expect(plan.summary.body).not.toContain("Written");
    expect(plan.summary.body).toContain("Line comments in this run: 1. Findings that already had a line comment: 1.");
    expect(plan.counts).toEqual({ inline: 1, summary: 0, duplicate: 1, stored: 0 });
  });

  test("a finding the scorer gave the summary is a duplicate too when its line comment is there", () => {
    const plan = planner.plan(
      planInput([finding({ score: 40, action: "summary" })], { written: [writtenLine("src/a.ts", 6, 6)] }),
    );

    expect(plan.findings.map((planned) => planned.action)).toEqual(["suppressed_duplicate"]);
    expect(plan.summary.body).not.toContain("###");
  });

  test("another commit, another file, another first or last line make no duplicate", () => {
    const others = [
      writtenLine("src/a.ts", 6, 6, OTHER_HEAD),
      writtenLine("src/b.ts", 6, 6),
      writtenLine("src/a.ts", 5, 6),
      writtenLine("src/a.ts", 6, 7),
    ];

    const plan = planner.plan(planInput([finding()], { written: others }));

    expect(plan.findings.map((planned) => planned.action)).toEqual(["inline"]);
  });

  test("a marker in a comment that sits on no line, and a summary marker, make no duplicate", () => {
    const finding66 = CommentMarker.finding(HEAD, "src/a.ts", 6, 6).mark;
    const general: WrittenComment = { kind: "general", mark: finding66, ref: "github:issue_comment/1" };
    const summaryOnLine: WrittenComment = { kind: "line", mark: CommentMarker.summary(HEAD).mark, ref: REF };
    const summary: WrittenComment = { kind: "general", mark: CommentMarker.summary(HEAD).mark, ref: SUMMARY_REF };
    const plan = planner.plan(planInput([finding()], { written: [general, summaryOnLine, summary] }));

    expect(plan.findings.map((planned) => planned.action)).toEqual(["inline"]);
  });

  test("duplicates are taken out before the limit, so they do not count against it", () => {
    const findings = [
      finding({ title: "Written top", score: 95 }),
      finding({ title: "Second", start_line: 4, end_line: 4, score: 80 }),
      finding({ title: "Third", start_line: 22, end_line: 22, score: 70 }),
      finding({ title: "Fourth", start_line: 24, end_line: 24, score: 65 }),
    ];

    const plan = planner.plan(planInput(findings, { maxInlineComments: 2, written: [writtenLine("src/a.ts", 6, 6)] }));

    expect(actions(plan.findings)).toEqual([
      "Written top: suppressed_duplicate",
      "Second: inline",
      "Third: inline",
      "Fourth: summary",
    ]);

    expect(plan.counts).toEqual({ inline: 2, summary: 1, duplicate: 1, stored: 0 });
  });
});

describe("comment planner: line comments", () => {
  test("a finding the scorer gave a line comment gets one when its whole range lies in one hunk", () => {
    const inside = finding({ start_line: 3, end_line: 9 });
    const plan = planner.plan(planInput([inside]));

    expect(plan.findings).toEqual([inside]);
    expect(plan.lineComments.length).toBe(1);
    expect(plan.lineComments[0]).toMatchObject({ file: "src/a.ts", startLine: 3, endLine: 9, cut: false });
    expect(plan.lineComments[0]?.body.endsWith(`\n\n${NOTE}\n${findingMarker(inside)}`)).toBe(true);

    expect(plan.summary.body).toBe(
      ["## Kerpeten review", `Reviewed commit ${HEAD}. Line comments in this run: 1.`, SUMMARY_MARKER].join("\n\n"),
    );
  });

  test("a range that touches the edge of a hunk stays on its lines, one line further goes to the summary", () => {
    const findings = [
      finding({ title: "First line of the hunk", start_line: 3, end_line: 3 }),
      finding({ title: "Last line of the hunk", start_line: 9, end_line: 9 }),
      finding({ title: "One line before", start_line: 2, end_line: 3 }),
      finding({ title: "One line after", start_line: 9, end_line: 10 }),
      finding({ title: "Across two hunks", start_line: 8, end_line: 21 }),
      finding({ title: "Between the hunks", start_line: 14, end_line: 14 }),
    ];

    expect(actions(planner.plan(planInput(findings)).findings)).toEqual([
      "First line of the hunk: inline",
      "Last line of the hunk: inline",
      "One line before: summary",
      "One line after: summary",
      "Across two hunks: summary",
      "Between the hunks: summary",
    ]);
  });

  test("a file that is not in the diff, a deleted file and the old path of a renamed file go to the summary", () => {
    const findings = [
      finding({ title: "Not in the diff", file: "src/untouched.ts" }),
      finding({ title: "Deleted", file: "src/gone.ts", start_line: 1, end_line: 1 }),
      finding({ title: "Old path", file: "src/old name.ts", start_line: 2, end_line: 2 }),
      finding({ title: "New path", file: "src/new name.ts", start_line: 2, end_line: 2 }),
      finding({ title: "Added", file: "src/added.ts", start_line: 1, end_line: 2 }),
    ];

    const plan = planner.plan(planInput(findings));

    expect(actions(plan.findings)).toEqual([
      "Not in the diff: summary",
      "Deleted: summary",
      "Old path: summary",
      "New path: inline",
      "Added: inline",
    ]);

    expect(plan.summary.body).toContain("### Not in the diff\n`src/untouched.ts:6` · bug · P1");
    expect(plan.summary.body).toContain("### Deleted\n`src/gone.ts:1` · bug · P1");
  });

  test("a finding the scorer gave the summary stays in the summary, also inside a hunk", () => {
    const plan = planner.plan(planInput([finding({ score: 40, action: "summary" })]));

    expect(plan.findings.map((planned) => planned.action)).toEqual(["summary"]);
    expect(plan.lineComments).toEqual([]);
    expect(plan.summary.body).toContain("### Division by zero is not handled\n`src/a.ts:6` · bug · P1");
    expect(plan.counts).toEqual({ inline: 0, summary: 1, duplicate: 0, stored: 0 });
  });
});

describe("comment planner: the limit of line comments", () => {
  const findings = [
    finding({ title: "Low", start_line: 4, end_line: 4, score: 61 }),
    finding({ title: "High", start_line: 22, end_line: 22, score: 95 }),
    finding({ title: "Middle", start_line: 6, end_line: 6, score: 80 }),
    finding({ title: "Outside a hunk", start_line: 14, end_line: 14, score: 99 }),
    finding({ title: "Scored for the summary", start_line: 5, end_line: 5, score: 30, action: "summary" }),
  ];

  test("with more findings than the limit, the highest scores keep their lines and the others go to the summary", () => {
    const plan = planner.plan(planInput(findings, { maxInlineComments: 2 }));

    expect(actions(plan.findings)).toEqual([
      "Low: summary",
      "High: inline",
      "Middle: inline",
      "Outside a hunk: summary",
      "Scored for the summary: summary",
    ]);

    expect(plan.lineComments.map((comment) => comment.startLine)).toEqual([22, 6]);

    expect(plan.summary.body.match(/^### .*$/gm)).toEqual([
      "### Outside a hunk",
      "### Low",
      "### Scored for the summary",
    ]);

    expect(plan.counts).toEqual({ inline: 2, summary: 3, duplicate: 0, stored: 0 });
  });

  test("a finding that cannot sit on its lines takes no place of the limit", () => {
    const plan = planner.plan(planInput(findings, { maxInlineComments: 3 }));

    expect(plan.lineComments.map((comment) => comment.startLine)).toEqual([22, 6, 4]);
  });

  test("with the limit 0 every finding goes to the summary", () => {
    const plan = planner.plan(planInput(findings, { maxInlineComments: 0 }));

    expect(plan.lineComments).toEqual([]);
    expect(plan.findings.every((planned) => planned.action === "summary")).toBe(true);
    expect(plan.summary.body).toContain("Line comments in this run: 0.\n\n### Outside a hunk");
  });

  test("equal scores are ordered by the file, then the first line, then the title", () => {
    const equal = [
      finding({ title: "b title", file: "src/a.ts", start_line: 22, end_line: 22 }),
      finding({ title: "a title", file: "src/a.ts", start_line: 22, end_line: 22 }),
      finding({ title: "z title", file: "src/a.ts", start_line: 4, end_line: 4 }),
      finding({ title: "y title", file: "src/added.ts", start_line: 1, end_line: 1 }),
      finding({ title: "x title", file: "src/Zed.ts", start_line: 1, end_line: 1, action: "summary" }),
      finding({ title: "higher", file: "src/new name.ts", start_line: 1, end_line: 1, score: 70.01 }),
    ];

    const plan = planner.plan(planInput(equal, { maxInlineComments: 3 }));

    expect(actions(plan.findings)).toEqual([
      "b title: summary",
      "a title: inline",
      "z title: inline",
      "y title: summary",
      "x title: summary",
      "higher: inline",
    ]);

    expect(plan.lineComments.map((comment) => `${comment.file}:${comment.startLine}`)).toEqual([
      "src/new name.ts:1",
      "src/a.ts:4",
      "src/a.ts:22",
    ]);

    expect(plan.summary.body.match(/^### .*$/gm)).toEqual(["### x title", "### b title", "### y title"]);
  });

  test("a limit that is no count is refused", () => {
    expect(() => planner.plan(planInput([], { maxInlineComments: -1 }))).toThrow("not a count of line comments: -1");
    expect(() => planner.plan(planInput([], { maxInlineComments: 1.5 }))).toThrow("not a count of line comments: 1.5");
  });
});

describe("comment planner: the same input gives the same plan", () => {
  const findings = [
    finding({ title: "One", start_line: 4, end_line: 4, score: 90 }),
    finding({ title: "Two", start_line: 22, end_line: 22, score: 90 }),
    finding({ title: "Three", start_line: 6, end_line: 6, score: 90 }),
    finding({ title: "Four", file: "src/untouched.ts", score: 75 }),
    finding({ title: "Five", start_line: 24, end_line: 24, score: 45, action: "summary" }),
    finding({ title: "Six", start_line: 25, end_line: 25, score: 45, action: "summary" }),
    finding({ title: "Seven", score: 10, action: "stored" }),
    unjudged({ title: "Eight" }),
    finding({ title: "Nine", file: "src/added.ts", start_line: 1, end_line: 1, score: 88 }),
  ];

  const input = planInput(findings, {
    maxInlineComments: 2,
    written: [writtenLine("src/added.ts", 1, 1)],
    partialReason: "time_budget",
  });

  test("a second run gives an equal plan", () => {
    expect(planner.plan(input)).toEqual(planner.plan(input));
    expect(JSON.stringify(planner.plan(input))).toBe(JSON.stringify(planner.plan(planInput(findings, input))));
  });

  test("the order the findings come in changes neither the comments nor an action, only the order of the findings", () => {
    const plan = planner.plan(input);

    const reversed = planner.plan({
      ...input,
      findings: [...findings].reverse(),
      written: [...input.written].reverse(),
    });

    const rotated = planner.plan({ ...input, findings: [...findings.slice(4), ...findings.slice(0, 4)] });

    for (const other of [reversed, rotated]) {
      expect(other.lineComments).toEqual(plan.lineComments);
      expect(other.summary).toEqual(plan.summary);
      expect(other.counts).toEqual(plan.counts);
      expect(actions(other.findings).sort()).toEqual(actions(plan.findings).sort());
    }

    expect(actions(plan.findings)).toEqual([
      "One: inline",
      "Two: summary",
      "Three: inline",
      "Four: summary",
      "Five: summary",
      "Six: summary",
      "Seven: stored",
      "Eight: stored",
      "Nine: suppressed_duplicate",
    ]);

    expect(actions(reversed.findings)).toEqual(actions(plan.findings).reverse());
    expect(plan.counts).toEqual({ inline: 2, summary: 4, duplicate: 1, stored: 2 });
  });

  test("every finding has exactly one action and is written at most once", () => {
    const plan = planner.plan(input);
    const { inline, summary, duplicate, stored } = plan.counts;

    expect(plan.findings.length).toBe(findings.length);
    expect(inline + summary + duplicate + stored).toBe(findings.length);
    expect(plan.lineComments.length).toBe(inline);
    expect(plan.summary.body.match(/^### /gm)?.length).toBe(summary);

    for (const title of ["Seven", "Eight", "Nine"]) expect(plan.summary.body).not.toContain(`### ${title}`);
  });
});

describe("comment planner: the summary of a review", () => {
  test("a partial review says so with its reason, and still lists its findings", () => {
    const plan = planner.plan(planInput([finding({ score: 40, action: "summary" })], { partialReason: "time_budget" }));

    expect(plan.summary.body).toContain(
      "\n\n**Partial review:** the review stopped early (`time_budget`), so it may have missed findings.\n\n### Division",
    );

    expect(planner.plan(planInput([])).summary.body).not.toContain("Partial review");
  });

  test("the comment language tr gives the Turkish texts, every other the English ones", () => {
    for (const language of ["tr", "tr-TR"]) {
      const plan = planner.plan(planInput([finding()], { language }));

      expect(plan.lineComments[0]?.body).toContain(
        `\n\n**Düzeltme:** Check b before dividing.\n\n${TURKISH_NOTE}\n<!--`,
      );

      expect(plan.summary.body).toStartWith("## Kerpeten incelemesi\n\nİncelenen commit: ");
    }

    for (const language of ["en", "de", "pt-BR"]) {
      const plan = planner.plan(planInput([finding()], { language }));

      expect(plan.lineComments[0]?.body).toContain(`\n\n**Fix:** Check b before dividing.\n\n${NOTE}\n<!--`);
      expect(plan.summary.body).toStartWith("## Kerpeten review\n\nReviewed commit ");
    }
  });

  test("a commit that is no commit id is refused", () => {
    expect(() => planner.plan(planInput([], { headSha: "main" }))).toThrow("a commit of 40 hex characters");
  });
});

describe("comment planner: the plan after the comments were written", () => {
  const first = finding({ title: "First", score: 90 });
  const second = finding({ title: "Second", start_line: 22, end_line: 23, score: 80 });
  const third = finding({ title: "Third", file: "src/added.ts", start_line: 1, end_line: 2, score: 70 });
  const listed = finding({ title: "Listed", start_line: 4, end_line: 4, score: 40, action: "summary" });
  const low = finding({ title: "Low", score: 15, action: "stored" });
  const before = planner.plan(planInput([third, low, first, listed, second, unjudged({ title: "Unjudged" })]));
  const basis = { headSha: HEAD, language: "en" };

  test("the plan before the write has its line comments in the order of their scores", () => {
    expect(before.lineComments.map((comment) => comment.startLine)).toEqual([6, 22, 1]);
  });

  test("a written finding keeps its line and carries the ref of its comment; a refused one goes to the summary; a failed one is stored", () => {
    const after = planner.afterLineComments({
      plan: before,
      results: [{ kind: "written", ref: REF }, { kind: "refused" }, { kind: "failed" }],
      ...basis,
    });

    expect(actions(after.findings)).toEqual([
      "Third: stored",
      "Low: stored",
      "First: inline",
      "Listed: summary",
      "Second: summary",
      "Unjudged: stored",
    ]);

    expect(after.findings.map((planned) => ("comment_ref" in planned ? planned.comment_ref : undefined))).toEqual([
      undefined,
      undefined,
      REF,
      undefined,
      undefined,
      undefined,
    ]);

    expect(after.lineComments).toEqual(before.lineComments.slice(0, 1).map((comment) => ({ ...comment, ref: REF })));
    expect(after.counts).toEqual({ inline: 1, summary: 2, duplicate: 0, stored: 3 });
  });

  test("the summary is written again: its count is the line comments that are really there, and it lists the refused finding by its score", () => {
    const after = planner.afterLineComments({
      plan: before,
      results: [{ kind: "written", ref: REF }, { kind: "refused" }, { kind: "failed" }],
      ...basis,
    });

    expect(before.summary.body).toContain("Line comments in this run: 3.");
    expect(before.summary.body).not.toContain("### Second");

    expect(after.summary.body).toContain(`Reviewed commit ${HEAD}. Line comments in this run: 1.`);
    expect(after.summary.body.match(/^### .*$/gm)).toEqual(["### Second", "### Listed"]);
    expect(after.summary.body).not.toContain("### Third");
    expect(after.summary.body).toEndWith(SUMMARY_MARKER);
    expect(after.summary.omitted).toBe(0);
  });

  test("when every line comment fails, the summary counts the findings and does not say that nothing was found", () => {
    for (const language of ["en", "tr"]) {
      const plan = planner.plan(planInput([first, second], { language }));

      const after = planner.afterLineComments({
        plan,
        results: [{ kind: "failed" }, { kind: "failed" }],
        headSha: HEAD,
        language,
      });

      expect(actions(after.findings)).toEqual(["First: stored", "Second: stored"]);
      expect(after.counts).toEqual({ inline: 0, summary: 0, duplicate: 0, stored: 2 });
      expect(after.summary.body).not.toContain("nothing to report");
      expect(after.summary.body).not.toContain("bir şey bulmadı");

      expect(after.summary.body).toContain(
        language === "en"
          ? "Line comments in this run: 0.\n\nFindings whose comment may be missing here, because writing it failed: 2. The output of the review run lists them.\n\n<!--"
          : "Bu çalıştırmadaki satır yorumları: 0.\n\nYazılması başarısız olduğu için yorumu burada eksik olabilecek bulgular: 2. İnceleme çalıştırmasının çıktısında listelenir.\n\n<!--",
      );
    }
  });

  test("a failed line comment is counted in the summary beside the ones that are written and refused, and a refused one is not", () => {
    const after = planner.afterLineComments({
      plan: before,
      results: [{ kind: "written", ref: REF }, { kind: "refused" }, { kind: "failed" }],
      ...basis,
    });

    expect(after.summary.body).toContain(
      "Line comments in this run: 1.\n\nFindings whose comment may be missing here, because writing it failed: 1. The output of the review run lists them.\n\nFindings that could not be checked, so they are not written here: 1. The output of the review run lists them.\n\n### Second",
    );

    const refused = planner.afterLineComments({
      plan: before,
      results: [{ kind: "written", ref: REF }, { kind: "refused" }, { kind: "refused" }],
      ...basis,
    });

    expect(refused.summary.body).not.toContain("may be missing");
  });

  test("when every line comment is written the actions and the summary text stay, and each finding has its own ref", () => {
    const refs = ["github:review_comment/1", "github:review_comment/2", "github:review_comment/3"];

    const after = planner.afterLineComments({
      plan: before,
      results: refs.map((ref) => ({ kind: "written" as const, ref })),
      ...basis,
    });

    expect(actions(after.findings)).toEqual(actions(before.findings));
    expect(after.summary).toEqual(before.summary);
    expect(after.counts).toEqual(before.counts);
    expect(after.lineComments.map((comment) => comment.ref)).toEqual(refs);

    const refOf = (title: string) => {
      const found = after.findings.find((planned) => planned.title === title);

      return found !== undefined && "comment_ref" in found ? found.comment_ref : undefined;
    };

    expect([refOf("First"), refOf("Second"), refOf("Third")]).toEqual(refs);
  });

  test("the language, the duplicates and the reason of a partial review are in the new summary as in the first", () => {
    const written = [writtenLine("src/a.ts", 22, 23)];
    const input = planInput([first, second], { written, language: "tr", partialReason: "time_budget" });
    const plan = planner.plan(input);

    const after = planner.afterLineComments({
      plan,
      results: [{ kind: "refused" }],
      headSha: HEAD,
      language: "tr",
      partialReason: "time_budget",
    });

    expect(after.summary.body).toStartWith("## Kerpeten incelemesi\n\nİncelenen commit: ");
    expect(after.summary.body).toContain("Bu çalıştırmadaki satır yorumları: 0. Satır yorumu zaten olan bulgular: 1.");
    expect(after.summary.body).toContain("**Kısmi inceleme:** inceleme erken durdu (`time_budget`)");
    expect(after.summary.body).toContain("### First");
    expect(after.counts).toEqual({ inline: 0, summary: 1, duplicate: 1, stored: 0 });
  });

  test("results that do not fit the plan are refused", () => {
    expect(() => planner.afterLineComments({ plan: before, results: [{ kind: "refused" }], ...basis })).toThrow(
      "a plan of 3 line comments got 1 results for 3 findings on lines",
    );

    const moved = { ...before, lineComments: [...before.lineComments].reverse() };
    const results = [{ kind: "refused" as const }, { kind: "refused" as const }, { kind: "refused" as const }];

    expect(() => planner.afterLineComments({ plan: moved, results, ...basis })).toThrow(
      "line comment 1 of the plan is not the one of its finding",
    );
  });

  test("a written summary gives its ref to every finding of the summary, and to no other", () => {
    const afterLines = planner.afterLineComments({
      plan: before,
      results: [{ kind: "written", ref: REF }, { kind: "refused" }, { kind: "failed" }],
      ...basis,
    });

    const after = planner.afterSummary(afterLines, SUMMARY_REF);

    expect(
      after.findings.map((planned) => [
        planned.title,
        planned.action,
        "comment_ref" in planned ? planned.comment_ref : undefined,
      ]),
    ).toEqual([
      ["Third", "stored", undefined],
      ["Low", "stored", undefined],
      ["First", "inline", REF],
      ["Listed", "summary", SUMMARY_REF],
      ["Second", "summary", SUMMARY_REF],
      ["Unjudged", "stored", undefined],
    ]);

    expect(after.summary).toEqual({ ...afterLines.summary, ref: SUMMARY_REF });
    expect(after.counts).toEqual(afterLines.counts);
    expect(after.lineComments).toEqual(afterLines.lineComments);
  });

  test("a summary that could not be written leaves its findings stored, without a ref, and the written line comments as they are", () => {
    const afterLines = planner.afterLineComments({
      plan: before,
      results: [{ kind: "written", ref: REF }, { kind: "refused" }, { kind: "failed" }],
      ...basis,
    });

    const after = planner.afterSummary(afterLines, undefined);

    expect(actions(after.findings)).toEqual([
      "Third: stored",
      "Low: stored",
      "First: inline",
      "Listed: stored",
      "Second: stored",
      "Unjudged: stored",
    ]);

    expect(after.findings.filter((planned) => "comment_ref" in planned).map((planned) => planned.title)).toEqual([
      "First",
    ]);

    expect(after.summary.ref).toBeUndefined();
    expect(after.counts).toEqual({ inline: 1, summary: 0, duplicate: 0, stored: 5 });
  });

  test("a finding the summary text leaves out for its length gets no ref and is stored; the ones it shows carry the ref", () => {
    const long = "x".repeat(9_000);
    const titles = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

    const many = titles.map((title, index) =>
      finding({
        title,
        body: `${title} ${long}`,
        start_line: index + 1,
        end_line: index + 1,
        score: 49 - index,
        action: "summary",
      }),
    );

    const plan = planner.afterLineComments({
      plan: planner.plan(planInput([...many].reverse())),
      results: [],
      ...basis,
    });

    const shown = titles.filter((title) => plan.summary.body.includes(`### ${title}\n`));
    const left = titles.slice(shown.length);

    expect(plan.summary.omitted).toBeGreaterThan(0);
    expect(shown.length).toBe(titles.length - plan.summary.omitted);
    expect(shown).toEqual(titles.slice(0, shown.length));

    expect(plan.summary.body).toContain(
      `Findings not shown here, because the comment would be too long: ${left.length}.`,
    );

    const after = planner.afterSummary(plan, SUMMARY_REF);
    const byTitle = new Map(after.findings.map((planned) => [planned.title, planned]));

    for (const title of shown) {
      expect(byTitle.get(title)).toMatchObject({ action: "summary", comment_ref: SUMMARY_REF });
    }

    for (const title of left) {
      expect(byTitle.get(title)?.action).toBe("stored");
      expect("comment_ref" in (byTitle.get(title) ?? {})).toBe(false);
    }

    expect(after.counts).toEqual({ inline: 0, summary: shown.length, duplicate: 0, stored: left.length });
    expect(after.summary).toEqual({ ...plan.summary, ref: SUMMARY_REF });
    expect(after.findings.map((planned) => planned.title)).toEqual([...titles].reverse());
  });

  test("a plan says for every finding whether it writes its text: on its lines, or in the summary when the text shows it", () => {
    expect(planner.writes(before)).toEqual([true, false, true, true, true, false]);

    expect(actions(before.findings)).toEqual([
      "Third: inline",
      "Low: stored",
      "First: inline",
      "Listed: summary",
      "Second: inline",
      "Unjudged: stored",
    ]);

    const long = "x".repeat(9_000);
    const titles = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

    const many = titles.map((title, index) =>
      finding({
        title,
        body: `${title} ${long}`,
        start_line: index + 1,
        end_line: index + 1,
        score: 49 - index,
        action: "summary",
      }),
    );

    const duplicate = finding({ title: "Duplicate", start_line: 22, end_line: 23 });
    const plan = planner.plan(planInput([...many, duplicate], { written: [writtenLine("src/a.ts", 22, 23)] }));
    const shown = titles.length - plan.summary.omitted;

    expect(plan.summary.omitted).toBeGreaterThan(0);
    expect(planner.writes(plan)).toEqual([...titles.map((_, index) => index < shown), false]);
    expect(planner.writes(planner.plan(planInput([])))).toEqual([]);
  });

  test("a review without findings has a summary to write, and nothing changes in its plan but the ref", () => {
    const empty = planner.plan(planInput([]));
    const afterLines = planner.afterLineComments({ plan: empty, results: [], ...basis });

    expect(afterLines).toEqual(empty);

    expect(planner.afterSummary(afterLines, SUMMARY_REF)).toEqual({
      ...empty,
      summary: { body: NOTHING, omitted: 0, ref: SUMMARY_REF },
    });
  });
});
