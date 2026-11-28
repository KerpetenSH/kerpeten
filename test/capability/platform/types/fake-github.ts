import type { CliAnswer } from "./platform.ts";

/** A review as the fake GitHub keeps it and lists it. */
export interface FakeReview {
  readonly id: number;
  readonly user: { readonly login: string };
  readonly body: string;
  readonly state: string;
  readonly commit_id: string;
  readonly submitted_at: string;
}

/** A comment on lines as the fake GitHub keeps it and lists it among the comments of the pull request. */
export interface FakeLineComment {
  readonly id: number;
  readonly pull_request_review_id: number;
  readonly user: { readonly login: string };
  readonly body: string;
  readonly path: string;
  readonly subject_type: string;
  readonly side: string;
  readonly start_side: string | null;
  readonly line: number;
  readonly start_line: number | null;
  readonly original_line: number;
  readonly original_start_line: number | null;
  readonly commit_id: string;
  readonly original_commit_id: string;
  readonly created_at: string;
}

/** A comment of the conversation as the fake GitHub keeps it and lists it. */
export interface FakeIssueComment {
  readonly id: number;
  readonly user: { readonly login: string };
  body: string;
  readonly created_at: string;
}

/**
 * How the fake GitHub answers, beside taking what it is sent:
 *
 * - `refusedLines`: a review with a comment whose last line is one of these is refused with HTTP 422, as GitHub
 *   refuses a line that is not in the diff, and nothing of it is kept.
 * - `pendingReview`: every review is refused with HTTP 422 and GitHub's text about a pending review.
 * - `review`, `summary`, `readBack`: the answer gh gives in place of its own for a review that is sent, for the
 *   summary comment that is made or updated, and for the comments of one review that are read.
 * - `keepsReview`: with `review` set, the review is kept all the same, as when GitHub wrote it and gh did not answer.
 * - `foreignComments`: the ids of the comments of the conversation that another account wrote: an update of one is
 *   refused with HTTP 403 and changes nothing.
 * - `movesTo`: the commit the pull request is at from its second read on, as when a commit is pushed while a review
 *   runs.
 */
export interface FakeGitHubRules {
  readonly refusedLines?: readonly number[];
  readonly pendingReview?: boolean;
  readonly review?: CliAnswer;
  readonly summary?: CliAnswer;
  readonly readBack?: CliAnswer;
  readonly keepsReview?: boolean;
  readonly foreignComments?: readonly number[];
  readonly movesTo?: string;
}

/** One call of the fake gh: its arguments, and what it read from its standard input when it was told to read it. */
export interface FakeGitHubCall {
  readonly args: readonly string[];
  readonly input?: string;
}

/** What the fake GitHub holds, kept in a file between the calls of the fake gh: one pull request and its comments. */
export interface FakeGitHubState {
  readonly pull: string;
  pullReads: number;
  nextId: number;
  readonly reviews: FakeReview[];
  readonly lineComments: FakeLineComment[];
  readonly conversation: FakeIssueComment[];
  readonly rules: FakeGitHubRules;
  readonly calls: FakeGitHubCall[];
}

/** What a test gives the fake GitHub at its start; the pull request is an open one of `Acme/Shop` when none is given. */
export interface FakeGitHubStart {
  readonly pull?: string;
  readonly rules?: FakeGitHubRules;
  readonly lineComments?: readonly FakeLineComment[];
  readonly conversation?: readonly FakeIssueComment[];
}

/** The body of a review as gh sends it to the fake GitHub. */
export interface FakeReviewRequest {
  readonly commit_id: string;
  readonly event: string;
  readonly comments: readonly {
    readonly path: string;
    readonly line: number;
    readonly side: string;
    readonly start_line?: number;
    readonly start_side?: string;
    readonly body: string;
  }[];
}

/** What the fake gh was asked for: the method, the path without its query, whether all pages are wanted, and its input. */
export interface FakeGitHubRequest {
  readonly method: string;
  readonly path: string;
  readonly slurp: boolean;
  readonly input: string | undefined;
}
