import { Capability } from "@kerpetensh/harness-kit";
import { terminalLine } from "../../text/text-utils.ts";
import { CommentRef } from "./CommentRef.ts";
import { GitHubCli } from "./GitHubCli.ts";
import { PlatformError } from "./PlatformError.ts";
import {
  githubIssueCommentSchema,
  githubPullRequestSchema,
  githubReviewCommentSchema,
  githubReviewSchema,
} from "./schemas/github-schema.ts";
import type { GitHubIssueComment, GitHubPullRequest, GitHubReview, GitHubReviewComment } from "./types/github.ts";
import type { MergeRequest, Platform, PlatformComment, PlatformComments, PlatformSide } from "./types/platform.ts";

/**
 * GitHub behind the `Platform` interface: reads a pull request and its comments with `gh api` in the run's repository,
 * so the sign-in is the one of the GitHub CLI and Kerpeten holds no GitHub token. How gh is started, and for which
 * repository, is what `GitHubCli` says: the repository of the `origin` remote, named in every call, so the pull
 * request of another repository with the same number is never read. The answer is checked to be of that repository
 * all the same.
 *
 * `gh api` can do whatever the sign-in can. So every public method is typed and builds its own arguments, each call is
 * a GET, and no method takes arguments from its caller. This class only reads: it has no call that writes, and the
 * capability that writes comments is another one, which a review that only shows its plan never calls. The capability
 * declares no permission, so no tool of a model can take it. What it reads is outside data: nothing of it is run.
 *
 * Every read has a budget, `PlatformLimits`: the bytes gh may print and the time it may take. A read that reaches
 * either is stopped. For the pull request that is an error; for a list of comments the result is incomplete and says
 * which limit stopped it.
 */
@Capability({
  name: "github-platform",
  description:
    "Reads a pull request and its comments from GitHub with gh api, from the repository the origin remote names, through typed methods that only read; no tool can take it.",
  scope: "run",
})
export class GitHubPlatform extends GitHubCli implements Platform {
  private static readonly SIDES: Readonly<Record<"LEFT" | "RIGHT", PlatformSide>> = { LEFT: "old", RIGHT: "new" };

  private static readonly WHOLE_FILE = "file";

  private static unreadable(number: number, reason: string): PlatformError {
    return new PlatformError("failed", `the answer of gh for pull request ${number} cannot be read: ${reason}`);
  }

  private static host(pull: GitHubPullRequest): string {
    let url: URL;

    try {
      url = new URL(pull.html_url);
    } catch {
      throw GitHubPlatform.unreadable(pull.number, "html_url is no URL");
    }

    if (url.host === "") throw GitHubPlatform.unreadable(pull.number, "html_url has no host");

    return url.host.toLowerCase();
  }

  /**
   * A review comment in the platform's words. Its lines are the ones gh gives for the pull request as it is now, and
   * the ones the comment was written on when it is outdated; `commit` is the head commit of that state. The lines
   * count on the side of the comment's last line. A comment whose first line is on the other side gives its last
   * line alone. A comment on a whole file has no lines and no side, whatever line gh names for it.
   */
  private static lineComment(comment: GitHubReviewComment): PlatformComment {
    const current = comment.line ?? undefined;
    const end = current ?? comment.original_line ?? undefined;
    const first = current === undefined ? comment.original_start_line : comment.start_line;
    const onLines = comment.subject_type !== GitHubPlatform.WHOLE_FILE && end !== undefined;
    const oneSide = (comment.start_side ?? comment.side) === comment.side;

    return {
      id: String(comment.id),
      ref: CommentRef.of("github", "review_comment", comment.id).text,
      kind: "line",
      author: comment.user?.login ?? null,
      body: comment.body,
      file: comment.path,
      lines: onLines ? { start: oneSide ? (first ?? end) : end, end } : null,
      side: onLines ? GitHubPlatform.SIDES[comment.side] : null,
      commit: current === undefined ? comment.original_commit_id : comment.commit_id,
      replyTo: comment.in_reply_to_id === undefined ? null : String(comment.in_reply_to_id),
      createdAt: comment.created_at,
    };
  }

  private static conversationComment(comment: GitHubIssueComment): PlatformComment {
    return {
      id: String(comment.id),
      ref: CommentRef.of("github", "issue_comment", comment.id).text,
      kind: "general",
      author: comment.user?.login ?? null,
      body: comment.body,
      file: null,
      lines: null,
      side: null,
      commit: null,
      replyTo: null,
      createdAt: comment.created_at,
    };
  }

  private static reviewBody(review: GitHubReview, body: string): PlatformComment {
    return {
      id: String(review.id),
      ref: CommentRef.of("github", "review", review.id).text,
      kind: "general",
      author: review.user?.login ?? null,
      body,
      file: null,
      lines: null,
      side: null,
      commit: review.commit_id ?? null,
      replyTo: null,
      createdAt: review.submitted_at ?? null,
    };
  }

  /**
   * The pull request `number` of the repository of the `origin` remote. A read that fails throws a `PlatformError`,
   * and so does an answer that is not the pull request asked for or not of that repository.
   */
  public async mergeRequest(number: number): Promise<MergeRequest> {
    GitHubCli.assertNumber(number);

    const project = await this.repository();
    const result = await this.get(project, [`repos/${project.path}/pulls/${number}`]);

    if (result.kind !== "exited") {
      throw new PlatformError("failed", `pull request ${number} was not read: ${GitHubCli.stopped(result)}`);
    }

    if (result.exitCode !== 0) throw GitHubCli.failure(result, number, project);

    let answer: unknown;

    try {
      answer = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw GitHubPlatform.unreadable(number, "it is no JSON");
    }

    const parsed = githubPullRequestSchema.safeParse(answer);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];

      throw GitHubPlatform.unreadable(number, `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "not as expected"}`);
    }

    const pull = parsed.data;

    if (pull.number !== number) throw GitHubPlatform.unreadable(number, `it is pull request ${pull.number}`);

    if (!project.is(pull.base.repo.full_name)) {
      throw new PlatformError(
        "failed",
        `gh answered with a pull request of ${JSON.stringify(terminalLine(pull.base.repo.full_name))}, not of ${project.path}, the repository of the origin remote; when the repository was renamed or moved, point the origin remote at its new address and run again`,
      );
    }

    return {
      kind: "github",
      host: GitHubPlatform.host(pull),
      projectId: String(pull.base.repo.id),
      number: pull.number,
      title: pull.title,
      description: pull.body ?? "",
      state: pull.merged ? "merged" : pull.state,
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
      baseRef: pull.base.ref,
    };
  }

  /**
   * The comments of pull request `number`: the comments on lines, then the bodies of the reviews, which are general
   * comments, then the comments of the conversation. Each of the three lists is read to its last page. A list
   * that gh did not read to its end, or whose entries cannot all be read, makes the result incomplete: it holds what
   * was read, and `problems` names the list. So does a list that is larger than the byte limit of a read or takes
   * longer than its time limit: the entries of the pages that stand whole before the stop are kept. A missing gh, a
   * missing sign-in, an unknown pull request and an `origin` remote that names no GitHub repository throw a
   * `PlatformError`, because then nothing can be read.
   */
  public async comments(number: number): Promise<PlatformComments> {
    GitHubCli.assertNumber(number);

    const project = await this.repository();
    const pull = `repos/${project.path}/pulls/${number}`;
    const onLines = await this.list(project, `${pull}/comments`, number, githubReviewCommentSchema);
    const reviews = await this.list(project, `${pull}/reviews`, number, githubReviewSchema);

    const conversation = await this.list(
      project,
      `repos/${project.path}/issues/${number}/comments`,
      number,
      githubIssueCommentSchema,
    );

    const problems = [...onLines.problems, ...reviews.problems, ...conversation.problems];

    return {
      comments: [
        ...onLines.items.map((comment) => GitHubPlatform.lineComment(comment)),
        ...reviews.items.flatMap((review) => {
          const body = review.body ?? "";

          return body.trim() === "" ? [] : [GitHubPlatform.reviewBody(review, body)];
        }),
        ...conversation.items.map((comment) => GitHubPlatform.conversationComment(comment)),
      ],
      complete: problems.length === 0,
      problems,
    };
  }
}
