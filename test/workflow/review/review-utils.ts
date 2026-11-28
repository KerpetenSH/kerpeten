import { rmSync } from "node:fs";
import type { Class } from "@asenajs/ioc";
import { type After, WorkflowEnd } from "@kerpetensh/harness-kit";
import { KerpetenApp } from "../../../src/app/KerpetenApp.ts";
import { ConfigLoader } from "../../../src/capability/config/ConfigLoader.ts";
import type { KerpetenConfig } from "../../../src/capability/config/types/config.ts";
import type { JudgeOutput } from "../../../src/harnesses/judge/types/judge.ts";
import type { ReviewerFinding, ReviewerRun } from "../../../src/harnesses/review/types/review.ts";
import type { CandidateStep } from "../../../src/workflow/review/step/CandidateStep.ts";
import { ChangeStep } from "../../../src/workflow/review/step/ChangeStep.ts";
import type { WrittenCommentStep } from "../../../src/workflow/review/step/WrittenCommentStep.ts";
import type { ReviewInput } from "../../../src/workflow/review/types/review-workflow.ts";
import { runStep } from "../../app/app-utils.ts";
import { commit, sh, tempRepo, write } from "../../capability/git/git-utils.ts";
import { log } from "../../harnesses/harnesses-utils.ts";
import { mockClient } from "../../test-utils.ts";

export const dirs: string[] = [];

/** A component of a started container of the components the CLI runs with, whose clock is `now`. */
export async function reviewComponent<T>(target: Class<T>, now: () => number = () => 0): Promise<T> {
  const { app } = await KerpetenApp.start(
    { io: { out: () => {}, err: () => {} }, env: {}, now },
    KerpetenApp.COMPONENTS,
  );

  return app.resolve(target);
}

export const good: ReviewerFinding = {
  file: "./src/a.ts",
  start_line: 2,
  end_line: 2,
  category: "bug",
  title: "Division by zero",
  body: "y can be 0",
  fix: "Throw when y is 0.",
  evidence: [{ location: "src/a.ts:2" }],
};

export function config(extra = ""): KerpetenConfig {
  const parsed = new ConfigLoader().parse(
    `models:\n  reviewer: { provider: anthropic, model: m }\n  judge: { provider: anthropic, model: m }\n${extra}`,
  );

  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));

  return parsed.config;
}

/**
 * What belongs to a run besides its change: a dry run, the default configuration, two model clients never called and
 * a silent log.
 */
export function runValues(): Pick<ReviewInput, "dryRun" | "config" | "reviewerClient" | "judgeClient" | "log"> {
  return {
    dryRun: true,
    config: config(),
    reviewerClient: mockClient([]).client,
    judgeClient: mockClient([]).client,
    log,
  };
}

export function cleanDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function repoWithBranch(): { repo: string; base: string; head: string } {
  const repo = tempRepo("kerpeten-flow step-");

  dirs.push(repo);
  write(repo, { "src/a.ts": "export const a = 1;\n", "README.md": "x\n" });

  const base = commit(repo, "base");

  sh(repo, ["checkout", "-q", "-b", "feature"]);

  write(repo, { "src/a.ts": "export const a = 1;\nexport const div = (x: number, y: number) => x / y;\n" });

  const head = commit(repo, "add div\n\nIt divides.");

  return { repo, base, head };
}

/** The state of a review of no merge request after its change was read: no comment of a merge request was looked for. */
export async function changed(repo: string): Promise<After<typeof WrittenCommentStep>> {
  const input: ReviewInput = { repo, base: "main", pathEnv: process.env.PATH ?? "", ...runValues() };
  const state = { ...input, mergeRequest: undefined };
  const added = await runStep(await reviewComponent(ChangeStep), state);

  if (added instanceof WorkflowEnd) throw new Error("the change is empty");

  return { ...state, ...added, written: undefined };
}

export function reviewerRun(findings: readonly ReviewerFinding[]): ReviewerRun {
  return {
    completed: true,
    findings,
    partialReason: undefined,
    error: undefined,
    usage: { role: "reviewer", provider: "anthropic", model: "m", input_tokens: 1, output_tokens: 1, calls: 1 },
    unknownUsageCalls: 0,
    toolCalls: 0,
    steps: 1,
    promptVersion: "v1",
  };
}

export const labels: JudgeOutput = {
  verdict: "verified",
  priority: "P1",
  nature: "edge_case",
  fix_effort: "easy",
  rationale: "y is never checked",
  evidence: [{ location: "src/a.ts:2" }],
};

export async function candidates(repo: string, kept: readonly ReviewerFinding[]): Promise<After<typeof CandidateStep>> {
  return {
    ...(await changed(repo)),
    review: reviewerRun(kept),
    candidates: { kept, dropped: {}, clipped: 0 },
  };
}
