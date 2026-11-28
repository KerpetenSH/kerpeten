import type { Class } from "@asenajs/ioc";
import { cliSpec, ExitCode, HarnessApplication } from "@kerpetensh/harness-kit";
import { AiSdkAdapter } from "@kerpetensh/harness-kit/ai-sdk";
import { ChatGptAuthFile } from "../capability/chatgpt/ChatGptAuthFile.ts";
import { ChatGptOAuth } from "../capability/chatgpt/ChatGptOAuth.ts";
import { ChatGptPlan } from "../capability/chatgpt/ChatGptPlan.ts";
import { ChatGptSignIn } from "../capability/chatgpt/ChatGptSignIn.ts";
import { ChatGptTokens } from "../capability/chatgpt/ChatGptTokens.ts";
import { ConfigFileWriter } from "../capability/config/ConfigFileWriter.ts";
import { ConfigLoader } from "../capability/config/ConfigLoader.ts";
import { ContextPackFile } from "../capability/context-pack/ContextPackFile.ts";
import { ExtraContextFile } from "../capability/extra-context/ExtraContextFile.ts";
import { Git } from "../capability/git/Git.ts";
import { GitDiff } from "../capability/git/GitDiff.ts";
import { GitRoot } from "../capability/git/GitRoot.ts";
import { HeadCommit } from "../capability/git/HeadCommit.ts";
import { PermissionGroups } from "../capability/PermissionGroups.ts";
import { GitHubCommentWriter } from "../capability/platform/GitHubCommentWriter.ts";
import { GitHubPlatform } from "../capability/platform/GitHubPlatform.ts";
import { GitLabPlatform } from "../capability/platform/GitLabPlatform.ts";
import { OriginProject } from "../capability/platform/OriginProject.ts";
import { PlatformChoice } from "../capability/platform/PlatformChoice.ts";
import { RepoJail } from "../capability/repo/RepoJail.ts";
import { RipgrepSearch } from "../capability/repo/RipgrepSearch.ts";
import { SearchTimer } from "../capability/repo/SearchTimer.ts";
import { AnswerReader } from "../capability/stdin/AnswerReader.ts";
import { Cli } from "../cli/Cli.ts";
import type { CliOptions } from "../cli/types/cli.ts";
import { Harnesses } from "../harnesses/Harnesses.ts";
import { JudgePool } from "../harnesses/judge/JudgePool.ts";
import { Prompts } from "../harnesses/Prompts.ts";
import { CandidateFilter } from "../harnesses/review/CandidateFilter.ts";
import { RuleFiles } from "../harnesses/review/RuleFiles.ts";
import { CommentPlanner } from "../layer/comment/CommentPlanner.ts";
import { Scorer } from "../layer/scoring/Scorer.ts";
import { Logger } from "../log/Logger.ts";
import { GlobTool } from "../tools/glob/GlobTool.ts";
import { GrepTool } from "../tools/grep/GrepTool.ts";
import { ListDirTool } from "../tools/list-dir/ListDirTool.ts";
import { ReadFileTool } from "../tools/read-file/ReadFileTool.ts";
import { AuthCommand } from "../workflow/auth/AuthCommand.ts";
import { AuthStep } from "../workflow/auth/step/AuthStep.ts";
import { CapabilitiesCommand } from "../workflow/capabilities/CapabilitiesCommand.ts";
import { CapabilityListStep } from "../workflow/capabilities/step/CapabilityListStep.ts";
import { InitCommand } from "../workflow/init/InitCommand.ts";
import { InitQuestions } from "../workflow/init/InitQuestions.ts";
import { InitCheckStep } from "../workflow/init/step/InitCheckStep.ts";
import { InitQuestionStep } from "../workflow/init/step/InitQuestionStep.ts";
import { InitTargetStep } from "../workflow/init/step/InitTargetStep.ts";
import { InitWriteStep } from "../workflow/init/step/InitWriteStep.ts";
import { ReviewWorkflow } from "../workflow/review/ReviewWorkflow.ts";
import { CandidateStep } from "../workflow/review/step/CandidateStep.ts";
import { ChangeStep } from "../workflow/review/step/ChangeStep.ts";
import { CommentPlanStep } from "../workflow/review/step/CommentPlanStep.ts";
import { CommentWriteStep } from "../workflow/review/step/CommentWriteStep.ts";
import { JudgeStep } from "../workflow/review/step/JudgeStep.ts";
import { MergeRequestStep } from "../workflow/review/step/MergeRequestStep.ts";
import { ReviewerStep } from "../workflow/review/step/ReviewerStep.ts";
import { ScoreStep } from "../workflow/review/step/ScoreStep.ts";
import { WrittenCommentStep } from "../workflow/review/step/WrittenCommentStep.ts";
import { ModelKeys } from "../workflow/review-command/ModelKeys.ts";
import { ReviewCommand } from "../workflow/review-command/ReviewCommand.ts";
import { ReviewPrinter } from "../workflow/review-command/ReviewPrinter.ts";
import { ReviewSetup } from "../workflow/review-command/ReviewSetup.ts";
import { ReviewFlagStep } from "../workflow/review-command/step/ReviewFlagStep.ts";
import { ReviewOutcomeStep } from "../workflow/review-command/step/ReviewOutcomeStep.ts";
import { ReviewPrintStep } from "../workflow/review-command/step/ReviewPrintStep.ts";
import { ReviewSetupStep } from "../workflow/review-command/step/ReviewSetupStep.ts";
import { SelfCheckCommand } from "../workflow/self-check/SelfCheckCommand.ts";
import { SelfCheckStep } from "../workflow/self-check/step/SelfCheckStep.ts";
import { Names } from "./Names.ts";
import type { Instances, StartedApp } from "./types/app.ts";
import { WiringLogger } from "./WiringLogger.ts";

/**
 * The composition root: builds the container from the listed components and the values of `CliOptions`, starts it,
 * runs the CLI and stops it. A wiring mistake stops every call, help and version included, before any command runs.
 */
export class KerpetenApp {
  public static readonly COMPONENTS: readonly Class[] = [
    Cli,
    InitCommand,
    InitTargetStep,
    InitQuestionStep,
    InitWriteStep,
    InitCheckStep,
    ReviewCommand,
    ReviewFlagStep,
    ReviewSetupStep,
    ReviewOutcomeStep,
    ReviewPrintStep,
    AuthCommand,
    AuthStep,
    SelfCheckCommand,
    SelfCheckStep,
    CapabilitiesCommand,
    CapabilityListStep,
    ReviewWorkflow,
    MergeRequestStep,
    ChangeStep,
    WrittenCommentStep,
    ReviewerStep,
    CandidateStep,
    JudgeStep,
    ScoreStep,
    CommentPlanStep,
    CommentWriteStep,
    Scorer,
    CommentPlanner,
    Prompts,
    JudgePool,
    ReviewSetup,
    ModelKeys,
    ReviewPrinter,
    ConfigLoader,
    ConfigFileWriter,
    ChatGptAuthFile,
    ChatGptOAuth,
    ChatGptTokens,
    ChatGptSignIn,
    ChatGptPlan,
    ...Harnesses.ALL,
    ReadFileTool,
    ListDirTool,
    GrepTool,
    GlobTool,
    Logger,
    GitRoot,
    ContextPackFile,
    ExtraContextFile,
    AnswerReader,
    Git,
    GitDiff,
    HeadCommit,
    GitHubPlatform,
    GitHubCommentWriter,
    GitLabPlatform,
    OriginProject,
    PlatformChoice,
    RepoJail,
    RipgrepSearch,
    SearchTimer,
    CandidateFilter,
    RuleFiles,
    InitQuestions,
  ];

  public static async run(
    options: CliOptions,
    argv: readonly string[],
    components: readonly Class[] = KerpetenApp.COMPONENTS,
  ): Promise<number> {
    let started: StartedApp;

    try {
      started = await KerpetenApp.start(options, components);
    } catch (error) {
      KerpetenApp.report(options, error);

      return ExitCode.FAILED;
    }

    const { app, cli } = started;

    try {
      return await cli.run(argv);
    } finally {
      const failed = await app.stop();

      if (failed > 0) KerpetenApp.report(options, new Error(`${failed} stop hooks of the container failed`));
    }
  }

  /**
   * Builds the container from the given components, takes the CLI from it and starts it; a start hook that fails
   * throws its own error, without the container's `StartHookError` around it. After the start only the kit's run build
   * resolves from the container: run components, once per run, and the singletons they take with `@Use`.
   */
  public static async start(options: CliOptions, components: readonly Class[]): Promise<StartedApp> {
    const app = await HarnessApplication.create({
      components,
      io: options.io,
      permissionGroups: PermissionGroups.SET,
      instances: { ...KerpetenApp.instances(options) },
      logger: new WiringLogger(),
    });

    const cli = await app.resolve(Cli);

    await app.start();

    return { app, cli };
  }

  private static instances(options: CliOptions): Instances {
    return {
      [Names.ENV]: options.env,
      [Names.CWD]: options.cwd ?? process.cwd(),
      [Names.NOW]: options.now ?? Date.now,
      [Names.CHATGPT_ENDPOINTS]: options.chatgpt ?? ChatGptOAuth.PRODUCTION,
      [Names.MODEL_CLIENTS]:
        options.createClient ?? ((settings, adapter) => AiSdkAdapter.fromSettings(settings, adapter)),
      [Names.STDIN]: options.stdin ?? (() => Bun.stdin.stream()),
    };
  }

  private static report(options: CliOptions, error: unknown): void {
    const program = cliSpec(Cli).name;

    for (let link: unknown = error; link !== undefined; link = link instanceof Error ? link.cause : undefined) {
      const message = link instanceof Error ? link.message : String(link);

      for (const [index, line] of message.split("\n").entries())
        options.io.err(index === 0 ? `${program}: ${line}` : line);
    }
  }
}
