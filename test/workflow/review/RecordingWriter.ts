import type {
  LineCommentOutcome,
  LineCommentWrite,
  PlatformLineComment,
  PlatformWriter,
  SummaryWrite,
} from "../../../src/capability/platform/types/platform.ts";
import type { WriterCall } from "./types/writer.ts";

/**
 * A platform writer that writes nowhere: it keeps every call in `calls` and answers as it was told. A line comment
 * gets the outcome `lines` gives for its last line, and is written as `github:review_comment/<last line>` when it gives
 * none; the summary gets `summary`, and is written as `github:issue_comment/900`, or as the comment it was told to
 * update, when none is given. An update of one of the comments `foreign` names is refused, as the platform refuses
 * to let an account change the comment of another.
 */
export class RecordingWriter implements PlatformWriter {
  public readonly calls: WriterCall[] = [];

  private readonly lines: Readonly<Record<number, LineCommentOutcome>>;
  private readonly summary: SummaryWrite | undefined;
  private readonly problems: readonly string[];
  private readonly foreign: readonly string[];

  public constructor(
    lines: Readonly<Record<number, LineCommentOutcome>> = {},
    summary?: SummaryWrite,
    problems: readonly string[] = [],
    foreign: readonly string[] = [],
  ) {
    this.lines = lines;
    this.summary = summary;
    this.problems = problems;
    this.foreign = foreign;
  }

  public async writeLineComments(
    number: number,
    headSha: string,
    comments: readonly PlatformLineComment[],
  ): Promise<LineCommentWrite> {
    this.calls.push({ kind: "lines", number, headSha, comments });

    return {
      outcomes: comments.map(
        (comment) =>
          this.lines[comment.endLine] ?? { kind: "written", ref: `github:review_comment/${comment.endLine}` },
      ),
      problems: this.problems,
    };
  }

  public async writeSummary(number: number, body: string, existing?: string): Promise<SummaryWrite> {
    this.calls.push({ kind: "summary", number, body, existing });

    if (existing !== undefined && this.foreign.includes(existing)) {
      return { kind: "refused", reason: `not written: the platform does not let this account change ${existing}` };
    }

    return (
      this.summary ?? { kind: "written", ref: existing ?? "github:issue_comment/900", updated: existing !== undefined }
    );
  }
}
