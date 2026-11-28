import { Capability, type ProcessSettings, RunValue } from "@kerpetensh/harness-kit";
import { GitHubCommentWriter } from "../../../src/capability/platform/GitHubCommentWriter.ts";
import type { PlatformReadLimits } from "../../../src/capability/platform/types/platform.ts";

/**
 * The GitHub comment writer whose command and call budget the run's values give, so a test can put a script in the
 * place of gh and reach the time limit with a short wait.
 */
@Capability({
  name: "github-comment-writer",
  description: "The GitHub comment writer with the command of the test run.",
  scope: "run",
})
export class TestGitHubCommentWriter extends GitHubCommentWriter {
  @RunValue("ghCommand")
  private readonly ghCommand!: string;

  @RunValue("ghLimits")
  private readonly ghLimits!: PlatformReadLimits;

  protected override readLimits(): PlatformReadLimits {
    return this.ghLimits;
  }

  protected override processSettings(): ProcessSettings {
    return { ...super.processSettings(), command: this.ghCommand };
  }
}
