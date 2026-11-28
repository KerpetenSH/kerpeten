import { describe, expect, test } from "bun:test";
import { SafeMarkdown } from "../../../src/layer/comment/SafeMarkdown.ts";
import { rendered, renderProblems } from "./comment-utils.ts";

const NOTE = "The note stays readable.";

const MARKER = "<!-- kerpeten:finding v1 head=x -->";

const PIECES = [
  "```",
  "~~~",
  "`",
  "``",
  "````",
  "<details>",
  "</details>",
  "<!--",
  "-->",
  "\n",
  "\n",
  "\n\n",
  "    ",
  "  ",
  " ",
  "- ",
  "> ",
  "1. ",
  "text",
  "\\",
  "<pre>",
  "<![CDATA[",
  "<?php",
  "|",
  "\t",
  "<div",
  "<s>",
  "<x-raw",
  "js",
  MARKER,
  "<https://a.b/c>",
  "<a@b.c>",
  "<",
  "*",
  "_",
  "#",
  "[",
  "](",
  ")",
  "&lt;",
  "<script>",
  "<!DOCTYPE",
  "---",
  "===",
  "<summary>",
  "<table><tr><td>",
  "\r\n",
  "\0",
  "@octocat",
  "@acme/reviewers",
  "#12",
  "acme/shop#12",
  "GH-12",
  "\\@octocat",
  "&#64;octocat",
  "&#35;12",
];

/** A comment whose body and fix are `text`, made safe, followed by a note and a marker. */
function comment(text: string): string {
  return `**Title** · bug\n\n${SafeMarkdown.block(text)}\n\n${SafeMarkdown.block(`**Fix:** ${text}`)}\n\n${NOTE}\n${MARKER}`;
}

describe("safe markdown: what it changes", () => {
  test("text without HTML and with whole code spans stays as it is", () => {
    const text = [
      "`div(a, b)` returns `Infinity` when b is 0, so `Array<string>` and ``a ` b`` break.",
      "",
      "- a list with a < b and x <",
      "- **bold**, _emphasis_ and [a link](https://example.com)",
      "",
      "> a quote",
    ].join("\n");

    expect(SafeMarkdown.block(text)).toBe(text);
  });

  test("a fenced code block stays as it is, with the HTML inside it", () => {
    const text = "Before.\n\n```html\n<details>\n<!-- a comment\n<div>`open\n```\n\nAfter.";

    expect(SafeMarkdown.block(text)).toBe(text);

    expect(rendered(SafeMarkdown.block(text))).toContain(
      "&lt;details&gt;\n&lt;!-- a comment\n&lt;div&gt;`open\n</code>",
    );
  });

  test("a < that could start HTML gets a backslash outside code, and reads the same", () => {
    expect(SafeMarkdown.block("Use List<String> or <details>, not <!-- this.")).toBe(
      "Use List\\<String> or \\<details>, not \\<!-- this.",
    );

    expect(rendered(SafeMarkdown.block("Use List<String> or <details>, not <!-- this."))).toBe(
      "<p>Use List&lt;String&gt; or &lt;details&gt;, not &lt;!-- this.</p>\n",
    );
  });

  test("a < that is escaped already, a < before a space and a plain link stay as they are", () => {
    expect(SafeMarkdown.block("a \\<b> c")).toBe("a \\<b> c");
    expect(SafeMarkdown.block("a \\\\<b> c")).toBe("a \\\\\\<b> c");
    expect(SafeMarkdown.block("a < b and c <")).toBe("a < b and c <");
    expect(SafeMarkdown.block("see <https://example.com/a?b=1#c> here")).toBe("see <https://example.com/a?b=1#c> here");

    expect(SafeMarkdown.block("see <https://exa`mple.com> and <me@example.com>")).toBe(
      "see \\<https://exa\\`mple.com> and \\<me@example.com>",
    );
  });

  test("a backtick that closes no code span on its line gets a backslash, so it opens none on a later line", () => {
    expect(SafeMarkdown.block("an open ` tick\nand `<details>` here")).toBe("an open \\` tick\nand `<details>` here");
    expect(SafeMarkdown.block("two `` ticks ` one")).toBe("two \\`\\` ticks \\` one");
    expect(SafeMarkdown.block("escaped \\` and `code`")).toBe("escaped \\` and `code`");

    expect(rendered(SafeMarkdown.block("an open ` tick\nand `<details>` here"))).toBe(
      "<p>an open ` tick\nand <code>&lt;details&gt;</code> here</p>\n",
    );
  });

  test("a code block that is left open is closed with its own fence", () => {
    expect(SafeMarkdown.block("Look:\n```ts\nconst a = 1;")).toBe("Look:\n```ts\nconst a = 1;\n```");
    expect(SafeMarkdown.block("~~~~\ncode\n~~~")).toBe("~~~~\ncode\n~~~\n~~~~");
    expect(SafeMarkdown.block("````\n```\ninner\n```")).toBe("````\n```\ninner\n```\n````");
    expect(SafeMarkdown.block("```\ncode\n```")).toBe("```\ncode\n```");
  });

  test("an indented fence moves to the start of its line with the lines of its block", () => {
    expect(SafeMarkdown.block("1. Do this:\n   ```ts\n   const a = 1;\n     indented\n   ```\n2. Then that.")).toBe(
      "1. Do this:\n```ts\nconst a = 1;\n  indented\n```\n2. Then that.",
    );

    expect(SafeMarkdown.block("   ```\n      ```\n<details>")).toBe("```\n```\n\\<details>");
  });

  test("a line of backticks that is no fence is text", () => {
    expect(SafeMarkdown.block("``` a ` b\n<details>")).toBe("\\`\\`\\` a \\` b\n\\<details>");
    expect(SafeMarkdown.block("> ```\n> <details>\n> ```")).toBe("> \\`\\`\\`\n> \\<details>\n> \\`\\`\\`");
  });

  test("line ends are made one kind and a NUL character is replaced", () => {
    expect(SafeMarkdown.block("a\r\nb\rc\0d")).toBe("a\nb\nc\ufffdd");
  });

  test("text for a place inside a line is brought to one line and opens no code block", () => {
    expect(SafeMarkdown.line("  A title\nwith <b> and\n```\ncode ")).toBe("A title with \\<b> and \\`\\`\\` code");
    expect(SafeMarkdown.line("Use `Array<string>` here")).toBe("Use `Array<string>` here");
  });

  test("text for a place inside a line that ends in a backslash gets a second one, so it escapes nothing after it", () => {
    expect(SafeMarkdown.line("a path ends in \\")).toBe("a path ends in \\\\");
    expect(SafeMarkdown.line("\\")).toBe("\\\\");
    expect(SafeMarkdown.line("two \\\\")).toBe("two \\\\");
    expect(SafeMarkdown.line("three \\\\\\")).toBe("three \\\\\\\\");
    expect(SafeMarkdown.line("a \\ in the middle")).toBe("a \\ in the middle");
    expect(SafeMarkdown.line("ends in an escaped star \\*")).toBe("ends in an escaped star \\*");
  });

  test("a * at an end of text for a place inside a line, and a # at its end, get a backslash", () => {
    expect(SafeMarkdown.line("a * b *")).toBe("a * b \\*");
    expect(SafeMarkdown.line("*args is unused")).toBe("\\*args is unused");
    expect(SafeMarkdown.line("*")).toBe("\\*");
    expect(SafeMarkdown.line("fix issue #")).toBe("fix issue \\#");
    expect(SafeMarkdown.line("a backslash and a star \\\\*")).toBe("a backslash and a star \\\\\\*");
    expect(SafeMarkdown.line("code ends it `a*`")).toBe("code ends it `a*`");
    expect(SafeMarkdown.line("# is the first character")).toBe("# is the first character");
    expect(SafeMarkdown.line("")).toBe("");
  });

  const ENDS: [string, string][] = [
    ["a path ends in \\", "a path ends in \\"],
    ["C:\\", "C:\\"],
    ["\\", "\\"],
    ["three \\\\\\", "three \\\\"],
    ["a * b *", "a * b *"],
    ["*args is unused", "*args is unused"],
    ["use foo*", "use foo*"],
    ["*", "*"],
    ["**", "**"],
    ["fix issue #", "fix issue #"],
    ["a ## b ##", "a ## b ##"],
    ["use C#", "use C#"],
    ["ends in \\ and *", "ends in \\ and *"],
  ];

  for (const [title, shown] of ENDS) {
    test(`the title ${JSON.stringify(title)} shows whole between the program's bold marks and as a heading`, () => {
      const safe = SafeMarkdown.line(title);

      expect(rendered(`**${safe}** · bug · P1`)).toBe(`<p><strong>${shown}</strong> · bug · P1</p>\n`);

      expect(rendered(`### ${safe}\n\`src/a.ts:1\` · bug`)).toBe(
        `<h3>${shown}</h3>\n<p><code>src/a.ts:1</code> · bug</p>\n`,
      );
    });
  }

  test("the same titles without the treatment do lose the bold or a character", () => {
    expect(rendered("**a path ends in \\** · bug")).not.toContain("<strong>");
    expect(rendered("**a * b *** · bug")).not.toContain("<strong>");
    expect(rendered("### fix issue #\ntext")).toStartWith("<h3>fix issue</h3>");
  });

  test("a code span holds any text on one line", () => {
    expect(SafeMarkdown.code("src/a.ts:2-4")).toBe("`src/a.ts:2-4`");
    expect(SafeMarkdown.code("a`b``c")).toBe("```a`b``c```");
    expect(SafeMarkdown.code("`edge`")).toBe("`` `edge` ``");
    expect(SafeMarkdown.code("two\nlines")).toBe("`two lines`");
    expect(SafeMarkdown.code("")).toBe("");
    expect(rendered(SafeMarkdown.code("__init__.py <b> a`b"))).toBe("<p><code>__init__.py &lt;b&gt; a`b</code></p>\n");
  });
});

describe("safe markdown: text that acts", () => {
  /** What a reader sees of `text` outside code: the rendered HTML without its code spans and code blocks. */
  function outsideCode(text: string): string {
    return rendered(text).replace(/<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/g, "");
  }

  test("a mention of a user or a team goes into a code span, so it is shown as written and notifies nobody", () => {
    expect(SafeMarkdown.block("Ask @octocat and @acme/reviewers, cc @hubot.")).toBe(
      "Ask `@octocat` and `@acme/reviewers`, cc `@hubot`.",
    );

    expect(SafeMarkdown.block("@octocat wrote this\n(@octocat) é@octocat *@octocat*")).toBe(
      "`@octocat` wrote this\n(`@octocat`) é`@octocat` *`@octocat`*",
    );

    expect(SafeMarkdown.block("Use @Inject and @types/node and @scope/pkg-name.")).toBe(
      "Use `@Inject` and `@types/node` and `@scope/pkg-name`.",
    );

    expect(SafeMarkdown.block("_@octocat_ and x_@octocat")).toBe("_`@octocat`_ and x_`@octocat`");
  });

  test("a code span never touches another: a zero-width space stands between two that would", () => {
    expect(SafeMarkdown.block("@octocat@hubot")).toBe("`@octocat`\u200b`@hubot`");
    expect(SafeMarkdown.block("`a`@octocat```b```")).toBe("`a`\u200b`@octocat`\u200b```b```");
    expect(SafeMarkdown.block("`a` @octocat `b` and `c``d`")).toBe("`a` `@octocat` `b` and `c``d`");
  });

  test("an @ inside a word, as in a mail address, and one before a space mention nobody and stay", () => {
    for (const text of ["mail ada@example.com", "a @ b", "@", "price@100"]) {
      expect(SafeMarkdown.block(text)).toBe(text);
    }
  });

  test("a reference to an issue goes into a code span, with the repository or the user before it", () => {
    expect(SafeMarkdown.block("Fixes #12, see (#7) and #3.")).toBe("Fixes `#12`, see (`#7`) and `#3`.");

    expect(SafeMarkdown.block("See acme/shop#12, octocat#3 and GH-45.")).toBe(
      "See `acme/shop#12`, `octocat#3` and `GH-45`.",
    );

    expect(SafeMarkdown.block("acme/shop#12 a/b/c#12 x#1 gh-7 #1e90ff")).toBe(
      "`acme/shop#12` a/b/c`#12` `x#1` `gh-7` `#1e90ff`",
    );
  });

  test("a # that starts no number stays: a heading, a color name, an anchor", () => {
    for (const text of ["# Title", "## Two things", "color #fff", "see page#top", "C# and F#", "#"]) {
      expect(SafeMarkdown.block(text)).toBe(text);
    }
  });

  test("a backslash before the @ or the # hides nothing: it is dropped, and the text is code all the same", () => {
    expect(SafeMarkdown.block("cc \\@octocat and \\#12")).toBe("cc `@octocat` and `#12`");
    expect(SafeMarkdown.block("a \\\\@octocat")).toBe("a \\\\`@octocat`");
    expect(SafeMarkdown.block("a \\@ b \\# c")).toBe("a \\@ b \\# c");
  });

  test("a backslash right before a reference that starts with a letter gets a second one, so it cannot escape the backtick of the code span", () => {
    expect(SafeMarkdown.block("see \\GH-12 and \\acme/shop#12")).toBe("see \\\\`GH-12` and \\\\`acme/shop#12`");
    expect(SafeMarkdown.block("a \\\\GH-12 and \\\\\\GH-12")).toBe("a \\\\`GH-12` and \\\\\\\\`GH-12`");
    expect(rendered(SafeMarkdown.block("see \\GH-12"))).toBe("<p>see \\<code>GH-12</code></p>\n");
    expect(outsideCode(SafeMarkdown.block("see \\GH-12 and \\octocat#3"))).not.toMatch(/GH-12|octocat#3/);
    expect(outsideCode("see \\`GH-12`")).toMatch(/GH-12/);
  });

  test("a character reference that stands for @ or # gets a backslash, so it is shown as written", () => {
    expect(SafeMarkdown.block("&#64;octocat &#x40;octocat &#X0040;octocat &commat;octocat")).toBe(
      "\\&#64;octocat \\&#x40;octocat \\&#X0040;octocat \\&commat;octocat".replace("#64", "`#64`"),
    );

    expect(SafeMarkdown.block("&#35;12 &#x23;12 &num;12")).toBe("\\&`#35`;12 \\&#x23;12 \\&num;12");
  });

  test("a character reference that stands for another character stays whole and is shown as that character", () => {
    const text = "a &amp; b &lt; c &#65;&#66; &#8212; &#x41; &#0065;";

    expect(SafeMarkdown.block(text)).toBe(text);
    expect(rendered(SafeMarkdown.block(text))).toBe("<p>a &amp; b &lt; c AB — A A</p>\n");

    expect(SafeMarkdown.block("&#65;@octocat &#65;#12 &#65 #12 &#12345678;")).toBe(
      "&#65;`@octocat` &#65;`#12` &`#65` `#12` &`#12345678`;",
    );
  });

  test("the short form GH-12 is code after an underscore or a star of emphasis too, and inside a word it stays", () => {
    expect(SafeMarkdown.block("_GH-12_ __GH-12__ *GH-12* x_gh-7 (GH-3)")).toBe(
      "_`GH-12`_ __`GH-12`__ *`GH-12`* x_`gh-7` (`GH-3`)",
    );

    expect(SafeMarkdown.block("xGH-12 HIGH-12 9GH-1")).toBe("xGH-12 HIGH-12 9GH-1");
    expect(SafeMarkdown.block("_acme/shop#12_")).toBe("_acme/shop`#12`_");
  });

  test("inside code nothing changes: a code span, a fenced block and a plain link keep their @ and #", () => {
    const text = "`@octocat #12` and <https://example.com/@octocat#12>\n```ts\n@Inject(Foo) // #12 @octocat\n```";

    expect(SafeMarkdown.block(text)).toBe(text);
  });

  test("in a text that may hold a table a code span ends where its cell ends, so nothing acts from a cell that backticks of two cells seemed to make code", () => {
    const head = "| a | b | c |\n|---|---|---|\n";

    expect(SafeMarkdown.block(`${head}| \`x | @octocat\` | y |`)).toBe(`${head}| \\\`x | \`@octocat\`\\\` | y |`);

    expect(SafeMarkdown.block(`${head}| \`a\` | \`b \\| c\` | \`\`d\`\` |`)).toBe(
      `${head}| \`a\` | \`b \\| c\` | \`\`d\`\` |`,
    );

    const acting = /@octocat|(?<![&\w])#12\b|GH-12|<b>/;

    const rows = [
      "| `x | @octocat | y` |",
      "| `x | fixes #12 | y` |",
      "| ``x | GH-12 | y`` |",
      "| `x | <b>bold</b> | y` |",
      "| `a | b` c @octocat |",
      "| `a | b` c `@octocat` |",
      "| `a | b` `c` @octocat `d` |",
      "| `a` | `b | @octocat` | `c |",
      "| `x \\| @octocat \\| y` |",
      "| `x \\\\| @octocat` | y |",
      "`a | b` c @octocat | z",
    ];

    const tables = [
      (row: string) => `${head}${row}`,
      (row: string) => `a | b | c\n:-- | :-: | --:\n${row}`,
      (row: string) => `> a | b | c\n> ---|---|---\n> ${row}`,
      (row: string) => `- a | b | c\n  ---|---|---\n  ${row}`,
      (row: string) => `1. text\n\n   | a | b | c |\n   | - | - | - |\n   ${row}`,
      (row: string) => `${row}\n|---|---|---|\n${row}`,
    ];

    for (const row of rows) {
      for (const table of tables) {
        const text = table(row);

        expect({ text, shown: outsideCode(SafeMarkdown.block(text)).match(acting)?.[0] }).toEqual({
          text,
          shown: undefined,
        });
      }
    }

    expect(rendered(`${head}| \`a | b\` c \`@octocat\` |`)).toContain("<td>`a</td>");
    expect(outsideCode(`${head}| \`a | b\` c \`@octocat\` |`)).toMatch(acting);

    expect(rendered(SafeMarkdown.block(`${head}| \`cat x \\| grep y\` | z | w |`))).toContain(
      "<code>cat x | grep y</code>",
    );
  });

  test("in a text that holds no table a code span keeps its |, also with an @ or a # in it", () => {
    for (const text of [
      "run `cat x | grep y` and `a || b`",
      "`git log | grep #12` and `string | @octocat`",
      "a | b and `c | d`\n\n---\n\n- `e | f`",
      "| `x | @octocat | y` |",
    ]) {
      expect(SafeMarkdown.block(text)).toBe(text);
      expect(outsideCode(SafeMarkdown.block(text))).not.toMatch(/@octocat|#12/);
    }

    expect(SafeMarkdown.line("`a | b` and `c | @octocat`")).toBe("`a | b` and `c | @octocat`");
  });

  test("rows of a table made of many pieces of backticks, pipes and text that acts show none of it outside code", () => {
    const pieces = ["`", "`", "``", "|", "|", "\\|", "\\", " ", "x", " @octocat", " #12", " GH-12", "<b>", "\\`", "*"];

    const heads = ["| a | b | c |\n|---|---|---|\n", "a|b\n-|-\n", "> a | b | c\n> ---|---|---\n> "];
    const acting = /@octocat|(?<![&\w])#12\b|GH-12|<b>/;
    const failures: string[] = [];
    let seed = 20_261_128;
    let tables = 0;

    const next = (below: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

      return Math.floor(seed / 65_536) % below;
    };

    for (let round = 0; round < 3000; round++) {
      let text = heads[next(heads.length)] ?? "";

      for (let piece = 1 + next(12); piece > 0; piece--) text += pieces[next(pieces.length)];

      const safe = SafeMarkdown.block(text);

      if (rendered(safe).includes("<table>")) tables++;
      if (acting.test(outsideCode(safe))) failures.push(JSON.stringify(text));
      if (SafeMarkdown.block(safe) !== safe) failures.push(`treated twice: ${JSON.stringify(text)}`);
    }

    expect(failures).toEqual([]);
    expect(tables).toBeGreaterThan(2000);
  });

  test("text for a place inside a line, such as a title, gets the same treatment", () => {
    expect(SafeMarkdown.line("@octocat broke #12")).toBe("`@octocat` broke `#12`");
    expect(SafeMarkdown.line("thanks\n@octocat")).toBe("thanks `@octocat`");
  });

  test("a renderer shows no mention and no issue number outside code, whatever was tried", () => {
    const tries = [
      "cc @octocat",
      "cc \\@octocat",
      "cc &#64;octocat",
      "cc &#x40;octocat",
      "cc &commat;octocat",
      "**@octocat**",
      "[@octocat](https://example.com)",
      "> @octocat",
      "- @octocat",
      "| @octocat |",
      "<@octocat",
      "@octocat/@octocat",
      "Fixes #12",
      "Fixes \\#12",
      "Fixes &#35;12",
      "Fixes &num;12",
      "Fixes acme/shop#12",
      "Fixes GH-12",
      "_GH-12_",
      "__GH-12__",
      "*GH-12*",
      "Fixes _#12_",
      "Fixes _acme/shop#12_",
      "`a` @octocat `b`",
      "` @octocat",
      "@octocat`x`",
    ];

    const acting = /@octocat|(?<![&\w])#12\b|GH-12/;

    for (const text of tries) {
      expect({ text, shown: outsideCode(SafeMarkdown.block(text)).match(acting)?.[0] }).toEqual({
        text,
        shown: undefined,
      });

      expect({ text, shown: outsideCode(`**${SafeMarkdown.line(text)}**`).match(acting)?.[0] }).toEqual({
        text,
        shown: undefined,
      });
    }

    expect(outsideCode("cc @octocat and &#64;octocat, fixes #12")).toMatch(acting);
  });
});

describe("safe markdown: what a renderer makes of it", () => {
  const attacks: Record<string, string> = {
    "a fake marker line": `Text.\n${MARKER.replace("head=x", "head=forged")}\nMore.`,
    "an HTML comment that is never closed": "Text.\n<!-- everything after this is hidden",
    "an HTML comment opened inside a line": "Text <!-- hidden from here",
    "a code fence that is never closed": "Text.\n```ts\nconst a = 1;",
    "a tilde fence that is never closed": "~~~\ncode",
    "an indented code fence that is never closed": "- item\n  ```\n  code",
    "a raw HTML block that is never closed": "<details>\n<summary>more</summary>\n\nText.",
    "a line that is only the end of an HTML comment": "Text.\n-->\nMore.",
    "a comment opened in one text and closed in the next": "<!--\n\n-->",
    "a script and a style block": "<script>\nalert(1)\n\n<style>\np { display: none }",
    "a code span opened on one line and closed on the next": "a ` b\n`<details>` c",
    "a fence opened behind a list marker": "- ```\n  <details>\n  ```\n<details>",
  };

  for (const [name, attack] of Object.entries(attacks)) {
    test(`${name} leaves the note readable and the marker hidden and last`, () => {
      expect(renderProblems(comment(attack), NOTE, MARKER)).toEqual([]);
    });
  }

  test("the same texts without the treatment do break the comment", () => {
    const broken = Object.values(attacks).filter((attack) => {
      const raw = `**Title** · bug\n\n${attack}\n\n**Fix:** ${attack}\n\n${NOTE}\n${MARKER}`;

      return renderProblems(raw, NOTE, MARKER).length > 0;
    });

    expect(broken.length).toBeGreaterThanOrEqual(9);
  });

  test("texts made of many pieces of markdown and HTML, also cut at any place, never break the comment", () => {
    let seed = 20_261_128;

    const next = (below: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

      return seed % below;
    };

    const failures: string[] = [];

    for (let round = 0; round < 4000; round++) {
      let text = "";

      for (let piece = 1 + next(14); piece > 0; piece--) text += PIECES[next(PIECES.length)];

      const cutAt = next(text.length + 1);

      for (const candidate of [text, text.slice(0, cutAt)]) {
        if (renderProblems(comment(candidate), NOTE, MARKER).length > 0) failures.push(JSON.stringify(candidate));
      }

      const once = SafeMarkdown.block(text);

      if (SafeMarkdown.block(once) !== once) failures.push(`treated twice: ${JSON.stringify(text)}`);
    }

    expect(failures).toEqual([]);
  });
});
