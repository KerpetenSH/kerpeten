import { Inject } from "@asenajs/ioc";
import { ProcessCapability, type ProcessOutcome, type ProcessSettings, RunValue, Use } from "@kerpetensh/harness-kit";
import type { z } from "zod";
import { Names } from "../../app/Names.ts";
import type { Instances } from "../../app/types/app.ts";
import { terminalLine } from "../../text/text-utils.ts";
import { LimitedOutput } from "./LimitedOutput.ts";
import { OriginProject } from "./OriginProject.ts";
import { PlatformError } from "./PlatformError.ts";
import { PlatformLimits } from "./PlatformLimits.ts";
import type { RemoteProject } from "./RemoteProject.ts";
import { SlurpedPages } from "./SlurpedPages.ts";
import type { PlatformExit, PlatformList, PlatformRead, PlatformReadLimits, PlatformStop } from "./types/platform.ts";

/**
 * What the two GitHub capabilities share, the one that reads a pull request and the one that writes its comments: how
 * `gh api` is started, which repository it is asked about, the budget of a call, one GET and one list read to its last
 * page, and what a call that failed means. Nothing here writes: the only request it makes is a GET.
 *
 * The repository is the one the `origin` remote names, and gh chooses nothing: every call names the host with
 * `--hostname` and the owner and the repository in its path. gh's own choice among several remotes, which prefers a
 * remote named `upstream`, plays no part. The host and the path of the origin remote are the one outside data that
 * becomes part of an argument, and `RemoteProject` lets through only what a host name and the path of a repository
 * can be.
 *
 * gh gets the program's environment without the variables that force colors, which would put color codes into the
 * JSON it prints. So the sign-in is the one of the GitHub CLI and Kerpeten holds no GitHub token.
 *
 * Every call has a budget, `PlatformLimits`: the bytes gh may print and the time it may take. A call that reaches
 * either is stopped.
 */
export abstract class GitHubCli extends ProcessCapability {
  public static readonly COMMAND = "gh";

  private static readonly FIXED_ARGS: readonly string[] = ["api"];

  private static readonly READ: readonly string[] = ["--method", "GET"];

  private static readonly ALL_PAGES: readonly string[] = ["--paginate", "--slurp"];

  private static readonly PAGE_SIZE = 100;

  private static readonly NOT_SIGNED_IN_EXIT = 4;

  private static readonly COLOR_FORCING: readonly string[] = ["CLICOLOR_FORCE", "GH_FORCE_TTY"];

  private static readonly MS_PER_SECOND = 1000;

  private static readonly REPOSITORY_NAMES = 2;

  @Use(OriginProject)
  private readonly origin!: OriginProject;

  @Inject(Names.ENV)
  private readonly env!: Instances[Names.ENV];

  @RunValue("repo")
  private readonly repo!: string;

  /**
   * Why a call of gh failed. gh ends with 4 when it is signed in to no host; a host it is not signed in to, beside
   * others it is, gets the request without a sign-in, which GitHub answers with 401 or, for a repository that is not
   * public, with 404.
   */
  public static failure(result: PlatformExit, number: number, project: RemoteProject): PlatformError {
    const stderr = terminalLine(result.stderr);

    if (result.exitCode === GitHubCli.NOT_SIGNED_IN_EXIT || stderr.includes("HTTP 401")) {
      return new PlatformError(
        "signed_out",
        `gh is not signed in to ${project.host}: run \`gh auth login --hostname ${project.host}\` and run again`,
      );
    }

    if (stderr.includes("HTTP 404")) {
      return new PlatformError(
        "not_found",
        `pull request ${number} was not found in ${project.name}, the repository of the origin remote: check the number, and that gh is signed in to ${project.host} with an account that can read the repository; a pull request of another repository, such as the one a fork was made from, is not read`,
      );
    }

    return new PlatformError(
      "failed",
      `gh api failed (exit ${result.exitCode}): ${stderr === "" ? "it gave no error text" : stderr}`,
    );
  }

  /** What a call that was stopped at a limit says, after the name of what was asked for. */
  public static stopped(read: PlatformStop): string {
    if (read.kind === "too_large") return `gh printed more than ${read.bytes} bytes, and the read stopped there`;

    return `gh did not finish within ${read.ms / GitHubCli.MS_PER_SECOND} seconds, and the read stopped there`;
  }

  protected static assertNumber(number: number): void {
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error(`not a pull request number: ${JSON.stringify(number)}`);
    }
  }

  protected processSettings(): ProcessSettings {
    return {
      command: GitHubCli.COMMAND,
      fixedArgs: GitHubCli.FIXED_ARGS,
      cwd: this.repo,
      env: this.processEnv(),
    };
  }

  /** The repository of the `origin` remote, which on GitHub is an owner and a name. */
  protected async repository(): Promise<RemoteProject> {
    const project = await this.origin.project();

    if (project.names.length !== GitHubCli.REPOSITORY_NAMES) {
      throw new PlatformError(
        "no_repository",
        `the origin remote names ${project.name}, which is no GitHub repository: a repository is an owner and a name, <owner>/<name>`,
      );
    }

    return project;
  }

  /** The budget of one call of gh. */
  protected readLimits(): PlatformReadLimits {
    return { bytes: PlatformLimits.READ_BYTES, ms: PlatformLimits.READ_MS };
  }

  /**
   * Runs one GET of gh on the host of `project`, inside the budget of a call, and gives what it printed and how it
   * ended. A gh that cannot be started throws a `PlatformError`.
   */
  protected async get(project: RemoteProject, args: readonly string[]): Promise<PlatformRead> {
    const limits = this.readLimits();
    const output = new LimitedOutput(limits.bytes);
    const read = [...GitHubCli.READ, "--hostname", project.host, ...args];

    return this.ended(await this.stream(read, (chunk) => output.take(chunk), limits.ms), output, limits);
  }

  /**
   * The entries of the list at `path` of pull request `number`, read to its last page. A list that gh did not read to
   * its end, or whose entries cannot all be read, gives what was read and says in `problems` what was not. A missing
   * sign-in and a pull request that is not found throw a `PlatformError`.
   */
  protected async list<T>(
    project: RemoteProject,
    path: string,
    number: number,
    schema: z.ZodType<T>,
  ): Promise<PlatformList<T>> {
    const result = await this.get(project, [...GitHubCli.ALL_PAGES, `${path}?per_page=${GitHubCli.PAGE_SIZE}`]);

    const failure =
      result.kind !== "exited" || result.exitCode === 0 ? undefined : GitHubCli.failure(result, number, project);

    if (failure !== undefined && failure.kind !== "failed") throw failure;

    const pages = SlurpedPages.read(result.stdout.toString("utf8"));
    const items: T[] = [];
    const problems: string[] = [];

    for (const entry of pages.items) {
      const parsed = schema.safeParse(entry);

      if (parsed.success) items.push(parsed.data);
    }

    const unread = pages.items.length - items.length;

    if (result.kind !== "exited") problems.push(`${path}: ${GitHubCli.stopped(result)}`);
    else if (failure !== undefined) problems.push(`${path}: ${failure.message}`);
    else if (!pages.whole) problems.push(`${path}: the answer of gh is not the list of pages it should be`);

    if (unread > 0) problems.push(`${path}: ${unread} of ${pages.items.length} entries cannot be read`);

    return { items, problems };
  }

  /**
   * How a call of gh ended, with what it printed into `output`, in the words of a platform read. A gh that could not
   * be started throws a `PlatformError`.
   */
  protected ended(outcome: ProcessOutcome, output: LimitedOutput, limits: PlatformReadLimits): PlatformRead {
    switch (outcome.kind) {
      case "not_started": {
        const reason = terminalLine(outcome.error);

        if (outcome.code !== "ENOENT") throw new PlatformError("failed", `gh cannot be run: ${reason}`);

        throw new PlatformError(
          "cli_missing",
          `gh, the GitHub CLI, is not found (${reason}): install it from https://cli.github.com and run again`,
        );
      }
      case "timed_out":
        return { kind: "timed_out", stdout: output.bytes, ms: limits.ms };
      case "stopped":
        return { kind: "too_large", stdout: output.bytes, bytes: limits.bytes };
      case "exited":
        return { kind: "exited", exitCode: outcome.exitCode, stdout: output.bytes, stderr: outcome.stderr };
    }
  }

  private processEnv(): Record<string, string> {
    const env: Record<string, string> = {};

    for (const [name, value] of Object.entries(this.env)) {
      if (value !== undefined && !GitHubCli.COLOR_FORCING.includes(name)) env[name] = value;
    }

    return env;
  }
}
