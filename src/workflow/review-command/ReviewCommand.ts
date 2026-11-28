import {
  type After,
  type CommandArgs,
  ExitCode,
  PermissionGroupSet,
  UsageError,
  Workflow,
  WorkflowBase,
} from "@kerpetensh/harness-kit";
import { Git } from "../../capability/git/Git.ts";
import { GitTimeoutError } from "../../capability/git/GitTimeoutError.ts";
import { PermissionGroups } from "../../capability/PermissionGroups.ts";
import { ReviewInputError } from "../../harnesses/review/ReviewInputError.ts";
import { errorMessage } from "../../text/text-utils.ts";
import { ReviewWorkflow } from "../review/ReviewWorkflow.ts";
import { planStopMessage } from "./review-command-utils.ts";
import { ReviewFlagStep } from "./step/ReviewFlagStep.ts";
import { ReviewOutcomeStep } from "./step/ReviewOutcomeStep.ts";
import { ReviewPrintStep } from "./step/ReviewPrintStep.ts";
import { ReviewSetupStep } from "./step/ReviewSetupStep.ts";
import type { ReviewFlags } from "./types/review-command.ts";

/**
 * The `review` command: checks the flags, gets the review ready, runs the local review workflow, which it lists in its
 * chain and which joins its run of the flag's permission group, and prints the result. An error of the local review
 * ends the command with 2 when the input was wrong, which a pull request or merge request of `--mr` is that the user
 * can make readable, and with 1 otherwise, a failure of the platform among them, or with the ChatGPT plan's stop when
 * the plan stopped it. A review that wrote its comments ends with 1 when one of them could not be written, after the
 * findings are printed.
 */
@Workflow({
  name: "review-command",
  description:
    "Review the change between the base branch and HEAD and print the findings. The reviewer model finds them, the judge model checks and labels each one, and the scorer gives it a score and the action a posted review would take. Both models only read the repository. --mr <n> reviews pull request n on GitHub, read with gh, or merge request n on GitLab, read with glab, of the project the origin remote names, with its title and description; HEAD must be its last commit. Without --dry-run the review writes its comments to the pull request, from the account gh is signed in with: one comment on the lines of each finding that earns one, and one summary comment. With --dry-run it writes nothing and shows the comments it would write. Writing to GitLab is not built yet, and a review without --mr needs --dry-run.",
  steps: [ReviewFlagStep, ReviewSetupStep, ReviewWorkflow, ReviewOutcomeStep, ReviewPrintStep],
  command: {
    name: "review",
    usage:
      "[--dry-run] [--full] [--base <rev>] [--mr <n>] [--context-file <path>] [--extra-context <path or ->] [--json]",
    options: {
      "dry-run": { type: "boolean" },
      full: { type: "boolean" },
      base: { type: "string" },
      mr: { type: "string" },
      "context-file": { type: "string" },
      "extra-context": { type: "string" },
      json: { type: "boolean" },
    },
    oneOf: {
      flags: PermissionGroups.SET.names,
      fallback: PermissionGroupSet.ALL,
      label: "permission group",
    },
  },
})
export class ReviewCommand extends WorkflowBase<ReviewFlags, After<typeof ReviewPrintStep>, number> {
  private static readonly MR_NUMBER = /^[1-9][0-9]*$/;

  private static mergeRequestNumber(value: string): number {
    const number = Number(value);

    if (!ReviewCommand.MR_NUMBER.test(value) || !Number.isSafeInteger(number)) {
      throw new UsageError("--mr must be the number of a pull request or merge request, 1 or more");
    }

    return number;
  }

  public override commandInput(args: CommandArgs): ReviewFlags {
    const base = args.string("base");

    if (base !== undefined) {
      try {
        Git.assertRevision(base);
      } catch {
        throw new UsageError("--base must be a commit or branch name");
      }
    }

    const mrFlag = args.string("mr");
    const mr = mrFlag === undefined ? undefined : ReviewCommand.mergeRequestNumber(mrFlag);

    if (mr !== undefined && base !== undefined) {
      throw new UsageError("--mr and --base do not go together: the pull request or merge request names its own base");
    }

    const contextFile = args.string("context-file");

    if (contextFile !== undefined && (contextFile === "" || contextFile.includes("\0"))) {
      throw new UsageError("--context-file needs a path");
    }

    const extraContext = args.string("extra-context");

    if (extraContext !== undefined && (extraContext === "" || extraContext.includes("\0"))) {
      throw new UsageError("--extra-context needs a path, or - for stdin");
    }

    return {
      dryRun: args.boolean("dry-run"),
      full: args.boolean("full"),
      json: args.boolean("json"),
      group: args.choice(),
      ...(base === undefined ? {} : { base }),
      ...(mr === undefined ? {} : { mr }),
      ...(contextFile === undefined ? {} : { contextFile }),
      ...(extraContext === undefined ? {} : { extraContext }),
    };
  }

  /** The flag's permission group; the local review's harnesses are checked against it when it joins the run. */
  protected override group(input: ReviewFlags): string {
    return input.group;
  }

  /**
   * Turns an error of the local review into the exit code, as the command reports it. An error before the review is
   * ready or after its result is no review error and is thrown. A git that did not finish in its time is reported
   * with exit code 1 wherever it happened, also while the repository is looked for.
   */
  protected override rescue(error: unknown, state: ReviewFlags & Partial<After<typeof ReviewPrintStep>>): number {
    if (error instanceof GitTimeoutError) return this.command.fail(ExitCode.FAILED, errorMessage(error));

    if (state.config === undefined || state.findings !== undefined) throw error;

    const failure = state.plan?.adapter.failure;

    if (failure !== undefined) return this.command.fail(ExitCode.FAILED, planStopMessage(failure));

    return this.command.fail(error instanceof ReviewInputError ? ExitCode.USAGE : ExitCode.FAILED, errorMessage(error));
  }

  /** 0, or 1 when the review wrote its comments and at least one of them could not be written. */
  protected finish(state: After<typeof ReviewPrintStep>): number {
    return (state.unwritten?.length ?? 0) > 0 ? ExitCode.FAILED : ExitCode.OK;
  }
}
