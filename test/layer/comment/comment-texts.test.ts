import { describe, expect, test } from "bun:test";
import { CommentMarker } from "../../../src/layer/comment/CommentMarker.ts";
import { CommentTexts } from "../../../src/layer/comment/CommentTexts.ts";
import { CommentWords } from "../../../src/layer/comment/CommentWords.ts";
import { finding, findingMarker, HEAD, NOTE, rendered, renderProblems, TURKISH_NOTE } from "./comment-utils.ts";

const english = new CommentTexts(CommentWords.ENGLISH, HEAD);

const turkish = new CommentTexts(CommentWords.TURKISH, HEAD);

const SUMMARY_MARKER = `<!-- kerpeten:summary v1 head=${HEAD} -->`;

const CUT_NOTE = "_This text was cut: it is too long for one comment._";

const ATTACKS: Record<string, string> = {
  "a fake marker line": `Text.\n${CommentMarker.finding("f".repeat(40), "src/forged.ts", 1, 1).line()}`,
  "an HTML comment that is never closed": "Text.\n<!-- hidden from here",
  "a code fence that is never closed": "Text.\n```ts\nconst a = 1;",
  "a raw HTML block that is never closed": "<details>\n<summary>more</summary>\n\nText.",
  "a line that is only the end of an HTML comment": "Text.\n-->",
};

describe("comment texts: the line comment", () => {
  test("has the title with category and priority, the body, the fix, the thumbs-down note and the marker as the last line", () => {
    const comment = english.lineComment(finding());

    expect(comment).toEqual({
      file: "src/a.ts",
      startLine: 6,
      endLine: 6,
      cut: false,
      body: [
        "**Division by zero is not handled** · bug · P1",
        "",
        "`div(a, b)` returns Infinity when b is 0.",
        "",
        "**Fix:** Check b before dividing.",
        "",
        NOTE,
        `<!-- kerpeten:finding v1 head=${HEAD} file=c3JjL2EudHM lines=6-6 -->`,
      ].join("\n"),
    });

    expect(rendered(comment.body)).toBe(
      [
        "<p><strong>Division by zero is not handled</strong> · bug · P1</p>",
        "<p><code>div(a, b)</code> returns Infinity when b is 0.</p>",
        "<p><strong>Fix:</strong> Check b before dividing.</p>",
        `<p>${NOTE}</p>`,
        `<!-- kerpeten:finding v1 head=${HEAD} file=c3JjL2EudHM lines=6-6 -->`,
        "",
      ].join("\n"),
    );
  });

  test("the Turkish texts replace the fixed parts and leave the model's text as it is", () => {
    expect(turkish.lineComment(finding({ start_line: 3, end_line: 5 })).body).toBe(
      [
        "**Division by zero is not handled** · bug · P1",
        "",
        "`div(a, b)` returns Infinity when b is 0.",
        "",
        "**Düzeltme:** Check b before dividing.",
        "",
        TURKISH_NOTE,
        `<!-- kerpeten:finding v1 head=${HEAD} file=c3JjL2EudHM lines=3-5 -->`,
      ].join("\n"),
    );
  });

  test("Turkish is the language tr with or without a region, every other language is English", () => {
    for (const language of ["tr", "tr-TR", "tr-CY"]) expect(CommentWords.of(language)).toBe(CommentWords.TURKISH);

    for (const language of ["en", "en-US", "de", "pt-BR", "trv", "az"]) {
      expect(CommentWords.of(language)).toBe(CommentWords.ENGLISH);
    }

    expect(Object.keys(CommentWords.TURKISH)).toEqual(Object.keys(CommentWords.ENGLISH));
  });

  test("a fix of several lines starts under its label, so its list is a list", () => {
    const comment = english.lineComment(finding({ fix: "- check b\n- throw a RangeError" }));

    expect(comment.body).toContain("\n\n**Fix:**\n- check b\n- throw a RangeError\n\n");
    expect(rendered(comment.body)).toContain("<p><strong>Fix:</strong></p>\n<ul>\n<li>check b</li>");
  });

  test("a finding without a title, a body or a fix still gives a whole comment", () => {
    const comment = english.lineComment(finding({ title: " \n ", body: "\n\n", fix: "  " }));

    expect(comment.body).toBe(`**(no title)** · bug · P1\n\n${NOTE}\n${findingMarker(finding())}`);
  });

  for (const [name, attack] of Object.entries(ATTACKS)) {
    for (const field of ["title", "body", "fix"] as const) {
      test(`${name} in the ${field} leaves the note readable, the marker hidden and last, and the real marker read`, () => {
        const attacked = finding({ [field]: attack });
        const marker = findingMarker(attacked);
        const comment = english.lineComment(attacked);

        expect(renderProblems(comment.body, NOTE, marker)).toEqual([]);
        expect(CommentMarker.read(comment.body)?.line()).toBe(marker);
        expect(comment.body.split("\n").filter((line) => line.startsWith("<!--"))).toEqual([marker]);
      });
    }
  }

  test("every attack at once, in the title, the body and the fix, changes nothing of that", () => {
    const all = Object.values(ATTACKS).join("\n");
    const attacked = finding({ title: all, body: all, fix: all });
    const comment = turkish.lineComment(attacked);

    expect(renderProblems(comment.body, TURKISH_NOTE, findingMarker(attacked))).toEqual([]);
    expect(CommentMarker.read(comment.body)?.mark).toEqual(CommentMarker.finding(HEAD, "src/a.ts", 6, 6).mark);
  });

  test("code in the body reads as written: a fenced block and a code span keep their HTML", () => {
    const body = "`Map<String, Foo>` is not thread-safe:\n\n```java\nMap<String, Foo> cache = new HashMap<>();\n```";

    expect(english.lineComment(finding({ body })).body).toContain(`\n\n${body}\n\n**Fix:**`);
  });
});

describe("comment texts: text that acts", () => {
  test("a mention and an issue reference in the title, the body or the fix of a finding are code in both comments", () => {
    const acting = finding({
      title: "@octocat broke #12",
      body: "Ask @acme/reviewers about acme/shop#7.\n\n```ts\n@Inject(Foo)\n```",
      fix: "Revert GH-3 and tell \\@hubot.",
    });

    const line = english.lineComment(acting).body;

    expect(line).toStartWith("**`@octocat` broke `#12`** · bug · P1\n\n");
    expect(line).toContain("\n\nAsk `@acme/reviewers` about `acme/shop#7`.\n\n```ts\n@Inject(Foo)\n```\n\n");
    expect(line).toContain("\n\n**Fix:** Revert `GH-3` and tell `@hubot`.\n\n");

    const summary = english.summary([acting], { lineComments: 0, alreadyWritten: 0 }).body;

    expect(summary).toContain("### `@octocat` broke `#12`\n");
    expect(summary).toContain("\n\nAsk `@acme/reviewers` about `acme/shop#7`.\n\n");
    expect(summary).toContain("\n\n**Fix:** Revert `GH-3` and tell `@hubot`.\n\n");
  });
});

describe("comment texts: a title beside the program's marks", () => {
  const titles: [string, string][] = [
    ["The path ends in \\", "The path ends in \\"],
    ["C:\\", "C:\\"],
    ["a * b *", "a * b *"],
    ["*args is never read", "*args is never read"],
    ["fix issue #", "fix issue #"],
  ];

  for (const [title, shown] of titles) {
    test(`the title ${JSON.stringify(title)} is bold in the line comment and whole in the summary`, () => {
      const odd = finding({ title });
      const comment = english.lineComment(odd);
      const summary = english.summary([odd], { lineComments: 0, alreadyWritten: 0 });

      expect(rendered(comment.body)).toStartWith(`<p><strong>${shown}</strong> · bug · P1</p>\n`);
      expect(renderProblems(comment.body, NOTE, findingMarker(odd))).toEqual([]);
      expect(rendered(summary.body)).toContain(`<h3>${shown}</h3>\n<p><code>src/a.ts:6</code> · bug · P1</p>\n`);
      expect(summary.body.split("\n").at(-1)).toBe(SUMMARY_MARKER);
    });
  }

  test("a title cut right after a backslash stays bold, with the mark of the cut", () => {
    const long = finding({ title: `${"a".repeat(CommentTexts.MAX_TITLE - 1)}\\${"b".repeat(50)}` });
    const comment = english.lineComment(long);

    expect(comment.cut).toBe(true);

    expect(rendered(comment.body)).toStartWith(
      `<p><strong>${"a".repeat(CommentTexts.MAX_TITLE - 1)}\\…</strong> · bug · P1</p>\n`,
    );
  });

  test("a title that is only a backslash is shown as one", () => {
    expect(english.lineComment(finding({ title: "\\" })).body).toStartWith("**\\\\** · bug · P1\n");
  });
});

describe("comment texts: the length limit", () => {
  test("a body that is too long is cut with a note, and the fix, the thumbs-down note and the marker stay whole", () => {
    const long = finding({ body: "word ".repeat(20_000) });
    const comment = english.lineComment(long);

    expect(comment.cut).toBe(true);
    expect(comment.body.length).toBeLessThanOrEqual(CommentTexts.MAX_COMMENT);
    expect(comment.body.length).toBeGreaterThan(CommentTexts.MAX_COMMENT - 10);

    expect(
      comment.body.endsWith(`\n\n${CUT_NOTE}\n\n**Fix:** Check b before dividing.\n\n${NOTE}\n${findingMarker(long)}`),
    ).toBe(true);

    expect(comment.body).toStartWith("**Division by zero is not handled** · bug · P1\n\nword word word");

    expect(CommentMarker.read(comment.body)?.line()).toBe(findingMarker(long));
  });

  test("a body cut inside a code block has the block closed before the note", () => {
    const long = finding({ body: `Look:\n\n\`\`\`ts\n${"const a = '<details>';\n".repeat(5000)}` });
    const comment = english.lineComment(long);

    expect(comment.cut).toBe(true);
    expect(comment.body.length).toBeLessThanOrEqual(CommentTexts.MAX_COMMENT);
    expect(comment.body).toContain(`\n\`\`\`\n\n${CUT_NOTE}\n\n**Fix:**`);
    expect(renderProblems(comment.body, NOTE, findingMarker(long))).toEqual([]);
  });

  test("a text that grows when it is made safe still fits", () => {
    for (const piece of ["<b>", "` ", "<!--\n", "```\n"]) {
      const long = finding({ body: piece.repeat(40_000), fix: piece.repeat(40_000), title: piece.repeat(400) });
      const comment = english.lineComment(long);

      expect(comment.cut).toBe(true);
      expect(comment.body.length).toBeLessThanOrEqual(CommentTexts.MAX_COMMENT);
      expect(comment.body.endsWith(`\n\n${NOTE}\n${findingMarker(long)}`)).toBe(true);
      expect(renderProblems(comment.body, NOTE, findingMarker(long))).toEqual([]);
    }
  });

  test("a fix that is too long is cut with a note and a title that is too long ends with …", () => {
    const long = finding({ fix: "do ".repeat(10_000), title: `T${"itle ".repeat(100)}` });
    const comment = english.lineComment(long);
    const [first = ""] = comment.body.split("\n");

    expect(comment.cut).toBe(true);
    expect(first.endsWith("…** · bug · P1")).toBe(true);
    expect(first.length).toBe(CommentTexts.MAX_TITLE + "****… · bug · P1".length);
    expect(comment.body).toContain(` do d\n\n${CUT_NOTE}\n\n${NOTE}`);

    const fix = comment.body.slice(comment.body.indexOf("**Fix:**"), comment.body.indexOf(`\n\n${NOTE}`));

    expect(fix.length).toBeLessThanOrEqual(CommentTexts.MAX_FIX);
    expect(fix.length).toBeGreaterThan(CommentTexts.MAX_FIX - 10);
  });

  test("a surrogate pair is not cut in two", () => {
    const comment = english.lineComment(finding({ body: "😀".repeat(40_000) }));

    expect(comment.body.isWellFormed()).toBe(true);
    expect(comment.body.length).toBeLessThanOrEqual(CommentTexts.MAX_COMMENT);
  });

  test("a path so long that the marker leaves no room is an error, not a cut marker", () => {
    const huge = finding({ file: `src/${"deep/".repeat(12_000)}a.ts` });

    expect(() => english.lineComment(huge)).toThrow("a comment has no room for the text of its finding");
  });
});

describe("comment texts: the summary comment", () => {
  test("has the heading, the commit with the count of line comments, each finding and the marker as the last line", () => {
    const summary = english.summary(
      [
        finding({ start_line: 3, end_line: 5, score: 50, action: "summary" }),
        finding({ file: "src/b_c.ts", title: "Second", category: "security", priority: "P2", body: "", score: 30 }),
      ],
      { lineComments: 2, alreadyWritten: 0 },
    );

    expect(summary).toEqual({
      omitted: 0,
      body: [
        "## Kerpeten review",
        "",
        `Reviewed commit ${HEAD}. Line comments in this run: 2.`,
        "",
        "### Division by zero is not handled",
        "`src/a.ts:3-5` · bug · P1",
        "",
        "`div(a, b)` returns Infinity when b is 0.",
        "",
        "**Fix:** Check b before dividing.",
        "",
        "### Second",
        "`src/b_c.ts:6` · security · P2",
        "",
        "**Fix:** Check b before dividing.",
        "",
        SUMMARY_MARKER,
      ].join("\n"),
    });

    expect(rendered(summary.body)).toContain(
      "<h3>Second</h3>\n<p><code>src/b_c.ts:6</code> · security · P2</p>\n<p><strong>Fix:</strong> Check b before dividing.</p>\n<!-- kerpeten:summary",
    );
  });

  test("with nothing to list, nothing on a line and nothing already written it says that nothing was found", () => {
    expect(english.summary([], { lineComments: 0, alreadyWritten: 0 }).body).toBe(
      [
        "## Kerpeten review",
        `Reviewed commit ${HEAD}. Line comments in this run: 0.`,
        "The review found nothing to report.",
        SUMMARY_MARKER,
      ].join("\n\n"),
    );

    expect(turkish.summary([], { lineComments: 0, alreadyWritten: 0 }).body).toBe(
      [
        "## Kerpeten incelemesi",
        `İncelenen commit: ${HEAD}. Bu çalıştırmadaki satır yorumları: 0.`,
        "İnceleme bildirilecek bir şey bulmadı.",
        SUMMARY_MARKER,
      ].join("\n\n"),
    );
  });

  test("with line comments or findings already written it does not say that nothing was found", () => {
    expect(english.summary([], { lineComments: 3, alreadyWritten: 0 }).body).toBe(
      ["## Kerpeten review", `Reviewed commit ${HEAD}. Line comments in this run: 3.`, SUMMARY_MARKER].join("\n\n"),
    );

    expect(english.summary([], { lineComments: 0, alreadyWritten: 2 }).body).toBe(
      [
        "## Kerpeten review",
        `Reviewed commit ${HEAD}. Line comments in this run: 0. Findings that already had a line comment: 2.`,
        SUMMARY_MARKER,
      ].join("\n\n"),
    );

    expect(turkish.summary([], { lineComments: 1, alreadyWritten: 2 }).body).toContain(
      "Bu çalıştırmadaki satır yorumları: 1. Satır yorumu zaten olan bulgular: 2.",
    );
  });

  test("findings whose comment failed to be written are counted, and the summary never says that nothing was found beside them", () => {
    expect(english.summary([], { lineComments: 0, alreadyWritten: 0, unwritten: 2 }).body).toBe(
      [
        "## Kerpeten review",
        `Reviewed commit ${HEAD}. Line comments in this run: 0.`,
        "Findings whose comment may be missing here, because writing it failed: 2. The output of the review run lists them.",
        SUMMARY_MARKER,
      ].join("\n\n"),
    );

    expect(turkish.summary([], { lineComments: 0, alreadyWritten: 0, unwritten: 1 }).body).toBe(
      [
        "## Kerpeten incelemesi",
        `İncelenen commit: ${HEAD}. Bu çalıştırmadaki satır yorumları: 0.`,
        "Yazılması başarısız olduğu için yorumu burada eksik olabilecek bulgular: 1. İnceleme çalıştırmasının çıktısında listelenir.",
        SUMMARY_MARKER,
      ].join("\n\n"),
    );

    const listed = english.summary([finding()], { lineComments: 1, alreadyWritten: 0, unwritten: 1 }).body;

    expect(listed).toContain(
      "Line comments in this run: 1.\n\nFindings whose comment may be missing here, because writing it failed: 1. The output of the review run lists them.\n\n### Division",
    );

    expect(english.summary([], { lineComments: 0, alreadyWritten: 0, unwritten: 0 }).body).toContain(
      "The review found nothing to report.",
    );
  });

  test("findings the judge could not judge are counted, and the summary never says that nothing was found beside them", () => {
    expect(english.summary([], { lineComments: 0, alreadyWritten: 0, unjudged: 2 }).body).toBe(
      [
        "## Kerpeten review",
        `Reviewed commit ${HEAD}. Line comments in this run: 0.`,
        "Findings that could not be checked, so they are not written here: 2. The output of the review run lists them.",
        SUMMARY_MARKER,
      ].join("\n\n"),
    );

    expect(turkish.summary([], { lineComments: 0, alreadyWritten: 0, unjudged: 1 }).body).toBe(
      [
        "## Kerpeten incelemesi",
        `İncelenen commit: ${HEAD}. Bu çalıştırmadaki satır yorumları: 0.`,
        "Doğrulanamadığı için buraya yazılmayan bulgular: 1. İnceleme çalıştırmasının çıktısında listelenir.",
        SUMMARY_MARKER,
      ].join("\n\n"),
    );

    const both = english.summary([finding()], { lineComments: 1, alreadyWritten: 0, unwritten: 1, unjudged: 3 }).body;

    expect(both).toContain(
      "Line comments in this run: 1.\n\nFindings whose comment may be missing here, because writing it failed: 1. The output of the review run lists them.\n\nFindings that could not be checked, so they are not written here: 3. The output of the review run lists them.\n\n### Division",
    );

    expect(english.summary([], { lineComments: 0, alreadyWritten: 0, unjudged: 0 }).body).toContain(
      "The review found nothing to report.",
    );
  });

  test("a partial review is said with its reason, in both languages", () => {
    const facts = { lineComments: 0, alreadyWritten: 0, partialReason: "time_budget" };

    expect(english.summary([], facts).body).toBe(
      [
        "## Kerpeten review",
        `Reviewed commit ${HEAD}. Line comments in this run: 0.`,
        "**Partial review:** the review stopped early (`time_budget`), so it may have missed findings.",
        "The review found nothing to report.",
        SUMMARY_MARKER,
      ].join("\n\n"),
    );

    expect(turkish.summary([finding()], facts).body).toContain(
      "\n\n**Kısmi inceleme:** inceleme erken durdu (`time_budget`); gözden kaçan bulgular olabilir.\n\n### Division",
    );
  });

  for (const [name, attack] of Object.entries(ATTACKS)) {
    test(`${name} in every text of a finding leaves the next finding and the marker as they are`, () => {
      const summary = english.summary(
        [finding({ title: attack, body: attack, fix: attack }), finding({ title: "The next finding", fix: "Fixed." })],
        { lineComments: 0, alreadyWritten: 0 },
      );

      const html = rendered(summary.body);

      expect(html.endsWith(`<p><strong>Fix:</strong> Fixed.</p>\n${SUMMARY_MARKER}\n`)).toBe(true);
      expect(html).toContain("<h3>The next finding</h3>\n<p><code>src/a.ts:6</code> · bug · P1</p>");
      expect(html.slice(0, -SUMMARY_MARKER.length - 1)).not.toContain("<!--");
      expect(html).not.toMatch(/<\/?(details|summary)/);
      expect(CommentMarker.read(summary.body)?.mark).toEqual({ kind: "summary", version: 1, headSha: HEAD });
    });
  }

  test("a summary that would be too long lists the findings that fit, in order, and says how many it does not show", () => {
    const listed = Array.from({ length: 40 }, (_, index) =>
      finding({ title: `Finding ${index + 1}`, body: "word ".repeat(600), action: "summary" }),
    );

    const summary = english.summary(listed, { lineComments: 0, alreadyWritten: 0 });
    const shown = listed.length - summary.omitted;

    expect(summary.omitted).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(10);
    expect(summary.body.length).toBeLessThanOrEqual(CommentTexts.MAX_COMMENT);

    expect([...(summary.body.match(/^### Finding \d+$/gm) ?? [])]).toEqual(
      Array.from({ length: shown }, (_, index) => `### Finding ${index + 1}`),
    );

    expect(
      summary.body.endsWith(
        `\n\nFindings not shown here, because the comment would be too long: ${summary.omitted}.\n\n${SUMMARY_MARKER}`,
      ),
    ).toBe(true);

    const oneMore = [...listed.slice(0, shown + 1)];

    expect(english.summary(oneMore, { lineComments: 0, alreadyWritten: 0 }).omitted).toBeGreaterThan(0);
    expect(english.summary(listed.slice(0, shown), { lineComments: 0, alreadyWritten: 0 }).omitted).toBe(0);

    expect(turkish.summary(listed, { lineComments: 0, alreadyWritten: 0 }).body).toContain(
      "\n\nYorum çok uzun olacağı için burada gösterilmeyen bulgular: ",
    );
  });

  test("a finding whose body is too long is cut inside the summary, and the findings after it are still listed", () => {
    const summary = english.summary(
      [finding({ title: "Huge", body: "word ".repeat(30_000) }), finding({ title: "Small" })],
      { lineComments: 0, alreadyWritten: 0 },
    );

    expect(summary.omitted).toBe(0);
    expect(summary.body.length).toBeLessThan(CommentTexts.MAX_SUMMARY_BODY + CommentTexts.MAX_FIX);
    expect(summary.body).toContain(` word w\n\n${CUT_NOTE}\n\n**Fix:** Check b before dividing.\n\n### Small\n`);
  });

  test("a commit that is no commit id is refused before any text is written", () => {
    expect(() => new CommentTexts(CommentWords.ENGLISH, "HEAD")).toThrow("a commit of 40 hex characters");
  });
});
