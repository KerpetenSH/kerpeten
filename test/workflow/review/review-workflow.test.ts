import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flowStepSpec, PermissionGroupSet, Run, workflowSpec } from "@kerpetensh/harness-kit";
import type { z } from "zod";
import { ConfigLoader } from "../../../src/capability/config/ConfigLoader.ts";
import type { KerpetenConfig } from "../../../src/capability/config/types/config.ts";
import { ContextPackFile } from "../../../src/capability/context-pack/ContextPackFile.ts";
import { PermissionGroups } from "../../../src/capability/PermissionGroups.ts";
import { RepoJail } from "../../../src/capability/repo/RepoJail.ts";
import type { JudgeOutput } from "../../../src/harnesses/judge/types/judge.ts";
import { ReviewInputError } from "../../../src/harnesses/review/ReviewInputError.ts";
import type { ReviewerFinding } from "../../../src/harnesses/review/types/review.ts";
import type { ProviderLlm } from "../../../src/harnesses/types/harnesses.ts";
import { ReviewWorkflow } from "../../../src/workflow/review/ReviewWorkflow.ts";
import { commit, sh, tempRepo, write } from "../../capability/git/git-utils.ts";
import { log } from "../../harnesses/harnesses-utils.ts";
import { FakeJudgeLlm } from "../../harnesses/judge/FakeJudgeLlm.ts";
import type { FakeJudgeAnswer } from "../../harnesses/types/harnesses.ts";
import { mockClient, promptText } from "../../test-utils.ts";
import { reviewComponent } from "./review-utils.ts";

const workflow = await reviewComponent(ReviewWorkflow);

const packs = await reviewComponent(ContextPackFile);

function config(extra = ""): KerpetenConfig {
  const parsed = new ConfigLoader().parse(
    `models:\n  reviewer: { provider: anthropic, model: m }\n  judge: { provider: anthropic, model: m }\n${extra}`,
  );

  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));

  return parsed.config;
}

const dirs: string[] = [];

const labels: JudgeOutput = {
  verdict: "verified",
  priority: "P1",
  nature: "edge_case",
  fix_effort: "easy",
  rationale: "y is never checked",
  evidence: [{ location: "src/a.ts:2" }],
};

const judged = {
  verdict: "verified",
  priority: "P1",
  nature: "edge_case",
  fix_effort: "easy",
  rationale: "y is never checked",
  score: 50,
  action: "summary",
} as const;

function judgeLlm(answer: (context: string) => Partial<FakeJudgeAnswer> = () => ({})): FakeJudgeLlm {
  return new FakeJudgeLlm((context) => ({ name: FakeJudgeLlm.titleOf(context), labels, ...answer(context) }));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });

  mock.restore();
});

const pack = {
  identity: { tenant: "default", platform: { kind: "gitlab", host: "gitlab.com" }, project: { id: "1", path: "a/b" } },
  truncated: false,
  known: [
    {
      fingerprint: "b".repeat(64),
      title: "Cart total races with checkout",
      file: "src/cart.ts",
      reason: "Single-writer queue makes this safe.",
    },
    { title: "Retry loop has no cap", file: "src/net.ts" },
  ],
};

function packFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "kerpeten-pack-"));

  dirs.push(dir);

  const path = join(dir, "context-pack.json");

  writeFileSync(path, JSON.stringify(pack));

  return path;
}

function repoWithBranch(): { repo: string; base: string } {
  const repo = tempRepo("kerpeten-review-");

  dirs.push(repo);
  write(repo, { "src/a.ts": "export const a = 1;\n", "README.md": "x\n" });

  const base = commit(repo, "base");

  sh(repo, ["checkout", "-q", "-b", "feature"]);

  const body = Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join("\n");

  write(repo, {
    "src/a.ts": `export const a = 1;\nexport const div = (x: number, y: number) => x / y;\n\n\n${body}\n`,
    "yarn.lock": "lock\n",
  });

  commit(repo, "add div\n\nIt divides.");

  return { repo, base };
}

const good: ReviewerFinding = {
  file: "./src/a.ts",
  start_line: 2,
  end_line: 2,
  category: "bug",
  title: "Division by zero",
  body: "y can be 0",
  fix: "Throw when y is 0.",
  evidence: [{ location: "src/a.ts:2" }],
};

describe("local review", () => {
  test("reviews the branch against the merge-base and filters the candidates", async () => {
    const { repo, base } = repoWithBranch();

    const findings = [
      good,
      { ...good, file: "src/missing.ts" },
      { ...good, start_line: 500, end_line: 501 },
      { ...good, start_line: 3, end_line: 4 },
      { ...good, file: "../outside.ts" },
      { ...good, start_line: 5, end_line: 84 },
    ];

    const mock = mockClient([{ text: "done" }, { text: JSON.stringify({ findings }) }]);

    const result = await workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mock.client,
      judgeClient: judgeLlm(),
      log,
      repo,
      base: "main",
      pathEnv: process.env.PATH ?? "",
    });

    expect(result.baseSha).toBe(base);
    expect(result.changedFiles).toEqual(["src/a.ts"]);

    expect(result.findings).toEqual([
      { ...good, file: "src/a.ts", ...judged },
      { ...good, file: "src/a.ts", start_line: 5, end_line: 54, ...judged },
    ]);

    expect(result.dropped).toEqual({ no_file: 1, line_outside: 1, blank_range: 1, bad_path: 1 });
    expect(result.clipped).toBe(1);
    expect(result.partial).toBe(false);

    expect(result.usage).toEqual([
      { role: "reviewer", provider: "anthropic", model: "mock-model", input_tokens: 200, output_tokens: 20, calls: 2 },
      { role: "judge", provider: "openai", model: "judge-model", input_tokens: 300, output_tokens: 40, calls: 4 },
    ]);

    const first = promptText(mock.calls[0]);

    expect(first).toContain("BEGIN DATA title");
    expect(first).toContain("feature");
    expect(first).toContain("It divides.");
    expect(first).toContain("x / y");
    expect(first).not.toContain("yarn.lock");
  });

  test("a finding in a file that exists but is not UTF-8 is dropped as unreadable, not as missing", async () => {
    const { repo } = repoWithBranch();

    write(repo, { "src/latin1.ts": new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]) });
    commit(repo, "latin1");

    const findings = [
      { ...good, file: "src/latin1.ts", start_line: 1, end_line: 1 },
      { ...good, file: "src/nope.ts" },
    ];

    const mock = mockClient([{ text: "done" }, { text: JSON.stringify({ findings }) }]);

    const result = await workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mock.client,
      judgeClient: judgeLlm(),
      log,
      repo,
      base: "main",
      pathEnv: process.env.PATH ?? "",
    });

    expect(result.findings).toEqual([]);
    expect(result.dropped).toEqual({ unreadable_file: 1, no_file: 1 });
  });

  test("an uncommitted change in a tracked file stops the review before a model is called", async () => {
    const { repo } = repoWithBranch();
    const mock = mockClient([]);

    const review = () =>
      workflow.run({
        dryRun: true,
        config: config(),
        reviewerClient: mock.client,
        judgeClient: judgeLlm(),
        log,
        repo,
        base: "main",
        pathEnv: "",
      });

    writeFileSync(join(repo, "src/a.ts"), "changed\n");

    await expect(review()).rejects.toBeInstanceOf(ReviewInputError);

    await expect(review()).rejects.toThrow(
      "1 tracked file has uncommitted changes: src/a.ts; the tools read the files on disk but the review is of HEAD, so commit or stash the changes and run again",
    );

    expect(mock.calls.length).toBe(0);
  });

  test("the error lists at most ten changed files and counts the rest", async () => {
    const { repo } = repoWithBranch();
    const names = Array.from({ length: 12 }, (_, n) => `src/f${String(n).padStart(2, "0")}.ts`);

    write(repo, Object.fromEntries(names.map((name) => [name, "one\n"])));
    commit(repo, "twelve files");
    write(repo, Object.fromEntries(names.map((name) => [name, "two\n"])));

    const run = workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mockClient([]).client,
      judgeClient: judgeLlm(),
      log,
      repo,
      base: "main",
      pathEnv: "",
    });

    await expect(run).rejects.toThrow(
      `12 tracked files have uncommitted changes: ${names.slice(0, 10).join(", ")} and 2 more; the tools read`,
    );
  });

  test("an untracked file does not stop the review", async () => {
    const { repo } = repoWithBranch();

    writeFileSync(join(repo, "new.ts"), "untracked\n");

    const result = await workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mockClient([{ text: "done" }, { text: '{"findings":[]}' }]).client,
      judgeClient: judgeLlm(),
      log,
      repo,
      base: "main",
      pathEnv: "",
    });

    expect(result.partial).toBe(false);
    expect(result.findings).toEqual([]);
  });

  test("the tools see only the files tracked at HEAD, never ignored local files", async () => {
    const { repo } = repoWithBranch();
    const secret = "IGNORED-LOCAL-SECRET-0b7e";

    writeFileSync(join(repo, ".gitignore"), ".env\naaa-deps/\n");
    writeFileSync(join(repo, ".env"), `API_KEY=${secret}\n`);
    mkdirSync(join(repo, "aaa-deps"));
    writeFileSync(join(repo, "aaa-deps", "x.ts"), "export const div = 0;\n");

    const mock = mockClient([
      {
        toolCalls: [
          { name: "read_file", input: { path: ".env" } },
          { name: "grep", input: { pattern: "API_KEY", fixed_strings: true } },
          { name: "glob", input: { pattern: "**/*.ts" } },
        ],
      },
      { text: "done" },
      { text: '{"findings":[]}' },
    ]);

    await workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mock.client,
      judgeClient: judgeLlm(),
      log,
      repo,
      base: "main",
      pathEnv: process.env.PATH ?? "",
    });

    const answers = promptText(mock.calls[1]);

    expect(answers).not.toContain(secret);
    expect(answers).toContain("path does not exist");
    expect(answers).toContain("src/a.ts");
    expect(answers).not.toContain("aaa-deps");
  });

  test("an empty diff makes no model call", async () => {
    const repo = tempRepo("kerpeten-review-");

    dirs.push(repo);
    write(repo, { "a.ts": "1\n" });
    commit(repo, "base");

    const mock = mockClient([]);

    const result = await workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mock.client,
      judgeClient: judgeLlm(),
      log,
      repo,
      base: "main",
      pathEnv: "",
    });

    expect(result).toMatchObject({ findings: [], partial: false, usage: [] });
    expect(mock.calls.length).toBe(0);
  });

  test("a full tool budget yields a partial review", async () => {
    const { repo } = repoWithBranch();

    const mock = mockClient([
      {
        toolCalls: [
          { name: "read_file", input: { path: "src/a.ts" } },
          { name: "list_dir", input: { path: "." } },
        ],
      },
      { text: JSON.stringify({ findings: [good] }) },
    ]);

    const result = await workflow.run({
      dryRun: true,
      config: config("limits: { max_tool_calls: 1 }\n"),
      reviewerClient: mock.client,
      judgeClient: judgeLlm(),
      log,
      repo,
      base: "main",
      pathEnv: process.env.PATH ?? "",
    });

    expect(result).toMatchObject({
      partial: true,
      partialReason: "tool_call_budget",
      reviewerPartialReason: "tool_call_budget",
      toolCalls: 1,
    });

    expect(result.findings.length).toBe(1);
    expect(promptText(mock.calls[1])).toContain("export const div");
  });

  test("without --base and without origin/HEAD the review refuses to guess", async () => {
    const { repo } = repoWithBranch();

    const run = workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mockClient([]).client,
      judgeClient: judgeLlm(),
      log,
      repo,
      pathEnv: "",
    });

    await expect(run).rejects.toThrow("pass --base");

    await expect(
      workflow.run({
        dryRun: true,
        config: config(),
        reviewerClient: mockClient([]).client,
        judgeClient: judgeLlm(),
        log,
        repo,
        base: "nope",
        pathEnv: "",
      }),
    ).rejects.toThrow("cannot use nope as the base");
  });

  test("origin/HEAD is the default base", async () => {
    const { repo, base } = repoWithBranch();

    sh(repo, ["update-ref", "refs/remotes/origin/main", base]);
    sh(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

    const mock = mockClient([{ text: "done" }, { text: '{"findings":[]}' }]);

    const result = await workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mock.client,
      judgeClient: judgeLlm(),
      log,
      repo,
      pathEnv: "",
    });

    expect(result.baseSha).toBe(base);
  });

  test("known findings from a context file reach the reviewer", async () => {
    const { repo } = repoWithBranch();
    const mock = mockClient([{ text: "done" }, { text: '{"findings":[]}' }]);

    await workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mock.client,
      judgeClient: judgeLlm(),
      log,
      repo,
      base: "main",
      contextFile: packFile(),
      pathEnv: "",
    });

    expect(promptText(mock.calls[0])).toContain("Cart total races with checkout");
  });

  test("the permission group decides the tools; an unknown group is refused before git or the model is used", async () => {
    const { repo } = repoWithBranch();

    expect(PermissionGroups.SET.names).toEqual(["all", "read"]);

    for (const group of [undefined, "all", "read"]) {
      const mock = mockClient([{ text: "done" }, { text: '{"findings":[]}' }]);

      await workflow.run({
        dryRun: true,
        config: config(),
        reviewerClient: mock.client,
        judgeClient: judgeLlm(),
        log,
        repo,
        base: "main",
        ...(group === undefined ? {} : { group }),
        pathEnv: "",
      });

      expect({ group, tools: mock.calls[0]?.tools?.map((tool) => tool.name) }).toEqual({
        group,
        tools: ["list_dir", "read_file", "grep", "glob"],
      });
    }

    const mock = mockClient([]);

    const run = workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mock.client,
      judgeClient: judgeLlm(),
      log,
      repo: "/nonexistent",
      base: "main",
      group: "write",
      pathEnv: "",
    });

    await expect(run).rejects.toBeInstanceOf(ReviewInputError);
    await expect(run).rejects.toThrow('unknown permission group "write"; known groups: all, read');
    expect(mock.calls.length).toBe(0);
  });

  test("a group that misses a required permission stops the run before git or a model is used", async () => {
    const paths = new PermissionGroupSet({ paths: ["repo:read"] }).grant("paths");

    const grant = spyOn(PermissionGroups.SET, "grant").mockReturnValue(paths);

    const reviewer = mockClient([]);
    const judge = mockClient([]);

    const run = workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: reviewer.client,
      judgeClient: judge.client,
      log,
      repo: "/nonexistent",
      base: "main",
      group: "paths",
      pathEnv: "",
    });

    await expect(run).rejects.toBeInstanceOf(ReviewInputError);

    await expect(run).rejects.toThrow(
      [
        'the permission group "paths" cannot start this run:',
        "- harness judge needs the permission repo:search",
        "- harness reviewer needs the permission repo:search",
      ].join("\n"),
    );

    expect(grant).toHaveBeenCalledWith("paths");
    expect(reviewer.calls.length).toBe(0);
    expect(judge.calls.length).toBe(0);
  });

  test("judges and scores every kept finding in the reviewer's order; a judge error is stored with its reason", async () => {
    const { repo } = repoWithBranch();
    const second = { ...good, start_line: 5, end_line: 6, title: "Second" };
    const third = { ...good, start_line: 7, end_line: 8, title: "Third" };
    const fourth = { ...good, start_line: 9, end_line: 10, title: "Fourth" };
    const mock = mockClient([{ text: "done" }, { text: JSON.stringify({ findings: [good, second, third, fourth] }) }]);

    const judge = judgeLlm((context) => {
      const title = FakeJudgeLlm.titleOf(context);

      if (title === "Division by zero") {
        return { delayMs: 30, labels: { ...labels, priority: "P0", nature: "critical" } };
      }

      if (title === "Second") return { labels: { ...labels, verdict: "refuted" } };
      if (title === "Third") return { labels: undefined, error: "overloaded" };

      return { labels: { ...labels, verdict: "unverified", priority: "P2", fix_effort: "hard" } };
    });

    const result = await workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mock.client,
      judgeClient: judge,
      log,
      repo,
      base: "main",
      pathEnv: "",
    });

    expect(result.findings).toEqual([
      { ...good, file: "src/a.ts", ...judged, priority: "P0", nature: "critical", score: 95, action: "inline" },
      { ...second, file: "src/a.ts", ...judged, verdict: "refuted", score: 0, action: "stored" },
      { ...third, file: "src/a.ts", judge_error: "model_error: overloaded", action: "stored" },
      {
        ...fourth,
        file: "src/a.ts",
        ...judged,
        verdict: "unverified",
        priority: "P2",
        fix_effort: "hard",
        score: 7.5,
        action: "stored",
      },
    ]);

    expect(result.partial).toBe(false);
    expect(mock.calls.length).toBe(2);
    expect(judge.contexts.length).toBe(4);
  });

  test("the reviewer and the judge run on their own provider and model and report usage apart", async () => {
    const { repo } = repoWithBranch();
    const mock = mockClient([{ text: "done" }, { text: JSON.stringify({ findings: [good] }) }]);

    const judge = new FakeJudgeLlm(
      (context) => ({ name: FakeJudgeLlm.titleOf(context), labels }),
      "openrouter",
      "z-ai/glm-5",
    );

    const result = await workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mock.client,
      judgeClient: judge,
      log,
      repo,
      base: "main",
      pathEnv: "",
    });

    expect(result.usage).toEqual([
      { role: "reviewer", provider: "anthropic", model: "mock-model", input_tokens: 200, output_tokens: 20, calls: 2 },
      { role: "judge", provider: "openrouter", model: "z-ai/glm-5", input_tokens: 150, output_tokens: 20, calls: 2 },
    ]);

    expect(mock.calls.length).toBe(2);
    expect(judge.contexts.length).toBe(1);
    expect(judge.contexts[0]).toContain("Division by zero");
  });

  test("no finding means no judge call and no judge usage", async () => {
    const { repo } = repoWithBranch();
    const judge = judgeLlm();
    const mock = mockClient([{ text: "done" }, { text: JSON.stringify({ findings: [{ ...good, file: "nope.ts" }] }) }]);

    const result = await workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mock.client,
      judgeClient: judge,
      log,
      repo,
      base: "main",
      pathEnv: "",
    });

    expect(result.findings).toEqual([]);
    expect(result.usage.map((entry) => entry.role)).toEqual(["reviewer"]);
    expect(result.judgeToolCalls).toBe(0);
    expect(judge.contexts.length).toBe(0);
  });

  test("a used-up judge time budget makes the run partial and leaves the rest with a judge error", async () => {
    const { repo } = repoWithBranch();
    const clock = { now: 0 };
    const second = { ...good, start_line: 5, end_line: 6, title: "Second" };

    const result = await (await reviewComponent(ReviewWorkflow, () => clock.now)).run({
      dryRun: true,
      config: config("limits: { max_judge_parallel: 1, max_judge_duration_minutes: 1 }\n"),
      reviewerClient: mockClient([{ text: "done" }, { text: JSON.stringify({ findings: [good, second] }) }]).client,
      judgeClient: judgeLlm(() => ({ onRun: () => (clock.now += 50_000) })),
      log,
      repo,
      base: "main",
      pathEnv: "",
    });

    expect(result).toMatchObject({ partial: true, partialReason: "time_budget", judgePartialReason: "time_budget" });
    expect(result.reviewerPartialReason).toBeUndefined();
    expect(result.findings[0]).toMatchObject({ action: "summary", score: 50 });

    expect(result.findings[1]).toEqual({
      ...second,
      file: "src/a.ts",
      judge_error: "time_budget: the judge time budget was used up before this finding",
      action: "stored",
    });
  });

  test("the reviewer's time does not shorten the judge's time window", async () => {
    const { repo } = repoWithBranch();
    const clock = { now: 0 };
    const second = { ...good, start_line: 5, end_line: 6, title: "Second" };
    const reviewer = mockClient([{ text: "done" }, { text: JSON.stringify({ findings: [good, second] }) }]).client;

    const slowReviewer: ProviderLlm = {
      provider: reviewer.provider,
      model: reviewer.model,
      start: (input) => {
        const session = reviewer.start(input);

        return {
          runTools: (hooks, signal) => session.runTools(hooks, signal),
          finalize: async <T>(request: string, output: z.ZodType<T>, signal: AbortSignal) => {
            const outcome = await session.finalize(request, output, signal);

            clock.now += 30 * 60_000;

            return outcome;
          },
        };
      },
    };

    const result = await (await reviewComponent(ReviewWorkflow, () => clock.now)).run({
      dryRun: true,
      config: config("limits: { max_duration_minutes: 20, max_judge_duration_minutes: 10 }\n"),
      reviewerClient: slowReviewer,
      judgeClient: judgeLlm(),
      log,
      repo,
      base: "main",
      pathEnv: "",
    });

    expect(clock.now).toBe(30 * 60_000);
    expect(result.partial).toBe(false);
    expect(result.judgePartialReason).toBeUndefined();
    expect(result.findings.map((finding) => finding.action)).toEqual(["summary", "summary"]);
  });

  test("the judge parallelism and the tool limit of each judge call come from the config", async () => {
    const { repo } = repoWithBranch();
    const findings = [2, 5, 7, 9, 11].map((line) => ({ ...good, start_line: line, end_line: line, title: `L${line}` }));

    const review = async (extra: string) => {
      const judge = judgeLlm(() => ({ delayMs: 20, toolCalls: 4 }));

      const result = await workflow.run({
        dryRun: true,
        config: config(extra),
        reviewerClient: mockClient([{ text: "done" }, { text: JSON.stringify({ findings }) }]).client,
        judgeClient: judge,
        log,
        repo,
        base: "main",
        pathEnv: process.env.PATH ?? "",
      });

      return { judge, result };
    };

    const sequential = await review("limits: { max_judge_parallel: 1, max_judge_tool_calls: 3 }\n");

    expect(sequential.result.findings.length).toBe(5);
    expect(sequential.judge.maxRunning).toBe(1);
    expect(sequential.result.judgeToolCalls).toBe(15);
    expect(sequential.result.toolCalls).toBe(0);
    expect(sequential.judge.toolOutputs.filter((output) => String(output).startsWith("not run")).length).toBe(5);

    const parallel = await review("");

    expect(parallel.result.findings.length).toBe(5);
    expect(parallel.judge.maxRunning).toBe(4);
    expect(parallel.result.judgeToolCalls).toBe(20);
  });

  test("the reviewer and every judge call read the run's one set of capabilities, so the jail is built once", async () => {
    const { repo } = repoWithBranch();
    const findings = [2, 5, 7].map((line) => ({ ...good, start_line: line, end_line: line, title: `L${line}` }));
    const owners = new Set<Run>();
    const jails = new Set<unknown>();
    const read = Run.prototype.read;

    spyOn(Run.prototype, "read").mockImplementation(function (this: Run, owner, use) {
      const got = read.call(this, owner, use);

      owners.add(this);

      if (use.capability === RepoJail) jails.add(got);

      return got;
    });

    const judge = judgeLlm(() => ({ toolCalls: 2 }));

    const result = await workflow.run({
      dryRun: true,
      config: config(),
      reviewerClient: mockClient([
        { toolCalls: [{ name: "list_dir", input: {} }] },
        { text: "done" },
        { text: JSON.stringify({ findings }) },
      ]).client,
      judgeClient: judge,
      log,
      repo,
      base: "main",
      pathEnv: process.env.PATH ?? "",
    });

    expect(result.findings.length).toBe(3);
    expect(result.toolCalls).toBe(1);
    expect(result.judgeToolCalls).toBe(6);
    expect(judge.toolOutputs.length).toBe(6);
    expect(owners.size).toBe(1);
    expect(jails.size).toBe(1);
  });

  test("a jail that cannot be built ends the review with its error before the reviewer or a judge is called", async () => {
    const { repo } = repoWithBranch();
    const broken = new Error("the jail cannot be built");
    const built = spyOn(RepoJail.prototype, "build").mockRejectedValue(broken);
    const findings = [2, 5, 7].map((line) => ({ ...good, start_line: line, end_line: line, title: `L${line}` }));
    const reviewer = mockClient([{ text: "done" }, { text: JSON.stringify({ findings }) }]);
    const judge = judgeLlm(() => ({ toolCalls: 2 }));

    const review = workflow.run({
      dryRun: true,
      config: config("limits: { max_judge_parallel: 2 }\n"),
      reviewerClient: reviewer.client,
      judgeClient: judge,
      log,
      repo,
      base: "main",
      pathEnv: process.env.PATH ?? "",
    });

    await expect(review).rejects.toBe(broken);

    expect(built).toHaveBeenCalledTimes(1);
    expect(reviewer.calls.length).toBe(0);
    expect(judge.contexts.length).toBe(0);
    expect(judge.events).toEqual([]);
  });

  test("the spec gives the workflow's name, description and flow steps in run order, each with its name and description", () => {
    const spec = workflowSpec(ReviewWorkflow);

    expect(spec.name).toBe("review");
    expect(spec.description).toStartWith("Reviews the change between the base branch and HEAD");

    expect(spec.steps.map((step) => flowStepSpec(step).name)).toEqual([
      "merge-request",
      "change",
      "written-comments",
      "reviewer",
      "candidates",
      "judge",
      "score",
      "comment-plan",
      "comment-write",
    ]);

    expect(spec.steps.every((step) => flowStepSpec(step).description.endsWith("."))).toBe(true);
  });

  test("the deadlines leave the final call a reserve", () => {
    expect(ReviewWorkflow.deadlines(1000, 20)).toEqual({
      stepDeadline: 1000 + 15 * 60_000,
      finalizeDeadline: 1000 + 20 * 60_000,
    });

    expect(ReviewWorkflow.deadlines(0, 1)).toEqual({ stepDeadline: 45_000, finalizeDeadline: 60_000 });
  });
});

describe("context file", () => {
  const dir = () => {
    const repo = tempRepo("kerpeten-context-");

    dirs.push(repo);

    return repo;
  };

  test("reads the known titles, files and reasons and ignores every other field", async () => {
    expect(packs.read(packFile())).toEqual({
      ok: true,
      pack: {
        known: [
          {
            title: "Cart total races with checkout",
            file: "src/cart.ts",
            reason: "Single-writer queue makes this safe.",
          },
          { title: "Retry loop has no cap", file: "src/net.ts" },
        ],
      },
    });
  });

  test("refuses what is not a valid pack", async () => {
    const d = dir();

    const files: Record<string, string | Uint8Array> = {
      "known-not-a-list.json": JSON.stringify({ ...pack, known: "anything" }),
      "title-missing.json": JSON.stringify({ known: [{ file: "src/a.ts" }] }),
      "array.json": "[]",
      "broken.json": "{",
      "latin1.json": new Uint8Array([0x7b, 0xe9, 0x7d]),
    };

    for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content);

    writeFileSync(join(d, "run-record.json"), JSON.stringify({ run_id: "r", findings: [] }));

    expect(packs.read(join(d, "run-record.json"))).toEqual({
      ok: false,
      error: `${join(d, "run-record.json")}: not a context pack: /: missing required key "known"`,
    });

    writeFileSync(join(d, "file-missing.json"), JSON.stringify({ known: [{ title: "t" }] }));

    expect(packs.read(join(d, "file-missing.json"))).toEqual({
      ok: false,
      error: `${join(d, "file-missing.json")}: not a context pack: /known/0: missing required key "file"`,
    });

    mkdirSync(join(d, "dir.json"));

    for (const name of [...Object.keys(files), "dir.json", "absent.json"]) {
      expect({ name, ok: (await packs.read(join(d, name))).ok }).toEqual({ name, ok: false });
    }
  });

  test.skipIf(process.getuid?.() === 0)(
    "words read errors as the config loader does, so an unreadable file is not called bad UTF-8",
    async () => {
      const d = dir();

      writeFileSync(join(d, "latin1.json"), new Uint8Array([0x7b, 0xe9, 0x7d]));

      expect(await packs.read(join(d, "latin1.json"))).toEqual({
        ok: false,
        error: `${join(d, "latin1.json")}: not UTF-8`,
      });

      const locked = join(d, "locked.json");

      writeFileSync(locked, "{}");
      chmodSync(locked, 0o000);

      try {
        expect(await packs.read(locked)).toEqual({
          ok: false,
          error: `${locked}: cannot be read (EACCES)`,
        });
      } finally {
        chmodSync(locked, 0o600);
      }

      expect(await packs.read(join(d, "absent.json"))).toEqual({
        ok: false,
        error: `${join(d, "absent.json")}: cannot be read (ENOENT)`,
      });
    },
  );

  test("refuses a file over the size cap", async () => {
    const d = dir();

    writeFileSync(join(d, "big.json"), " ".repeat(5_000_001));

    expect(await packs.read(join(d, "big.json"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("larger than"),
    });
  });
});
