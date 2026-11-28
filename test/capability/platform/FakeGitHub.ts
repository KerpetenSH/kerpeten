import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  FakeGitHubRequest,
  FakeGitHubState,
  FakeIssueComment,
  FakeLineComment,
  FakeReviewRequest,
} from "./types/fake-github.ts";
import type { CliAnswer } from "./types/platform.ts";

/**
 * A GitHub that lives in one file, behind a fake `gh api`: it holds one pull request with its reviews, its comments on
 * lines and the comments of its conversation, gives them to a read and keeps what a write sends, with ids of its own.
 * So a second run of a command finds what the first one wrote. `main` is one call of gh: it reads the state, answers
 * as gh does, on stdout and stderr and with gh's exit code, and writes the state back with the call added.
 *
 * It answers the requests Kerpeten makes and no other: a request it does not know ends with 97.
 */
export class FakeGitHub {
  public static readonly STATE_FILE = "github.json";

  public static readonly USER = "the-user";

  public static readonly NOW = "2026-11-28T10:00:00Z";

  public static readonly NOT_IN_DIFF = "Line could not be resolved";

  public static readonly REVIEW_DOCS = "https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request";

  public static readonly PENDING = "User can only have one pending review per pull request";

  public static readonly NOT_YOURS = "Resource not accessible by personal access token";

  private static readonly UNKNOWN_EXIT = 97;

  private static readonly HANG_MS = 30_000;

  private readonly state: FakeGitHubState;

  private constructor(state: FakeGitHubState) {
    this.state = state;
  }

  /** The state the fake GitHub in `dir` holds. */
  public static read(dir: string): FakeGitHubState {
    return JSON.parse(readFileSync(join(dir, FakeGitHub.STATE_FILE), "utf8"));
  }

  /** One call of the fake gh in `dir` with the arguments `argv`; gives the exit code. */
  public static async main(dir: string, argv: readonly string[]): Promise<number> {
    const github = new FakeGitHub(FakeGitHub.read(dir));
    const input = argv.includes("--input") ? await Bun.stdin.text() : undefined;

    github.state.calls.push({ args: argv, ...(input === undefined ? {} : { input }) });

    const answer = github.answer(FakeGitHub.request(argv, input));

    writeFileSync(join(dir, FakeGitHub.STATE_FILE), JSON.stringify(github.state));
    process.stdout.write(answer.stdout ?? "");
    process.stderr.write(answer.stderr ?? "");

    if (answer.hangs === true) await Bun.sleep(FakeGitHub.HANG_MS);

    return answer.exitCode ?? 0;
  }

  /**
   * What gh answers for a request GitHub refused with `status`: the body on stdout, in the form GitHub gave for a
   * review with a line outside the diff, and one line on stderr.
   */
  public static refusal(status: number, message: string, errors: readonly string[] = []): CliAnswer {
    return {
      stdout: JSON.stringify({
        message,
        ...(errors.length === 0 ? {} : { errors }),
        documentation_url: FakeGitHub.REVIEW_DOCS,
        status: String(status),
      }),
      stderr: `gh: ${message} (HTTP ${status})\n`,
      exitCode: 1,
    };
  }

  private static request(argv: readonly string[], input: string | undefined): FakeGitHubRequest {
    const valued = ["--method", "--hostname", "--input"];
    const words: string[] = [];
    let method = "GET";

    for (let at = 1; at < argv.length; at++) {
      const word = argv[at] ?? "";

      if (word === "--method") method = argv[at + 1] ?? "";

      if (valued.includes(word)) at++;
      else if (!word.startsWith("--")) words.push(word);
    }

    return {
      method,
      path: (words[0] ?? "").replace(/^repos\/[^/]+\/[^/]+\//, "").replace(/\?.*$/, ""),
      slurp: argv.includes("--slurp"),
      input,
    };
  }

  private answer(request: FakeGitHubRequest): CliAnswer {
    const { state } = this;
    const { method, path } = request;
    const route = `${method} ${path.replace(/[0-9]+/g, "N")}`;
    const id = Number(/([0-9]+)(?:\/comments)?$/.exec(path)?.[1]);

    const list = (items: readonly unknown[]): CliAnswer => ({
      stdout: JSON.stringify(request.slurp ? [items] : items),
    });

    switch (route) {
      case "GET pulls/N":
        return { stdout: this.pull() };
      case "GET pulls/N/comments":
        return list(state.lineComments);
      case "GET pulls/N/reviews":
        return list(state.reviews);
      case "GET issues/N/comments":
        return list(state.conversation);
      case "GET pulls/N/reviews/N/comments":
        return state.rules.readBack ?? list(this.commentsOf(id));
      case "POST pulls/N/reviews":
        return this.review(JSON.parse(request.input ?? ""));
      case "POST issues/N/comments":
        return state.rules.summary ?? this.comment(JSON.parse(request.input ?? "").body);
      case "PATCH issues/comments/N":
        return state.rules.summary ?? this.update(id, JSON.parse(request.input ?? "").body);
      default:
        return { stderr: `the fake gh has no answer for: ${route}\n`, exitCode: FakeGitHub.UNKNOWN_EXIT };
    }
  }

  /** The pull request as it is read now: at the commit of the rule `movesTo` from the second read on. */
  private pull(): string {
    const { state } = this;
    const moved = state.pullReads++ > 0 ? state.rules.movesTo : undefined;

    if (moved === undefined) return state.pull;

    const pull = JSON.parse(state.pull);

    return JSON.stringify({ ...pull, head: { ...pull.head, sha: moved } });
  }

  /** The comments of one review as GitHub lists them there: without the side and the lines of a comment. */
  private commentsOf(review: number): unknown[] {
    return this.state.lineComments
      .filter((comment) => comment.pull_request_review_id === review)
      .map(({ id, pull_request_review_id, user, body, path, commit_id }) => ({
        id,
        pull_request_review_id,
        user,
        body,
        path,
        commit_id,
      }));
  }

  private review(request: FakeReviewRequest): CliAnswer {
    const { rules } = this.state;

    if (rules.review !== undefined && rules.keepsReview !== true) return rules.review;

    if (rules.pendingReview === true) return FakeGitHub.refusal(422, "Unprocessable Entity", [FakeGitHub.PENDING]);

    if (request.comments.some((comment) => rules.refusedLines?.includes(comment.line))) {
      return FakeGitHub.refusal(422, "Unprocessable Entity", [FakeGitHub.NOT_IN_DIFF]);
    }

    const id = this.state.nextId++;
    const user = { login: FakeGitHub.USER };

    this.state.reviews.push({
      id,
      user,
      body: "",
      state: "COMMENTED",
      commit_id: request.commit_id,
      submitted_at: FakeGitHub.NOW,
    });

    for (const comment of request.comments) {
      const line: FakeLineComment = {
        id: this.state.nextId++,
        pull_request_review_id: id,
        user,
        body: comment.body,
        path: comment.path,
        subject_type: "line",
        side: comment.side,
        start_side: comment.start_side ?? null,
        line: comment.line,
        start_line: comment.start_line ?? null,
        original_line: comment.line,
        original_start_line: comment.start_line ?? null,
        commit_id: request.commit_id,
        original_commit_id: request.commit_id,
        created_at: FakeGitHub.NOW,
      };

      this.state.lineComments.push(line);
    }

    return rules.review ?? { stdout: JSON.stringify({ id, user, state: "COMMENTED", commit_id: request.commit_id }) };
  }

  private comment(body: string): CliAnswer {
    const comment: FakeIssueComment = {
      id: this.state.nextId++,
      user: { login: FakeGitHub.USER },
      body,
      created_at: FakeGitHub.NOW,
    };

    this.state.conversation.push(comment);

    return { stdout: JSON.stringify(comment) };
  }

  private update(id: number, body: string): CliAnswer {
    const comment = this.state.conversation.find((candidate) => candidate.id === id);

    if (comment === undefined) return FakeGitHub.refusal(404, "Not Found");

    if (this.state.rules.foreignComments?.includes(id) === true) return FakeGitHub.refusal(403, FakeGitHub.NOT_YOURS);

    comment.body = body;

    return { stdout: JSON.stringify(comment) };
  }
}
