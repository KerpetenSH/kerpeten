/** The kind of platform a merge request lives on. */
export type PlatformKind = "github" | "gitlab";

export type MergeRequestState = "open" | "closed" | "merged";

/**
 * A merge request as a platform gives it, in words no platform owns: a GitHub pull request is one, a GitLab merge
 * request another. `host` is the platform's host in lowercase without a scheme, `projectId` the platform's own id of
 * the repository the merge request goes into. The title and the description are outside data.
 */
export interface MergeRequest {
  readonly kind: PlatformKind;
  readonly host: string;
  readonly projectId: string;
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly state: MergeRequestState;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseRef: string;
}

export type PlatformCommentKind = "line" | "general";

/** The side of a change a line is on: `new` is the file as the change leaves it, `old` the file as it was before. */
export type PlatformSide = "old" | "new";

export interface PlatformLines {
  readonly start: number;
  readonly end: number;
}

/**
 * A comment on a merge request. A general comment belongs to the merge request as a whole. A line comment sits in the
 * change of the merge request as it was at one commit:
 *
 * - `commit` is the last commit of the change the comment was written on, the head of that diff.
 * - `file` is the path of the file as that change leaves it. A file the change renamed is named by its new path, a
 *   file the change removed by the path it had.
 * - `side` says which file `lines` count in. `new`: the file at `commit`. `old`: the file as it was before the
 *   change, at the base of that diff, which no field names; a comment on a line the change removed is there.
 * - `lines` are the first and the last line of the comment on that side. A comment on more than one line whose first
 *   line is on the other side than its last gives its last line alone, because the number of its first line counts
 *   in the other file.
 *
 * A field that does not exist for a comment is `null`: `file`, `lines`, `side` and `replyTo` of a general comment,
 * `lines` and `side` of a comment on a whole file, `replyTo` of a comment that starts a thread. The author and the
 * body are outside data.
 *
 * `ref` names the comment on its platform, in the form `CommentRef` writes: with the merge request known it is enough
 * to find the comment again.
 */
export interface PlatformComment {
  readonly id: string;
  readonly ref: string;
  readonly kind: PlatformCommentKind;
  readonly author: string | null;
  readonly body: string;
  readonly file: string | null;
  readonly lines: PlatformLines | null;
  readonly side: PlatformSide | null;
  readonly commit: string | null;
  readonly replyTo: string | null;
  readonly createdAt: string | null;
}

/**
 * The comments of a merge request. `complete` is false when a part of them could not be read to its end; `comments`
 * then holds what was read and `problems` says, one line per part, what was not.
 */
export interface PlatformComments {
  readonly comments: readonly PlatformComment[];
  readonly complete: boolean;
  readonly problems: readonly string[];
}

/** The entries of one list of a platform that were read, and what was not read of it, one line per problem. */
export interface PlatformList<T> {
  readonly items: readonly T[];
  readonly problems: readonly string[];
}

/** The budget of one read of a platform's command line tool: the most bytes it may print and the time it may take. */
export interface PlatformReadLimits {
  readonly bytes: number;
  readonly ms: number;
}

/** A read of a platform's command line tool that ran to its end, with what the tool printed and how it exited. */
export interface PlatformExit {
  readonly kind: "exited";
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * A read that was stopped at a limit of its budget: the tool printed more than `bytes`, or it took longer than `ms`.
 * `stdout` holds what was printed up to there.
 */
export type PlatformStop =
  | { readonly kind: "too_large"; readonly stdout: Buffer; readonly bytes: number }
  | { readonly kind: "timed_out"; readonly stdout: Buffer; readonly ms: number };

/** How one read of a platform's command line tool ended. */
export type PlatformRead = PlatformExit | PlatformStop;

/** Why a platform read failed: the platform's command line tool is missing, it is not signed in, the merge request or the repository was not found, or anything else. */
export type PlatformFailure = "cli_missing" | "signed_out" | "not_found" | "no_repository" | "failed";

/** What the review reads from the platform a merge request lives on. */
export interface Platform {
  mergeRequest(number: number): Promise<MergeRequest>;
  comments(number: number): Promise<PlatformComments>;
}

/**
 * The kind of comment a `CommentRef` names. On GitHub: `review_comment` is a comment on lines, `issue_comment` a
 * comment of the conversation of a pull request, `review` the body of a review. On GitLab: `note`.
 */
export type CommentRefKind = "review_comment" | "issue_comment" | "review" | "note";

/**
 * A comment to write on lines of the file as the change of a merge request leaves it, from `startLine` to `endLine`.
 * `marker` is the text that ends `body`: a platform that gives no id when it takes the comment reads its comments
 * back and knows this one by the marker its text ends with.
 */
export interface PlatformLineComment {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
  readonly marker: string;
}

/**
 * A write that failed. `message` says why and what to do. It starts with `not written:` when the platform wrote
 * nothing for sure. After a time limit it is not known whether the platform wrote, and the message says so.
 */
export interface FailedWrite {
  readonly kind: "failed";
  readonly message: string;
}

/**
 * What became of one line comment that was given to a platform:
 *
 * - `written`: it is on the merge request, and `ref` names it.
 * - `refused`: the platform does not take a comment on these lines, and wrote nothing; `reason` is what it answered.
 * - `failed`: the write failed for another reason.
 */
export type LineCommentOutcome =
  | { readonly kind: "written"; readonly ref: string }
  | { readonly kind: "refused"; readonly reason: string }
  | FailedWrite;

/**
 * What became of the line comments of one write: one outcome per comment, in the order the comments were given.
 * `problems` says, one line each, what went wrong beside the outcomes, such as ids that could not be read back.
 */
export interface LineCommentWrite {
  readonly outcomes: readonly LineCommentOutcome[];
  readonly problems: readonly string[];
}

/**
 * What became of the summary comment:
 *
 * - `written`: it is on the merge request; `ref` names it and `updated` says whether a comment that was there got
 *   the new text.
 * - `refused`: the comment that was to be updated cannot be: the platform does not let this account change it, or
 *   it is gone. Nothing was written, and another comment may be tried or a new one made. `reason` says what the
 *   platform answered. A write that makes a new comment is never refused in this sense.
 * - `failed`: the write failed for another reason.
 */
export type SummaryWrite =
  | { readonly kind: "written"; readonly ref: string; readonly updated: boolean }
  | { readonly kind: "refused"; readonly reason: string }
  | FailedWrite;

/**
 * What the review writes to the platform a merge request lives on. Neither method throws for a write the platform
 * failed at: the outcome says what happened, so one comment that cannot be written does not stop the others.
 */
export interface PlatformWriter {
  /**
   * Writes `comments` on lines of merge request `number` as it is at the commit `headSha`, the one the review was
   * of.
   */
  writeLineComments(
    number: number,
    headSha: string,
    comments: readonly PlatformLineComment[],
  ): Promise<LineCommentWrite>;

  /**
   * Writes the one summary comment of merge request `number`. With `existing`, the ref of a summary comment that is
   * there, that comment gets the new text, or the write is `refused` when this account cannot change it; without
   * `existing` a new comment is made. A ref that names no comment a summary can be throws an error.
   */
  writeSummary(number: number, body: string, existing?: string): Promise<SummaryWrite>;
}
