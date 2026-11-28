import { Inject } from "@asenajs/ioc";
import { Capability, ProcessCapability, type ProcessSettings, RunValue, Use } from "@kerpetensh/harness-kit";
import type { z } from "zod";
import { Names } from "../../app/Names.ts";
import type { Instances } from "../../app/types/app.ts";
import { terminalLine } from "../../text/text-utils.ts";
import { CommentRef } from "./CommentRef.ts";
import { JsonLines } from "./JsonLines.ts";
import { LimitedOutput } from "./LimitedOutput.ts";
import { OriginProject } from "./OriginProject.ts";
import { PlatformError } from "./PlatformError.ts";
import { PlatformLimits } from "./PlatformLimits.ts";
import type { RemoteProject } from "./RemoteProject.ts";
import { gitlabDiscussionSchema, gitlabMergeRequestSchema } from "./schemas/gitlab-schema.ts";
import type { GitLabDiscussion, GitLabMergeRequest, GitLabNote, GitLabPlace, GitLabPosition } from "./types/gitlab.ts";
import type {
  MergeRequest,
  MergeRequestState,
  Platform,
  PlatformComment,
  PlatformComments,
  PlatformExit,
  PlatformLines,
  PlatformList,
  PlatformRead,
  PlatformReadLimits,
  PlatformSide,
  PlatformStop,
} from "./types/platform.ts";

/**
 * GitLab behind the `Platform` interface: reads a merge request and its comments with `glab api` in the run's
 * repository, so the sign-in is the one of the GitLab CLI and Kerpeten holds no GitLab token.
 *
 * The project is the one the `origin` remote names, and glab chooses nothing: every call names the host with
 * `--hostname` and the full path of the project, as one encoded segment, in its path. glab's own choice among several
 * remotes, which takes the one it was told is the base, else a remote named `upstream`, then `gitlab`, then `origin`,
 * plays no part, so the merge request of another project with the same number is never read. The answer is checked
 * to be of that project all the same.
 *
 * `glab api` can do whatever the sign-in can. So every public method is typed and builds its own arguments, each call
 * is a GET, and no method takes arguments from its caller. The capability declares no permission, so no tool of a
 * model can take it. What it reads is outside data: nothing of it is run. The host and the path of the origin remote
 * are the one outside data that becomes part of an argument, and `RemoteProject` lets through only what a host name
 * and the path of a project can be.
 *
 * glab gets the program's environment with two settings of its own. `GLAB_COLOR=never` keeps color codes out of what
 * it prints, whatever its configuration says. `GLAB_CHECK_UPDATE=false` turns off its daily look for a new version,
 * which writes a notice to stderr and, when the look itself fails, can write a hint to stdout after the answer. Every
 * answer is asked for as lines of JSON, a form glab neither colors nor indents.
 *
 * Every read has a budget, `PlatformLimits`: the bytes glab may print and the time it may take. A read that reaches
 * either is stopped. For the merge request that is an error; for the discussions the result is incomplete and says
 * which limit stopped it.
 */
@Capability({
  name: "gitlab-platform",
  description:
    "Reads a merge request and its comments from GitLab with glab api, from the project the origin remote names, through typed methods that only read; no tool can take it.",
  scope: "run",
})
export class GitLabPlatform extends ProcessCapability implements Platform {
  public static readonly COMMAND = "glab";

  private static readonly FIXED_ARGS: readonly string[] = ["api"];

  private static readonly READ: readonly string[] = ["--method", "GET", "--output", "ndjson"];

  private static readonly ALL_PAGES: readonly string[] = ["--paginate"];

  private static readonly PAGE_SIZE = 100;

  private static readonly SETTINGS: Readonly<Record<string, string>> = {
    GLAB_COLOR: "never",
    GLAB_CHECK_UPDATE: "false",
  };

  private static readonly ERROR_TITLE = /^ERROR /;

  private static readonly STATES: Readonly<Record<"opened" | "closed" | "merged", MergeRequestState>> = {
    opened: "open",
    closed: "closed",
    merged: "merged",
  };

  private static readonly WEB_PATH = /^\/(.+?)(?:\/-)?\/merge_requests\/[0-9]+\/?$/;

  private static readonly MS_PER_SECOND = 1000;

  private static readonly PROJECT_NAMES = 2;

  @Use(OriginProject)
  private readonly origin!: OriginProject;

  @Inject(Names.ENV)
  private readonly env!: Instances[Names.ENV];

  @RunValue("repo")
  private readonly repo!: string;

  private static assertNumber(number: number): void {
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error(`not a merge request number: ${JSON.stringify(number)}`);
    }
  }

  /**
   * Why a read of glab failed. glab sends the request without a sign-in to a host it is not signed in to, and keeps
   * a token of the environment from a host it does not know; GitLab answers that with 401, or with 404 for a project
   * that is not public.
   */
  private static failure(result: PlatformExit, number: number, project: RemoteProject): PlatformError {
    const stderr = terminalLine(result.stderr).replace(GitLabPlatform.ERROR_TITLE, "");
    const signIn = `\`glab auth login --hostname ${project.host}\``;

    if (stderr.includes("HTTP 401")) {
      return new PlatformError(
        "signed_out",
        `GitLab at ${project.host} did not accept the sign-in of glab (HTTP 401): run ${signIn}, or correct the token in GITLAB_TOKEN when that variable is set, and run again`,
      );
    }

    if (stderr.includes("HTTP 404")) {
      return new PlatformError(
        "not_found",
        `merge request ${number} was not found in ${project.name}, the project of the origin remote: check the number; GitLab gives the same answer for a private project that glab cannot read, so check too that glab is signed in to ${project.host} (${signIn}) with an account that can read the project; a merge request of another project, such as the one a fork was made from, is not read`,
      );
    }

    return new PlatformError(
      "failed",
      `glab api failed (exit ${result.exitCode}): ${stderr === "" ? "it gave no error text" : stderr}`,
    );
  }

  private static unreadable(number: number, reason: string): PlatformError {
    return new PlatformError("failed", `the answer of glab for merge request ${number} cannot be read: ${reason}`);
  }

  /** The address of the merge request on the web, which names its host and the path of its project. */
  private static web(mergeRequest: GitLabMergeRequest): URL {
    let url: URL;

    try {
      url = new URL(mergeRequest.web_url);
    } catch {
      throw GitLabPlatform.unreadable(mergeRequest.iid, "web_url is no URL");
    }

    if (url.host === "") throw GitLabPlatform.unreadable(mergeRequest.iid, "web_url has no host");

    return url;
  }

  /** What a read that was stopped at a limit says, after the name of what was read. */
  private static stopped(read: PlatformStop): string {
    if (read.kind === "too_large") return `glab printed more than ${read.bytes} bytes, and the read stopped there`;

    return `glab did not finish within ${read.ms / GitLabPlatform.MS_PER_SECOND} seconds, and the read stopped there`;
  }

  private static state(mergeRequest: GitLabMergeRequest): MergeRequestState {
    if (mergeRequest.state === "locked") {
      throw new PlatformError(
        "failed",
        `merge request ${mergeRequest.iid} is locked: GitLab is merging it right now, so run again when the merge is done`,
      );
    }

    return GitLabPlatform.STATES[mergeRequest.state];
  }

  /** The side a position is on: the file before the change only for a line the change removed. */
  private static side(position: GitLabPosition): PlatformSide {
    const removed = position.position_type === "text" && (position.new_line ?? undefined) === undefined;

    return removed && (position.old_line ?? undefined) !== undefined ? "old" : "new";
  }

  /**
   * The lines of a position on its side: the range when it has one, else its one line, and none for a position on a
   * whole file. An end of the range that has no line on that side takes the position's own line, which is the last
   * line of the range; so a range whose first line is on the other side gives its last line alone.
   */
  private static lines(position: GitLabPosition, side: PlatformSide): PlatformLines | null {
    const own = (side === "old" ? position.old_line : position.new_line) ?? undefined;

    if (position.position_type !== "text" || own === undefined) return null;

    const range = position.line_range ?? undefined;

    if (range === undefined) return { start: own, end: own };

    const first = (side === "old" ? range.start.old_line : range.start.new_line) ?? own;
    const last = (side === "old" ? range.end.old_line : range.end.new_line) ?? own;

    return { start: Math.min(first, last), end: Math.max(first, last) };
  }

  /**
   * Where a note with a position sits, in the fields of a platform comment: the file by its path after the change,
   * the old path only when GitLab gives no new one; the head commit of the diff the note was written on; and the
   * lines with their side, the old side for a note on a line the change removed. A note on a whole file has no lines
   * and no side.
   */
  private static place(position: GitLabPosition): GitLabPlace {
    const side = GitLabPlatform.side(position);
    const lines = GitLabPlatform.lines(position, side);

    return {
      file: position.new_path ?? position.old_path ?? null,
      lines,
      side: lines === null ? null : side,
      commit: position.head_sha,
    };
  }

  private static comment(note: GitLabNote, replyTo: string | null): PlatformComment {
    const position = note.position ?? undefined;
    const none: GitLabPlace = { file: null, lines: null, side: null, commit: null };
    const place = position === undefined ? none : GitLabPlatform.place(position);

    return {
      id: String(note.id),
      ref: CommentRef.of("gitlab", "note", note.id).text,
      kind: position === undefined ? "general" : "line",
      author: note.author?.username ?? null,
      body: note.body,
      ...place,
      replyTo,
      createdAt: note.created_at,
    };
  }

  /** The comments of one discussion: its notes without GitLab's own event lines; every note after the first answers the first. */
  private static thread(discussion: GitLabDiscussion): PlatformComment[] {
    const notes = discussion.notes.filter((note) => !note.system);
    const first = notes[0];

    if (first === undefined) return [];

    return notes.map((note, index) => GitLabPlatform.comment(note, index === 0 ? null : String(first.id)));
  }

  /**
   * The merge request `number` of the project, where `number` is the one inside the project, its `iid`. A read that
   * fails throws a `PlatformError`, and so do an answer that is not the merge request asked for, a merge request
   * GitLab is merging right now and one that has no diff yet. The project is the one of the `origin` remote, and an
   * answer of another project is an error too.
   */
  public async mergeRequest(number: number): Promise<MergeRequest> {
    GitLabPlatform.assertNumber(number);

    const project = await this.project();
    const result = await this.get(project, [`projects/${project.segment}/merge_requests/${number}`]);

    if (result.kind !== "exited") {
      throw new PlatformError("failed", `merge request ${number} was not read: ${GitLabPlatform.stopped(result)}`);
    }

    if (result.exitCode !== 0) throw GitLabPlatform.failure(result, number, project);

    let answer: unknown;

    try {
      answer = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw GitLabPlatform.unreadable(number, "it is no JSON");
    }

    const parsed = gitlabMergeRequestSchema.safeParse(answer);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];

      throw GitLabPlatform.unreadable(number, `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "not as expected"}`);
    }

    const mergeRequest = parsed.data;

    if (mergeRequest.iid !== number) {
      throw GitLabPlatform.unreadable(number, `it is merge request ${mergeRequest.iid}`);
    }

    const web = GitLabPlatform.web(mergeRequest);
    const webPath = GitLabPlatform.WEB_PATH.exec(web.pathname)?.[1];

    if (webPath === undefined) throw GitLabPlatform.unreadable(number, "web_url names no project");

    if (!project.is(webPath)) {
      throw new PlatformError(
        "failed",
        `glab answered with a merge request of ${JSON.stringify(terminalLine(webPath))}, not of ${project.path}, the project of the origin remote; when the project was renamed or moved, point the origin remote at its new address and run again`,
      );
    }

    const state = GitLabPlatform.state(mergeRequest);

    if (mergeRequest.sha === null || mergeRequest.diff_refs === null) {
      throw new PlatformError(
        "failed",
        `merge request ${number} has no diff yet, GitLab names no commits for it: push a commit to its branch, or wait until GitLab has made the diff, and run again`,
      );
    }

    return {
      kind: "gitlab",
      host: web.host.toLowerCase(),
      projectId: String(mergeRequest.target_project_id),
      number: mergeRequest.iid,
      title: mergeRequest.title,
      description: mergeRequest.description ?? "",
      state,
      headSha: mergeRequest.sha,
      baseSha: mergeRequest.diff_refs.base_sha,
      baseRef: mergeRequest.target_branch,
    };
  }

  /**
   * The comments of merge request `number`, discussion by discussion in GitLab's order. The discussions are read to
   * their last page. The lines GitLab writes itself about events are no comments and are left out. A note in the diff
   * is a line comment, every other note a general one; in a discussion, every note after the first answers the first.
   * A list that glab did not read to its end, or whose entries cannot all be read, makes the result incomplete: it
   * holds what was read, and `problems` names the list. So does a list that is larger than the byte limit of a read
   * or takes longer than its time limit: the entries that stand whole before the stop are kept. A missing glab, a
   * sign-in GitLab does not accept, an unknown merge request and an `origin` remote that names no GitLab project
   * throw a `PlatformError`, because then nothing can be read.
   */
  public async comments(number: number): Promise<PlatformComments> {
    GitLabPlatform.assertNumber(number);

    const project = await this.project();

    const discussions = await this.list(
      project,
      `projects/${project.segment}/merge_requests/${number}/discussions`,
      number,
      gitlabDiscussionSchema,
    );

    return {
      comments: discussions.items.flatMap((discussion) => GitLabPlatform.thread(discussion)),
      complete: discussions.problems.length === 0,
      problems: discussions.problems,
    };
  }

  protected processSettings(): ProcessSettings {
    return {
      command: GitLabPlatform.COMMAND,
      fixedArgs: GitLabPlatform.FIXED_ARGS,
      cwd: this.repo,
      env: this.processEnv(),
    };
  }

  private processEnv(): Record<string, string> {
    const env: Record<string, string> = {};

    for (const [name, value] of Object.entries(this.env)) {
      if (value !== undefined) env[name] = value;
    }

    return { ...env, ...GitLabPlatform.SETTINGS };
  }

  /** The budget of one read of glab. */
  protected readLimits(): PlatformReadLimits {
    return { bytes: PlatformLimits.READ_BYTES, ms: PlatformLimits.READ_MS };
  }

  /** The project of the `origin` remote, which on GitLab is a namespace and a name at least. */
  private async project(): Promise<RemoteProject> {
    const project = await this.origin.project();

    if (project.names.length < GitLabPlatform.PROJECT_NAMES) {
      throw new PlatformError(
        "no_repository",
        `the origin remote names ${project.name}, which is no GitLab project: a project is a namespace and a name, <namespace>/<name>`,
      );
    }

    return project;
  }

  /**
   * Runs one GET of glab on the host of `project`, inside the budget of a read, and gives what it printed and how it
   * ended. A glab that cannot be started throws a `PlatformError`.
   */
  private async get(project: RemoteProject, args: readonly string[]): Promise<PlatformRead> {
    const { bytes, ms } = this.readLimits();
    const output = new LimitedOutput(bytes);
    const read = [...GitLabPlatform.READ, "--hostname", project.host, ...args];
    const outcome = await this.stream(read, (chunk) => output.take(chunk), ms);

    switch (outcome.kind) {
      case "not_started": {
        const reason = terminalLine(outcome.error);

        if (outcome.code !== "ENOENT") throw new PlatformError("failed", `glab cannot be run: ${reason}`);

        throw new PlatformError(
          "cli_missing",
          `glab, the GitLab CLI, is not found (${reason}): install it from https://gitlab.com/gitlab-org/cli and run again`,
        );
      }
      case "timed_out":
        return { kind: "timed_out", stdout: output.bytes, ms };
      case "stopped":
        return { kind: "too_large", stdout: output.bytes, bytes };
      case "exited":
        return { kind: "exited", exitCode: outcome.exitCode, stdout: output.bytes, stderr: outcome.stderr };
    }
  }

  private async list<T>(
    project: RemoteProject,
    path: string,
    number: number,
    schema: z.ZodType<T>,
  ): Promise<PlatformList<T>> {
    const result = await this.get(project, [
      ...GitLabPlatform.ALL_PAGES,
      `${path}?per_page=${GitLabPlatform.PAGE_SIZE}`,
    ]);

    const failure =
      result.kind !== "exited" || result.exitCode === 0 ? undefined : GitLabPlatform.failure(result, number, project);

    if (failure !== undefined && failure.kind !== "failed") throw failure;

    const lines = JsonLines.read(result.stdout.toString("utf8"));
    const items: T[] = [];
    const problems: string[] = [];

    for (const entry of lines.items) {
      const parsed = schema.safeParse(entry);

      if (parsed.success) items.push(parsed.data);
    }

    const unread = lines.items.length - items.length;

    if (result.kind !== "exited") problems.push(`${path}: ${GitLabPlatform.stopped(result)}`);
    else if (failure !== undefined) problems.push(`${path}: ${failure.message}`);
    else if (!lines.whole) problems.push(`${path}: the answer of glab is not the lines of entries it should be`);

    if (unread > 0) problems.push(`${path}: ${unread} of ${lines.items.length} entries cannot be read`);

    return { items, problems };
  }
}
