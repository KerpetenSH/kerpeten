import { cut, oneLine, shortLine } from "../../text/text-utils.ts";
import type { CutText } from "../../text/types/text.ts";
import { CommentMarker } from "./CommentMarker.ts";
import { SafeMarkdown } from "./SafeMarkdown.ts";
import type { CommentWordSet, LineComment, RankedFinding, SummaryComment, SummaryFacts } from "./types/comment.ts";

/**
 * Writes the texts of the comments of one review, in the words of one language: the comment on the lines of a finding
 * and the one summary comment. Every text ends with its hidden marker as the last line, and the text a model wrote
 * goes through `SafeMarkdown` first.
 *
 * No text is longer than `MAX_COMMENT`, counted as a string's length, which is never less than its characters; GitHub
 * takes 65,536 characters. A text that would be longer is cut where a reader sees it: a title ends with `…`, a body
 * and a fix end with a note that says they were cut, and the summary lists the findings that fit and says how many it
 * does not show. The marker is never cut.
 */
export class CommentTexts {
  public static readonly MAX_COMMENT = 60_000;

  public static readonly MAX_TITLE = 300;

  public static readonly MAX_FIX = 10_000;

  public static readonly MAX_SUMMARY_BODY = 10_000;

  private static readonly MAX_REASON = 100;

  private static readonly PARAGRAPH = "\n\n";

  private static readonly TITLE_CUT = "…";

  private static readonly LABEL_SEPARATOR = " · ";

  private readonly words: CommentWordSet;
  private readonly headSha: string;
  private readonly summaryMarker: string;

  public constructor(words: CommentWordSet, headSha: string) {
    this.words = words;
    this.headSha = headSha;
    this.summaryMarker = CommentMarker.summary(headSha).line();
  }

  /** The comment on the lines of `finding`: its title with category and priority, its body, its fix, the note that asks for a thumbs-down and the marker. */
  public lineComment(finding: RankedFinding): LineComment {
    const { file, start_line: startLine, end_line: endLine } = finding;
    const marker = CommentMarker.finding(this.headSha, file, startLine, endLine).line();
    const title = this.title(finding);
    const head = [`**${title.text}**`, ...CommentTexts.labels(finding)].join(CommentTexts.LABEL_SEPARATOR);
    const fix = this.fix(finding);
    const tail = `${this.words.thumbsDown}\n${marker}`;
    const taken = CommentTexts.joined([head, fix.text, tail]).length + CommentTexts.PARAGRAPH.length;
    const body = this.fitted(finding.body, CommentTexts.MAX_COMMENT - taken);

    return {
      file,
      startLine,
      endLine,
      body: CommentTexts.joined([head, body.text, fix.text, tail]),
      cut: title.cut || body.cut || fix.cut,
    };
  }

  /**
   * The summary comment: the heading, the commit and the count of line comments, the count of findings whose comment
   * failed to be written, the count of findings the judge could not judge, the note of a partial review, the findings
   * of `listed` in their order and the marker. With nothing listed, nothing on a line, nothing already written, no
   * failed write and no finding the judge could not judge it says that the review found nothing to report; it never
   * says so while a finding is left without its comment or without its judgement.
   */
  public summary(listed: readonly RankedFinding[], facts: SummaryFacts): SummaryComment {
    const { words } = this;
    const unwritten = facts.unwritten ?? 0;
    const unjudged = facts.unjudged ?? 0;
    const empty = listed.length === 0 && facts.lineComments === 0 && facts.alreadyWritten === 0;
    const quiet = empty && unwritten === 0 && unjudged === 0;

    const intro = [
      words.heading,
      words.reviewed(this.headSha, facts.lineComments, facts.alreadyWritten),
      ...(unwritten > 0 ? [words.unwritten(unwritten)] : []),
      ...(unjudged > 0 ? [words.unjudged(unjudged)] : []),
      ...(facts.partialReason === undefined ? [] : [words.partial(CommentTexts.reason(facts.partialReason))]),
      ...(quiet ? [words.nothing] : []),
    ];

    const items = listed.map((finding) => this.summaryItem(finding));
    const shown = this.shown(CommentTexts.joined([...intro, this.summaryMarker]).length, items);
    const omitted = items.length - shown;

    return {
      body: CommentTexts.joined([
        ...intro,
        ...items.slice(0, shown),
        ...(omitted > 0 ? [words.omitted(omitted)] : []),
        this.summaryMarker,
      ]),
      omitted,
    };
  }

  private static joined(parts: readonly string[]): string {
    return parts.filter((part) => part !== "").join(CommentTexts.PARAGRAPH);
  }

  private static labels(finding: RankedFinding): string[] {
    return "judge_error" in finding ? [finding.category] : [finding.category, finding.priority];
  }

  private static place(finding: RankedFinding): string {
    const { file, start_line: start, end_line: end } = finding;

    return SafeMarkdown.code(start === end ? `${file}:${start}` : `${file}:${start}-${end}`);
  }

  private static reason(reason: string): string {
    return SafeMarkdown.code(shortLine(reason, CommentTexts.MAX_REASON));
  }

  /** The text without the empty lines before it and the space after it. */
  private static trimmed(text: string): string {
    return text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
  }

  private summaryItem(finding: RankedFinding): string {
    const labels = [CommentTexts.place(finding), ...CommentTexts.labels(finding)].join(CommentTexts.LABEL_SEPARATOR);
    const body = this.fitted(finding.body, CommentTexts.MAX_SUMMARY_BODY);

    return CommentTexts.joined([`### ${this.title(finding).text}\n${labels}`, body.text, this.fix(finding).text]);
  }

  /** How many of `items` the summary shows, from the first on, so that it stays in the limit with its fixed text of `fixed` characters. */
  private shown(fixed: number, items: readonly string[]): number {
    const gap = CommentTexts.PARAGRAPH.length;
    let length = items.reduce((sum, item) => sum + item.length + gap, fixed);

    for (let shown = items.length; shown >= 0; shown--) {
      const omitted = items.length - shown;
      const note = omitted === 0 ? 0 : this.words.omitted(omitted).length + gap;

      if (length + note <= CommentTexts.MAX_COMMENT) return shown;

      length -= (items[shown - 1]?.length ?? 0) + gap;
    }

    throw new RangeError("the summary comment has no room for its own text");
  }

  private title(finding: RankedFinding): CutText {
    const line = oneLine(finding.title);

    if (line === "") return { text: this.words.untitled, cut: false };

    const short = cut(line, CommentTexts.MAX_TITLE);

    return {
      text: SafeMarkdown.line(short.cut ? `${short.text}${CommentTexts.TITLE_CUT}` : short.text),
      cut: short.cut,
    };
  }

  /** The fix behind its label: on the label's line when it is one line, from the next line on when it has more, so a list or a code block in it starts at the start of a line. */
  private fix(finding: RankedFinding): CutText {
    const fix = finding.fix.trim();

    if (fix === "") return { text: "", cut: false };

    return this.fitted(`${this.words.fix}${fix.includes("\n") ? "\n" : " "}${fix}`, CommentTexts.MAX_FIX);
  }

  /**
   * `text` made safe, in at most `room` characters. A text that is longer is cut and ends with the note that says so:
   * the longest start of it is kept that, made safe, leaves room for the note.
   */
  private fitted(text: string, room: number): CutText {
    const source = CommentTexts.trimmed(text);
    const whole = SafeMarkdown.block(source);

    if (whole.length <= room) return { text: whole, cut: false };

    const left = room - this.words.cut.length - CommentTexts.PARAGRAPH.length;

    if (left < 0) throw new RangeError("a comment has no room for the text of its finding");

    let fits = 0;
    let tooLong = source.length;

    while (tooLong - fits > 1) {
      const middle = Math.floor((fits + tooLong) / 2);

      if (CommentTexts.start(source, middle).length <= left) fits = middle;
      else tooLong = middle;
    }

    return { text: CommentTexts.joined([CommentTexts.start(source, fits), this.words.cut]), cut: true };
  }

  private static start(source: string, length: number): string {
    return SafeMarkdown.block(cut(source, length).text.trimEnd());
  }
}
