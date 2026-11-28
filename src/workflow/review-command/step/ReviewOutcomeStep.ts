import { type After, ExitCode, FlowStep, FlowStepBase } from "@kerpetensh/harness-kit";
import { terminalLine } from "../../../text/text-utils.ts";
import type { ReviewResult } from "../../review/types/review-workflow.ts";
import { planStopMessage } from "../review-command-utils.ts";
import type { ReviewSetupStep } from "./ReviewSetupStep.ts";

/**
 * Looks at the result of the local review, which ran before it: logs its usage, ends with 1 when the ChatGPT plan
 * stopped the review or the reviewer gave no result, and reports on stderr a partial review and each comment that
 * could not be written to the merge request, one line each, after which the command goes on to print the findings.
 */
@FlowStep({
  name: "review-outcome",
  description:
    "Logs the usage of the local review and reports a stopped, failed or partial review and each comment that could not be written.",
})
export class ReviewOutcomeStep extends FlowStepBase {
  public execute(state: After<typeof ReviewSetupStep> & ReviewResult) {
    const { plan, log } = state;

    for (const entry of state.usage) log.info("usage", { ...entry });

    if (plan?.adapter.failure !== undefined) {
      return this.end(this.command.fail(ExitCode.FAILED, planStopMessage(plan.adapter.failure)));
    }

    if (state.failure !== undefined) {
      return this.end(
        this.command.fail(
          ExitCode.FAILED,
          `the reviewer gave no result (${state.reviewerPartialReason ?? "model_error"}): ${terminalLine(state.failure)}`,
        ),
      );
    }

    if (state.reviewerPartialReason !== undefined)
      this.command.report(`partial review (${state.reviewerPartialReason})`);

    if (state.judgePartialReason !== undefined)
      this.command.report(`partial judge stage (${state.judgePartialReason})`);

    for (const failure of state.unwritten ?? []) this.command.report(failure);

    return {};
  }
}
