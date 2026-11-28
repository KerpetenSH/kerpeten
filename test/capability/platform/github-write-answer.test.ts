import { describe, expect, test } from "bun:test";
import { GitHubWriteAnswer } from "../../../src/capability/platform/GitHubWriteAnswer.ts";
import { RemoteProject } from "../../../src/capability/platform/RemoteProject.ts";
import type { PlatformRead } from "../../../src/capability/platform/types/platform.ts";
import { GITHUB_ORIGIN } from "./platform-utils.ts";

const project = RemoteProject.parse(GITHUB_ORIGIN);

const AGAIN = "run again: what is already written is not written a second time";

/** A call of gh that ended with `exitCode`, having printed `stdout` and written `stderr`. */
function exited(exitCode: number, stdout: unknown, stderr = ""): PlatformRead {
  const text = typeof stdout === "string" ? stdout : JSON.stringify(stdout);

  return { kind: "exited", exitCode, stdout: Buffer.from(text), stderr };
}

/** What gh gives for a request GitHub refused with HTTP 422 and the error body `body`. */
function invalid(body: unknown, stderr = "gh: Unprocessable Entity (HTTP 422)\n"): PlatformRead {
  return exited(1, body, stderr);
}

/** What gh gives for a review GitHub refused with HTTP 422 and the `errors` given, in the form GitHub answers today. */
function refused(...errors: unknown[]): PlatformRead {
  return invalid({
    message: "Unprocessable Entity",
    errors,
    documentation_url: "https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request",
    status: "422",
  });
}

/** What gh gives for a request GitHub answered with `status` and `message`. */
function answered(status: number, message: string): PlatformRead {
  return exited(1, { message, status: String(status) }, `gh: ${message} (HTTP ${status})\n`);
}

function answer(read: PlatformRead) {
  return GitHubWriteAnswer.of(read, 12, project);
}

describe("GitHub write answer", () => {
  test("an answer with exit code 0 and an id is written", () => {
    expect(answer(exited(0, { id: 9001, state: "COMMENTED" }))).toEqual({ kind: "written", id: 9001 });
  });

  test("the answer GitHub gives for a review with a line outside the diff is invalid, with its text as the reason", () => {
    expect(answer(refused("Line could not be resolved"))).toEqual({
      kind: "invalid",
      reason: "Unprocessable Entity: Line could not be resolved",
    });
  });

  test("a 422 whose errors all name a place that cannot be found is invalid, in each form that is known", () => {
    const places = [
      "Start line could not be resolved",
      "Path could not be resolved",
      "Side could not be resolved",
      "Start side could not be resolved",
      "Position could not be resolved",
      "line could not be resolved.",
      "Pull request review thread line must be part of the diff and Pull request review thread diff hunk can't be blank",
      {
        resource: "PullRequestReviewComment",
        field: "line",
        message: "pull_request_review_thread.line must be part of the diff",
      },
    ];

    for (const place of places)
      expect({ place, kind: answer(refused(place)).kind }).toEqual({ place, kind: "invalid" });

    expect(answer(refused("Line could not be resolved", "Path could not be resolved"))).toEqual({
      kind: "invalid",
      reason: "Unprocessable Entity: Line could not be resolved: Path could not be resolved",
    });

    const oneText = { message: "Unprocessable Entity", errors: "Line could not be resolved", status: "422" };

    expect(answer(exited(1, oneText, "gh: Line could not be resolved (Unprocessable Entity)\n"))).toEqual({
      kind: "invalid",
      reason: "Unprocessable Entity: Line could not be resolved",
    });
  });

  test("a 422 that names no place is a failed write with GitHub's text, never invalid: nothing is sent again for it", () => {
    const others: unknown[][] = [
      ["Review was flagged as spam"],
      ["Commit could not be resolved"],
      ["Line could not be resolved", "Review was flagged as spam"],
      ["The line could not be resolved because the review is locked"],
      [{ code: "custom", field: "body" }],
      [],
    ];

    for (const errors of others) {
      expect({ errors, kind: answer(refused(...errors)).kind }).toEqual({ errors, kind: "failed" });
    }

    expect(answer(refused("Review was flagged as spam"))).toEqual({
      kind: "failed",
      message:
        "not written: GitHub refused the request as invalid (HTTP 422): Unprocessable Entity: Review was flagged as spam",
    });

    expect(answer(invalid({ message: "Validation Failed", errors: [{ code: "custom", field: "body" }] }))).toEqual({
      kind: "failed",
      message:
        'not written: GitHub refused the request as invalid (HTTP 422): Validation Failed: {"code":"custom","field":"body"}',
    });

    expect(answer(invalid("<html>no JSON</html>"))).toEqual({
      kind: "failed",
      message: "not written: GitHub refused the request as invalid (HTTP 422): gh: Unprocessable Entity (HTTP 422)",
    });
  });

  test("a 422 about a pending review is failed, with what to do and GitHub's text", () => {
    expect(answer(refused("User can only have one pending review per pull request"))).toEqual({
      kind: "failed",
      message:
        "not written: your account has a review on this pull request that is not submitted yet, and GitHub takes no other review beside it: submit or delete that review on the page of the pull request and run again (GitHub answered: Unprocessable Entity: User can only have one pending review per pull request)",
    });
  });

  test("GitHub's text is outside data: it is brought to one line without control characters and cut", () => {
    const result = answer(invalid({ message: `Bad\n\u001b[31mred\u0007 ${"x".repeat(2000)}` }));
    const start = "not written: GitHub refused the request as invalid (HTTP 422): ";

    expect(result.kind).toBe("failed");

    const message = result.kind === "failed" ? result.message : "";

    expect(message).toStartWith(`${start}Bad �[31mred� xxx`);
    expect(message.length).toBe(start.length + GitHubWriteAnswer.MAX_TEXT);
  });

  test("a request GitHub refused with a status from 400 to 499, and a gh that is not signed in, wrote nothing for sure", () => {
    expect(answer(answered(400, "Problems parsing JSON"))).toEqual({
      kind: "failed",
      message: "not written: gh api failed (exit 1): gh: Problems parsing JSON (HTTP 400)",
    });

    expect(answer(answered(429, "Too Many Requests"))).toEqual({
      kind: "failed",
      message: "not written: gh api failed (exit 1): gh: Too Many Requests (HTTP 429)",
    });

    expect(answer(answered(403, "API rate limit exceeded for user ID 1."))).toEqual({
      kind: "failed",
      message: "not written: gh api failed (exit 1): gh: API rate limit exceeded for user ID 1. (HTTP 403)",
    });

    const signIn =
      "not written: gh is not signed in to github.com: run `gh auth login --hostname github.com` and run again";

    expect(answer(exited(4, "", "gh: To get started with GitHub CLI, please run: gh auth login\n"))).toEqual({
      kind: "failed",
      message: signIn,
    });

    expect(answer(answered(401, "Bad credentials"))).toEqual({ kind: "failed", message: signIn });
  });

  test("a 403 and a 404 are denied: the account may not do this, or what the write is for is not there", () => {
    expect(answer(answered(403, "Resource not accessible by personal access token"))).toEqual({
      kind: "denied",
      message:
        "not written: GitHub does not let the account gh is signed in to github.com with do this (HTTP 403): Resource not accessible by personal access token",
    });

    expect(answer(answered(404, "Not Found"))).toEqual({
      kind: "denied",
      message:
        "not written: GitHub did not find what the write is for (HTTP 404): pull request 12 or the comment was removed, or the account gh is signed in to github.com with may not write to Acme/Shop",
    });
  });

  test("a server error, and an error of gh that names no status, leave it unknown whether GitHub wrote, and say so", () => {
    expect(answer(answered(502, "Server Error"))).toEqual({
      kind: "failed",
      message: `it is not known whether GitHub wrote it: gh api failed (exit 1): gh: Server Error (HTTP 502); ${AGAIN}`,
    });

    expect(answer(answered(500, "Internal Server Error")).kind).toBe("failed");

    const broken = 'Post "https://api.github.com/repos/Acme/Shop/pulls/12/reviews": unexpected EOF';

    expect(answer(exited(1, "", `${broken}\n`))).toEqual({
      kind: "failed",
      message: `it is not known whether GitHub wrote it: gh api failed (exit 1): ${broken}; ${AGAIN}`,
    });

    expect(answer(exited(1, "", ""))).toEqual({
      kind: "failed",
      message: `it is not known whether GitHub wrote it: gh api failed (exit 1): it gave no error text; ${AGAIN}`,
    });
  });

  test("a call stopped at a limit, and an answer without an id, leave it unknown too", () => {
    expect(answer({ kind: "timed_out", stdout: Buffer.from(""), ms: 120_000 })).toEqual({
      kind: "failed",
      message: `it is not known whether GitHub wrote it: gh did not finish within 120 seconds; ${AGAIN}`,
    });

    expect(answer({ kind: "too_large", stdout: Buffer.from(""), bytes: 20_000_000 })).toEqual({
      kind: "failed",
      message: `it is not known whether GitHub wrote it: gh printed more than 20000000 bytes; ${AGAIN}`,
    });

    for (const stdout of ["", "not JSON", { id: "x" }, []]) {
      expect(answer(exited(0, stdout))).toEqual({
        kind: "failed",
        message: `it is not known whether GitHub wrote it: gh ended without an error, but its answer does not name what GitHub made; ${AGAIN}`,
      });
    }
  });
});
