import { z } from "zod";

const id = z.int().positive();

const sha = z.string().regex(/^[0-9a-f]{40}$/);

const line = z.int().positive().nullish();

const user = z.object({ login: z.string() }).nullish();

const side = z.enum(["LEFT", "RIGHT"]);

/** The fields of `GET /repos/{owner}/{repo}/pulls/{number}` the review reads. */
export const githubPullRequestSchema = z.object({
  html_url: z.string(),
  number: id,
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  title: z.string(),
  body: z.string().nullable(),
  head: z.object({ sha }),
  base: z.object({ sha, ref: z.string(), repo: z.object({ id, full_name: z.string() }) }),
});

/**
 * A review comment of a pull request: a comment on lines of a file. A reply names the comment it answers. `side` is
 * the side of the diff its last line is on, `LEFT` for the file before the change, and `start_side` the side of the
 * first line of a comment on more than one line. The line numbers count in the file of their side. A comment on a
 * whole file has the `subject_type` `file` and still names line 1.
 */
export const githubReviewCommentSchema = z.object({
  id,
  user,
  body: z.string(),
  path: z.string(),
  subject_type: z.string().nullish(),
  side,
  start_side: side.nullish(),
  line,
  start_line: line,
  original_line: line,
  original_start_line: line,
  commit_id: sha,
  original_commit_id: sha,
  in_reply_to_id: id.optional(),
  created_at: z.string(),
});

/** A review of a pull request; its body, when it has one, is a general comment. */
export const githubReviewSchema = z.object({
  id,
  user,
  body: z.string().nullish(),
  state: z.string(),
  commit_id: sha.nullish(),
  submitted_at: z.string().optional(),
});

/** A comment on the conversation of a pull request. */
export const githubIssueCommentSchema = z.object({
  id,
  user,
  body: z.string(),
  created_at: z.string(),
});

/** What GitHub answers when it made or changed something: a review, or a comment of the conversation. Its id is all the review reads. */
export const githubWrittenSchema = z.object({ id });

/**
 * A comment of one review as `GET /repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}/comments` lists it. Only
 * its id and its text are read: the text ends with the marker the comment is known by.
 */
export const githubWrittenCommentSchema = z.object({ id, body: z.string() });

/**
 * The body GitHub sends with an error. `errors` is a list of texts or of objects with a `message`, or one text;
 * `status` is the HTTP status as text.
 */
export const githubWriteErrorSchema = z.object({
  message: z.string().optional(),
  errors: z.unknown().optional(),
  status: z.string().optional(),
});
