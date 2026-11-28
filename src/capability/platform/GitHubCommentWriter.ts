import { Capability } from "@kerpetensh/harness-kit";
import { CommentRef } from "./CommentRef.ts";
import { GitHubCli } from "./GitHubCli.ts";
import { GitHubWriteAnswer } from "./GitHubWriteAnswer.ts";
import { LimitedOutput } from "./LimitedOutput.ts";
import { PlatformError } from "./PlatformError.ts";
import type { RemoteProject } from "./RemoteProject.ts";
import { githubWrittenCommentSchema } from "./schemas/github-schema.ts";
import type {
  GitHubReviewRequest,
  GitHubReviewTarget,
  GitHubWriteResult,
  GitHubWrittenComment,
} from "./types/github.ts";
import type {
  FailedWrite,
  LineCommentOutcome,
  LineCommentWrite,
  PlatformLineComment,
  PlatformList,
  PlatformRead,
  PlatformWriter,
  SummaryWrite,
} from "./types/platform.ts";

/**
 * Writes the comments of a review to a pull request on GitHub with `gh api`, behind the `PlatformWriter` interface. It
 * is a capability of its own beside `GitHubPlatform`, which only reads: a review that only shows its plan reads
 * through that one and never calls this one. How gh is started, and for which repository, is what `GitHubCli` says.
 *
 * `gh api` can do whatever the sign-in can, and a comment is sent from the user's own account. So the same rules hold
 * as for the reads:
 *
 * - Every public method is typed and builds its own endpoint and arguments. No argument comes from a caller as text.
 * - The repository is the one of the `origin` remote, named in the path, and the host is given with `--hostname`.
 * - A number in a path is checked to be one: the pull request, and the id of a review or a comment, which is digits.
 * - It makes three requests and no other: `POST repos/<owner>/<name>/pulls/<n>/reviews`,
 *   `POST repos/<owner>/<name>/issues/<n>/comments` and `PATCH repos/<owner>/<name>/issues/comments/<id>`; and one
 *   read, the comments of a review it wrote.
 * - The text of a comment is never an argument: the request body is JSON on gh's standard input (`--input -`).
 * - The capability declares no permission, so no tool of a model can take it.
 * - What gh answers is outside data: nothing of it is run, and what is shown of it is made safe for a terminal.
 * - Every call has the budget of a read, `PlatformLimits`.
 *
 * The line comments go to GitHub as one review at the commit the review was of. When GitHub refuses the review as
 * invalid, it wrote nothing; the list is then cut in two and each half is sent as its own review, until a refused
 * comment stands alone. That comment is `refused`; the others end up written. Any other failure makes the comments of
 * that call `failed`, and nothing is cut or sent again; so does a refusal that names no place of a comment.
 * `GitHubWriteAnswer` says which answer is which. GitHub gives no ids when it takes a review, so the comments of a
 * written review are read back and each is known by its text, or by the marker its text ends with; when they cannot
 * be read back, the comments are written all the same and carry the ref of the review.
 *
 * A summary comment that is there is updated. When GitHub does not let the account change that comment, or the
 * comment is gone, the write is `refused` and nothing is written: the caller may then try another or make a new one.
 */
@Capability({
  name: "github-comment-writer",
  description:
    "Writes the line comments of a review, as one review, and its one summary comment to a pull request on GitHub with gh api, in the repository the origin remote names, through typed methods that build their own requests and send the text on standard input; no tool can take it.",
  scope: "run",
})
export class GitHubCommentWriter extends GitHubCli implements PlatformWriter {
  private static readonly CREATE: readonly string[] = ["--method", "POST"];

  private static readonly UPDATE: readonly string[] = ["--method", "PATCH"];

  private static readonly FROM_STDIN: readonly string[] = ["--input", "-"];

  private static readonly SHA = /^[0-9a-f]{40}$/;

  private static assertLineComment(comment: PlatformLineComment): void {
    const { file, startLine, endLine, body, marker } = comment;
    const lines = Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine) && startLine >= 1;

    if (file === "" || !lines || startLine > endLine) {
      throw new RangeError(`not the place of a line comment: ${JSON.stringify(file)} ${startLine}-${endLine}`);
    }

    if (marker.trim() === "" || !body.trimEnd().endsWith(marker)) {
      throw new RangeError(`the text of the line comment on ${JSON.stringify(file)} does not end with its marker`);
    }
  }

  /** The body of the one review that holds `comments`: each on the new side, on its last line, from its first line when it has more than one. */
  private static reviewRequest(headSha: string, comments: readonly PlatformLineComment[]): GitHubReviewRequest {
    return {
      commit_id: headSha,
      event: "COMMENT",
      comments: comments.map((comment) => ({
        path: comment.file,
        line: comment.endLine,
        side: "RIGHT",
        ...(comment.startLine < comment.endLine ? { start_line: comment.startLine, start_side: "RIGHT" } : {}),
        body: comment.body,
      })),
    };
  }

  /** The ref of the summary comment to update; a ref of another platform or of another kind of comment is refused. */
  private static summaryRef(existing: string): CommentRef {
    const ref = CommentRef.parse(existing);

    if (ref.platform !== "github" || !ref.inConversation) {
      throw new RangeError(
        `the summary comment of a pull request is a comment of its conversation, which ${ref.text} is not`,
      );
    }

    return ref;
  }

  /**
   * The id of the comment among `read` that each of `comments` is, in the order of `comments`, or `undefined` for one
   * that is not there. A read comment stands for one sent comment only. A comment is found by its whole text first,
   * and by the marker its text ends with when the platform changed the text. So two comments on the same lines, which
   * share a marker, each get their own id as long as their texts differ.
   */
  private static matched(
    comments: readonly PlatformLineComment[],
    read: readonly GitHubWrittenComment[],
  ): (number | undefined)[] {
    const left = [...read];
    const found: (number | undefined)[] = comments.map(() => undefined);

    const take = (same: (comment: PlatformLineComment, candidate: GitHubWrittenComment) => boolean): void => {
      for (const [index, comment] of comments.entries()) {
        const at = found[index] === undefined ? left.findIndex((candidate) => same(comment, candidate)) : -1;

        if (at >= 0) found[index] = left.splice(at, 1)[0]?.id;
      }
    };

    take((comment, candidate) => candidate.body.trimEnd() === comment.body.trimEnd());
    take((comment, candidate) => candidate.body.trimEnd().endsWith(comment.marker));

    return found;
  }

  /** The outcome of a write that could not be sent at all; an error that is no platform error is thrown again. */
  private static unsent(error: unknown): FailedWrite {
    if (!(error instanceof PlatformError)) throw error;

    return { kind: "failed", message: `not written: ${error.message}` };
  }

  public async writeLineComments(
    number: number,
    headSha: string,
    comments: readonly PlatformLineComment[],
  ): Promise<LineCommentWrite> {
    GitHubCli.assertNumber(number);

    if (!GitHubCommentWriter.SHA.test(headSha)) {
      throw new RangeError(`a review is written at a commit of 40 hex characters, not ${JSON.stringify(headSha)}`);
    }

    for (const comment of comments) GitHubCommentWriter.assertLineComment(comment);

    if (comments.length === 0) return { outcomes: [], problems: [] };

    let project: RemoteProject;

    try {
      project = await this.repository();
    } catch (error) {
      const failed = GitHubCommentWriter.unsent(error);

      return { outcomes: comments.map(() => failed), problems: [] };
    }

    return this.review({ project, number, headSha }, comments);
  }

  public async writeSummary(number: number, body: string, existing?: string): Promise<SummaryWrite> {
    GitHubCli.assertNumber(number);

    const ref = existing === undefined ? undefined : GitHubCommentWriter.summaryRef(existing);
    let project: RemoteProject;

    try {
      project = await this.repository();
    } catch (error) {
      return GitHubCommentWriter.unsent(error);
    }

    const answer =
      ref === undefined
        ? await this.send(project, number, GitHubCommentWriter.CREATE, `issues/${number}/comments`, { body })
        : await this.send(project, number, GitHubCommentWriter.UPDATE, `issues/comments/${ref.id}`, { body });

    if (answer.kind === "invalid") {
      return { kind: "failed", message: `not written: GitHub refused it as invalid: ${answer.reason}` };
    }

    if (answer.kind === "denied") {
      return ref === undefined
        ? { kind: "failed", message: answer.message }
        : { kind: "refused", reason: answer.message };
    }

    if (answer.kind === "failed") return answer;

    return {
      kind: "written",
      ref: CommentRef.of("github", "issue_comment", answer.id).text,
      updated: ref !== undefined,
    };
  }

  /**
   * Sends `comments` as one review. A review GitHub refuses as invalid is cut in two halves that are sent one after
   * the other, each as its own review, down to the one comment that is refused alone.
   */
  private async review(
    target: GitHubReviewTarget,
    comments: readonly PlatformLineComment[],
  ): Promise<LineCommentWrite> {
    const { project, number, headSha } = target;
    const request = GitHubCommentWriter.reviewRequest(headSha, comments);
    const answer = await this.send(project, number, GitHubCommentWriter.CREATE, `pulls/${number}/reviews`, request);

    if (answer.kind === "written") return this.readBack(target, answer.id, comments);

    if (answer.kind === "failed" || answer.kind === "denied") {
      const failed: FailedWrite = { kind: "failed", message: answer.message };

      return { outcomes: comments.map(() => failed), problems: [] };
    }

    if (comments.length === 1) return { outcomes: [{ kind: "refused", reason: answer.reason }], problems: [] };

    const half = Math.ceil(comments.length / 2);
    const first = await this.review(target, comments.slice(0, half));
    const second = await this.review(target, comments.slice(half));

    return {
      outcomes: [...first.outcomes, ...second.outcomes],
      problems: [...first.problems, ...second.problems],
    };
  }

  /**
   * The outcomes of the comments of the written review `review`: each with the ref of its comment, found among the
   * comments of the review by its text or by the marker its text ends with. A comment that is not found there is
   * written all the same and gets the ref of the review; one line of `problems` says so.
   */
  private async readBack(
    target: GitHubReviewTarget,
    review: number,
    comments: readonly PlatformLineComment[],
  ): Promise<LineCommentWrite> {
    const { project, number } = target;
    const path = `repos/${project.path}/pulls/${number}/reviews/${review}/comments`;
    let read: PlatformList<GitHubWrittenComment>;

    try {
      read = await this.list(project, path, number, githubWrittenCommentSchema);
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;

      read = { items: [], problems: [`${path}: ${error.message}`] };
    }

    const reviewRef = CommentRef.of("github", "review", review).text;

    const found = GitHubCommentWriter.matched(comments, read.items);
    const unknown = found.filter((id) => id === undefined).length;

    const outcomes = found.map(
      (id): LineCommentOutcome => ({
        kind: "written",
        ref: id === undefined ? reviewRef : CommentRef.of("github", "review_comment", id).text,
      }),
    );

    if (unknown === 0) return { outcomes, problems: [] };

    const why = read.problems.length === 0 ? "the review does not list them" : read.problems.join("; ");

    return {
      outcomes,
      problems: [
        `${unknown} of the ${comments.length} line comments of review ${review} are written, but their ids could not be read back, so they carry the ref of the review, ${reviewRef}: ${why}`,
      ],
    };
  }

  /**
   * Sends one write of gh for pull request `number` to `endpoint` of the repository, with `body` as JSON on gh's
   * standard input, inside the budget of a call, and says what GitHub answered. A gh that cannot be started is a
   * failed write.
   */
  private async send(
    project: RemoteProject,
    number: number,
    method: readonly string[],
    endpoint: string,
    body: object,
  ): Promise<GitHubWriteResult> {
    const limits = this.readLimits();
    const output = new LimitedOutput(limits.bytes);
    const path = `repos/${project.path}/${endpoint}`;
    const write = [...method, "--hostname", project.host, path, ...GitHubCommentWriter.FROM_STDIN];
    const input = new TextEncoder().encode(JSON.stringify(body));
    let read: PlatformRead;

    try {
      read = this.ended(await this.stream(write, (chunk) => output.take(chunk), limits.ms, input), output, limits);
    } catch (error) {
      return GitHubCommentWriter.unsent(error);
    }

    return GitHubWriteAnswer.of(read, number, project);
  }
}
