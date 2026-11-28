import { Inject } from "@asenajs/ioc";
import { ExitCode, FlowStep, FlowStepBase } from "@kerpetensh/harness-kit";
import { Logger } from "../../../log/Logger.ts";
import type { ReviewFlags } from "../types/review-command.ts";

/**
 * Opens the command's log and refuses what this build cannot do, each with 2 and a message that says what to do: a
 * review that is no dry run and names no merge request, because it has nowhere to write its comments, and `--full`.
 */
@FlowStep({
  name: "review-flags",
  description:
    "Opens the log of the review command and refuses a review that would write but names no merge request, and one with --full.",
})
export class ReviewFlagStep extends FlowStepBase {
  @Inject(Logger)
  private readonly logger!: Logger;

  public execute(state: ReviewFlags) {
    const log = this.logger.child({ command: this.command.name });

    if (!state.dryRun && state.mr === undefined) {
      return this.end(
        this.command.fail(
          ExitCode.USAGE,
          "a review without --dry-run writes its comments to a pull request, and this one names none, so it has nowhere to write: give --mr <n> to review pull request n and write to it, or --dry-run to only print the findings",
        ),
      );
    }

    if (state.full) {
      return this.end(
        this.command.fail(
          ExitCode.USAGE,
          "--full is not supported in this build; incremental review does not exist yet, so every review already covers the whole change",
        ),
      );
    }

    return { log };
  }
}
