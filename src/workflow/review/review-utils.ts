import { PlatformChoiceError } from "../../capability/platform/PlatformChoiceError.ts";
import { PlatformError } from "../../capability/platform/PlatformError.ts";
import { ReviewInputError } from "../../harnesses/review/ReviewInputError.ts";
import type { JudgedFinding } from "../../harnesses/review/types/review.ts";

/**
 * Whether the judge could not judge any finding of a review that has findings: every one carries a judge error. Such
 * a review checked none of what it found, so a review that is to write plans and writes no comment from it.
 */
export function judgedNothing(findings: readonly JudgedFinding[]): boolean {
  return findings.length > 0 && findings.every((finding) => "judge_error" in finding);
}

/**
 * The error that ends a review of merge request `number` for a failed read from its platform, with the flag before
 * the message. What the user can put right is a wrong input and ends the command with 2: a platform that cannot be
 * told, a tool that is missing or not signed in, a merge request or a repository that is not found. A read the
 * platform failed at, such as a server error or an answer that cannot be read, stays a platform error and ends it
 * with 1. Any other error is given back as it is.
 */
export function mergeRequestReadError(number: number, error: unknown): unknown {
  if (!(error instanceof PlatformError) && !(error instanceof PlatformChoiceError)) return error;

  const message = `--mr ${number}: ${error.message}`;

  if (error instanceof PlatformError && error.kind === "failed") return new PlatformError("failed", message);

  return new ReviewInputError(message);
}
