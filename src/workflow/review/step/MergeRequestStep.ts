import { Inject } from "@asenajs/ioc";
import { FlowStep, FlowStepBase, Use } from "@kerpetensh/harness-kit";
import { Names } from "../../../app/Names.ts";
import type { Instances } from "../../../app/types/app.ts";
import { PlatformChoice } from "../../../capability/platform/PlatformChoice.ts";
import { PlatformWords } from "../../../capability/platform/PlatformWords.ts";
import { ReviewInputError } from "../../../harnesses/review/ReviewInputError.ts";
import { mergeRequestReadError } from "../review-utils.ts";
import type { ReviewedMergeRequest, ReviewInput } from "../types/review-workflow.ts";

/**
 * Reads the merge request a review is of from its platform, as the first flow step: before git is read for the change
 * and before any model is called, so a merge request that cannot be read costs nothing. The platform is the one the
 * run's platform choice gives, GitHub or GitLab; it is chosen before the platform's tool runs, and a repository whose
 * platform cannot be told stops the review. The merge request is the one of the project the `origin` remote names; a
 * repository without such a remote stops the review too. A review of no merge request adds none and chooses no
 * platform. The tenant is the one `KERPETEN_TENANT` names, `default` when it names none.
 *
 * A review that is no dry run writes its comments to the merge request at its end. Kerpeten writes to GitHub only, so
 * such a review of a merge request on another platform is refused here, as soon as the platform is known: before the
 * merge request is read and before any model is called. The message says to run with `--dry-run`.
 *
 * A read that fails ends the review as a wrong input when the user can put it right, and as a platform error when the
 * platform failed; `mergeRequestReadError` says which is which.
 */
@FlowStep({
  name: "merge-request",
  description:
    "Reads the merge request of the review from the platform of the repository, GitHub or GitLab, with its title, description and commits, before the change is read and before any model call; a review that would write to a platform Kerpeten cannot write to is refused first; a review without a merge request adds none.",
})
export class MergeRequestStep extends FlowStepBase {
  public static readonly TENANT_VARIABLE = "KERPETEN_TENANT";

  public static readonly DEFAULT_TENANT = "default";

  @Inject(Names.ENV)
  private readonly env!: Instances[Names.ENV];

  @Use(PlatformChoice)
  private readonly platforms!: PlatformChoice;

  public async execute(state: ReviewInput) {
    if (state.mr !== undefined && state.base !== undefined) {
      throw new ReviewInputError(
        "--mr and --base do not go together: the pull request or merge request names its own base",
      );
    }

    const mergeRequest = state.mr === undefined ? undefined : await this.read(state.mr, state.dryRun);

    if (mergeRequest !== undefined) {
      state.log.info("merge request read", {
        tenant: mergeRequest.tenant,
        platform: mergeRequest.kind,
        host: mergeRequest.host,
        project: mergeRequest.projectId,
        mr: mergeRequest.number,
        state: mergeRequest.state,
        head: mergeRequest.headSha,
        base: mergeRequest.baseSha,
      });
    }

    return { mergeRequest };
  }

  private async read(number: number, dryRun: boolean): Promise<ReviewedMergeRequest> {
    try {
      if (!dryRun && (await this.platforms.writer()) === undefined) {
        const { noun } = PlatformWords.of(await this.platforms.kind());

        throw new ReviewInputError(
          `--mr ${number}: Kerpeten cannot write comments to a ${noun} of this platform yet, only to a pull request on GitHub: run with --dry-run to see the comments the review would write`,
        );
      }

      const platform = await this.platforms.platform();

      return { ...(await platform.mergeRequest(number)), tenant: this.tenant() };
    } catch (error) {
      throw mergeRequestReadError(number, error);
    }
  }

  private tenant(): string {
    const named = this.env[MergeRequestStep.TENANT_VARIABLE]?.trim();

    return named === undefined || named === "" ? MergeRequestStep.DEFAULT_TENANT : named;
  }
}
