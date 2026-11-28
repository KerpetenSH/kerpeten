import { shortLine, terminalLine } from "../../text/text-utils.ts";
import { GitHubCli } from "./GitHubCli.ts";
import type { RemoteProject } from "./RemoteProject.ts";
import { githubWriteErrorSchema, githubWrittenSchema } from "./schemas/github-schema.ts";
import type { GitHubBlock, GitHubWriteError, GitHubWriteResult } from "./types/github.ts";
import type { PlatformExit, PlatformRead } from "./types/platform.ts";

/**
 * Says what an answer of `gh api` to a write means. It is the one place that tells the cases apart:
 *
 * - `written`: gh ended with 0 and printed what GitHub made, with its id.
 * - `invalid`: GitHub answered HTTP 422 and every entry of its `errors` names the place of a comment that it cannot
 *   find, so it wrote nothing. For a review of line comments that is the answer to a comment whose line is not in the
 *   diff as GitHub sees it, and the caller finds that comment by sending less. `PLACES` lists the entries that are
 *   known to say so: `Line could not be resolved` is what GitHub answers today, and its words for the other parts of
 *   a place are taken to follow the same form.
 * - `denied`: GitHub answered HTTP 403 or 404: the account may not do this, or what the write is for is not there.
 *   Nothing was written.
 * - `failed`: everything else. The message starts with `not written:` when GitHub wrote nothing for sure: it
 *   answered with a status from 400 to 499, which is a request it refused, or gh is not signed in. It starts with
 *   `it is not known whether GitHub wrote it:` in every other case: the call was stopped at its time or output limit,
 *   its answer cannot be read, GitHub answered with a server error, or gh ended with an error and named no status,
 *   as it does when the connection breaks, which can be after GitHub took the request.
 *
 * A 422 that names no place must not be taken for one: it is `failed` and never `invalid`, so nothing is sent again
 * on its account. `BLOCKS` lists the ones that are known, with what to do. GitHub's own text is kept in every reason
 * and message; it is outside data, so it is brought to one line without control characters and cut to `MAX_TEXT`
 * characters.
 */
export class GitHubWriteAnswer {
  public static readonly MAX_TEXT = 500;

  private static readonly INVALID = 422;

  private static readonly FORBIDDEN = 403;

  private static readonly FIRST_REFUSED = 400;

  private static readonly LAST_REFUSED = 499;

  private static readonly STATUS = /\(HTTP ([0-9]{3})\)/;

  private static readonly PLACES: readonly RegExp[] = [
    /^(?:line|start line|path|side|start side|position) could not be resolved\.?$/i,
    /\bline must be part of the diff\b/i,
  ];

  private static readonly LIMITED = /rate limit|abuse/i;

  private static readonly BLOCKS: readonly GitHubBlock[] = [
    {
      answer: /pending review/i,
      advice:
        "your account has a review on this pull request that is not submitted yet, and GitHub takes no other review beside it: submit or delete that review on the page of the pull request and run again",
    },
  ];

  private static readonly MS_PER_SECOND = 1000;

  private static readonly AGAIN = "run again: what is already written is not written a second time";

  /** What the answer `read` of gh to a write for pull request `number` of `project` means. */
  public static of(read: PlatformRead, number: number, project: RemoteProject): GitHubWriteResult {
    if (read.kind === "timed_out") {
      return GitHubWriteAnswer.unknown(`gh did not finish within ${read.ms / GitHubWriteAnswer.MS_PER_SECOND} seconds`);
    }

    if (read.kind === "too_large") return GitHubWriteAnswer.unknown(`gh printed more than ${read.bytes} bytes`);

    if (read.exitCode === 0) {
      const written = githubWrittenSchema.safeParse(GitHubWriteAnswer.json(read));

      return written.success
        ? { kind: "written", id: written.data.id }
        : GitHubWriteAnswer.unknown("gh ended without an error, but its answer does not name what GitHub made");
    }

    const parsed = githubWriteErrorSchema.safeParse(GitHubWriteAnswer.json(read));
    const body = parsed.success ? parsed.data : undefined;
    const stderr = terminalLine(read.stderr);
    const status = GitHubWriteAnswer.status(body, stderr);
    const errors = GitHubWriteAnswer.errors(body?.errors);
    const texts = [body?.message, ...errors].filter((text) => text !== undefined && text.trim() !== "");
    const said = shortLine(terminalLine(texts.length === 0 ? stderr : texts.join(": ")), GitHubWriteAnswer.MAX_TEXT);
    const failure = GitHubCli.failure(read, number, project);

    if (failure.kind === "signed_out") return { kind: "failed", message: `not written: ${failure.message}` };

    if (status === GitHubWriteAnswer.INVALID) return GitHubWriteAnswer.invalid(errors, said);

    if (failure.kind === "not_found") {
      return {
        kind: "denied",
        message: `not written: GitHub did not find what the write is for (HTTP 404): pull request ${number} or the comment was removed, or the account gh is signed in to ${project.host} with may not write to ${project.path}`,
      };
    }

    if (status === GitHubWriteAnswer.FORBIDDEN && !GitHubWriteAnswer.LIMITED.test(said)) {
      return {
        kind: "denied",
        message: `not written: GitHub does not let the account gh is signed in to ${project.host} with do this (HTTP 403): ${said}`,
      };
    }

    if (status !== undefined && status >= GitHubWriteAnswer.FIRST_REFUSED && status <= GitHubWriteAnswer.LAST_REFUSED) {
      return { kind: "failed", message: `not written: ${failure.message}` };
    }

    return GitHubWriteAnswer.unknown(failure.message);
  }

  /**
   * What a request GitHub refused with HTTP 422 means: `invalid` when every entry of its errors names a place that
   * cannot be found, a failed write with what to do when it is a known block, and a failed write with GitHub's text
   * for any other.
   */
  private static invalid(errors: readonly string[], said: string): GitHubWriteResult {
    const places = errors.every((entry) => GitHubWriteAnswer.PLACES.some((place) => place.test(entry.trim())));

    if (errors.length > 0 && places) return { kind: "invalid", reason: said };

    const block = GitHubWriteAnswer.BLOCKS.find((candidate) => candidate.answer.test(said));

    return {
      kind: "failed",
      message:
        block === undefined
          ? `not written: GitHub refused the request as invalid (HTTP 422): ${said}`
          : `not written: ${block.advice} (GitHub answered: ${said})`,
    };
  }

  /**
   * The HTTP status of an answer gh gave an error for, or `undefined` when it names none. gh prints the body of the
   * error on stdout and one line with the status on stderr; the status is taken from the line, and from the body when
   * the line has none.
   */
  private static status(body: GitHubWriteError | undefined, stderr: string): number | undefined {
    const named = GitHubWriteAnswer.STATUS.exec(stderr)?.[1] ?? body?.status;
    const status = Number(named);

    return named === undefined || !Number.isSafeInteger(status) ? undefined : status;
  }

  private static unknown(reason: string): GitHubWriteResult {
    return {
      kind: "failed",
      message: `it is not known whether GitHub wrote it: ${reason}; ${GitHubWriteAnswer.AGAIN}`,
    };
  }

  private static json(read: PlatformExit): unknown {
    try {
      return JSON.parse(read.stdout.toString("utf8"));
    } catch {
      return undefined;
    }
  }

  /** The texts of the `errors` of an error body: a list of texts or of objects with a `message`, or one text. */
  private static errors(errors: unknown): string[] {
    const list = Array.isArray(errors) ? errors : [errors];

    return list.flatMap((entry: unknown) => {
      if (typeof entry === "string") return [entry];

      if (typeof entry !== "object" || entry === null) return [];

      return "message" in entry && typeof entry.message === "string" ? [entry.message] : [JSON.stringify(entry)];
    });
  }
}
