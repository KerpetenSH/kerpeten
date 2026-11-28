import { RunService, RunValue, Use } from "@kerpetensh/harness-kit";
import { ConfigLoader } from "../config/ConfigLoader.ts";
import type { KerpetenConfig } from "../config/types/config.ts";
import { GitHubCommentWriter } from "./GitHubCommentWriter.ts";
import { GitHubPlatform } from "./GitHubPlatform.ts";
import { GitLabPlatform } from "./GitLabPlatform.ts";
import { OriginProject } from "./OriginProject.ts";
import { PlatformChoiceError } from "./PlatformChoiceError.ts";
import type { Platform, PlatformKind, PlatformWriter } from "./types/platform.ts";

/**
 * The platform of the run's repository, chosen once per run and before any platform tool runs. The `platform` key of
 * the configuration names the kind of platform. Without the key, the host of the `origin` remote decides:
 * `github.com` is GitHub and `gitlab.com` is GitLab. Any other host is a `PlatformChoiceError` that says to set the
 * key: the host name is not guessed from, and no tool is tried to see whether it answers.
 *
 * The key names only the kind. The host and the project of a review always come from the `origin` remote, through
 * `OriginProject`, which is also what refuses a repository without an `origin` remote.
 *
 * Reading and writing are two capabilities per platform, and the choice gives each on its own: `platform` the one
 * that reads, `writer` the one that writes comments. Kerpeten writes to GitHub only; GitLab has no writer yet.
 */
@RunService("kerpeten:platform-choice")
export class PlatformChoice {
  private static readonly HOSTS: ReadonlyMap<string, PlatformKind> = new Map<string, PlatformKind>([
    ["github.com", "github"],
    ["gitlab.com", "gitlab"],
  ]);

  private static readonly HINT = `set \`platform: github\` or \`platform: gitlab\` in ${ConfigLoader.CONFIG_FILE}`;

  @Use(OriginProject)
  private readonly origin!: OriginProject;

  @Use(GitHubPlatform)
  private readonly github!: GitHubPlatform;

  @Use(GitLabPlatform)
  private readonly gitlab!: GitLabPlatform;

  @Use(GitHubCommentWriter)
  private readonly githubWriter!: GitHubCommentWriter;

  @RunValue("config")
  private readonly config!: KerpetenConfig;

  private chosen: Promise<PlatformKind> | undefined;

  /** The kind of the run's platform. Every call of a run gives the same answer, or the same error. */
  public kind(): Promise<PlatformKind> {
    this.chosen ??= this.choose();

    return this.chosen;
  }

  /** The platform of the run: the one capability the review reads merge requests through. */
  public async platform(): Promise<Platform> {
    const platforms: Readonly<Record<PlatformKind, Platform>> = { github: this.github, gitlab: this.gitlab };

    return platforms[await this.kind()];
  }

  /**
   * The capability that writes the comments of a review to the run's platform, or `undefined` when Kerpeten cannot
   * write to that platform yet, which is so for GitLab.
   */
  public async writer(): Promise<PlatformWriter | undefined> {
    const writers: Readonly<Record<PlatformKind, PlatformWriter | undefined>> = {
      github: this.githubWriter,
      gitlab: undefined,
    };

    return writers[await this.kind()];
  }

  private async choose(): Promise<PlatformKind> {
    const configured = this.config.platform;

    if (configured !== undefined) return configured;

    const { host } = await this.origin.project();
    const kind = PlatformChoice.HOSTS.get(host);

    if (kind === undefined) {
      throw new PlatformChoiceError(
        `the origin remote is on ${host}, which is neither github.com nor gitlab.com: ${PlatformChoice.HINT}`,
      );
    }

    return kind;
  }
}
