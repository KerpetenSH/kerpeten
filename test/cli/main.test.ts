import { describe, expect, test } from "bun:test";
import type { Class } from "@asenajs/ioc";
import { ExitCode, harnessSpec } from "@kerpetensh/harness-kit";
import pkg from "../../package.json" with { type: "json" };
import { KerpetenApp } from "../../src/app/KerpetenApp.ts";
import { PermissionGroups } from "../../src/capability/PermissionGroups.ts";
import { JudgeHarness } from "../../src/harnesses/judge/JudgeHarness.ts";
import { ReviewerHarness } from "../../src/harnesses/review/ReviewerHarness.ts";
import { Scorer } from "../../src/layer/scoring/Scorer.ts";
import { GlobTool } from "../../src/tools/glob/GlobTool.ts";
import { AuthCommand } from "../../src/workflow/auth/AuthCommand.ts";
import { ReviewWorkflow } from "../../src/workflow/review/ReviewWorkflow.ts";
import { JudgeStep } from "../../src/workflow/review/step/JudgeStep.ts";
import { errorChain } from "../test-utils.ts";
import { BrokenReviewer } from "./BrokenReviewer.ts";
import { Unregistered } from "./Unregistered.ts";

async function runWith(
  components: readonly Class[],
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const code = await KerpetenApp.run({ io, env: {} }, argv, components);

  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  return runWith(KerpetenApp.COMPONENTS, argv);
}

describe("cli", () => {
  test("prints the version and the usage", async () => {
    expect(await run("--version")).toEqual({ code: ExitCode.OK, out: pkg.version, err: "" });
    expect((await run("--help")).out).toContain("kerpeten review");
    expect((await run()).code).toBe(ExitCode.USAGE);
  });

  test("the usage lists one flag per permission group and no removed command", async () => {
    expect(PermissionGroups.SET.names).toEqual(["all", "read"]);

    const usage = (await run("--help")).out;

    expect(usage).toContain(
      "kerpeten review [--dry-run] [--full] [--base <rev>] [--mr <n>] [--context-file <path>] [--extra-context <path or ->] [--json] [--all | --read]",
    );

    expect(usage).toContain("review permission group: at most one of --all, --read; --all when none is given");
    expect(usage).toContain("      Review the change between the base branch and HEAD");
    expect(usage).toContain("      Check this build without the network");
    expect(usage).toContain("  kerpeten init\n");
    expect(usage).toContain("      Ask for the provider and model of the reviewer and of the judge");
    expect(usage).not.toMatch(/\b(eval|collect|submit)\b|--out/);
  });

  const usageErrors: [string, string[]][] = [
    ["an unknown command", ["deploy"]],
    ["a prototype key as command", ["constructor"]],
    ["an unknown option", ["review", "--force"]],
    ["a positional where none is taken", ["review", "extra"]],
    ["a string option without a value", ["review", "--base"]],
    ["a revision that reads as an option", ["review", "--base=--output=/tmp/x"]],
    ["a range as base", ["review", "--base", "a..b"]],
    ["a boolean option given a value", ["review", "--dry-run=yes"]],
    ["the removed eval command", ["eval", "--repeat", "3"]],
    ["the removed collect command", ["collect", "--mr", "7"]],
    ["the removed submit command", ["submit", "run.json"]],
    ["the removed review --out option", ["review", "--dry-run", "--out", "run.json"]],
    ["two permission group flags", ["review", "--dry-run", "--all", "--read"]],
    ["a permission group flag given a value", ["review", "--read=yes"]],
    ["a positional given to self-check", ["self-check", "contract"]],
    ["a positional given to init", ["init", "here"]],
    ["an option given to init", ["init", "--provider", "chatgpt"]],
  ];

  for (const [name, argv] of usageErrors) {
    test(`exits 2 on ${name}`, async () => {
      const result = await run(...argv);

      expect(result.code).toBe(ExitCode.USAGE);
      expect(result.err).toMatch(/^kerpeten( [a-z-]+)?: \S/);
      expect(result.err).toContain("\nusage:\n");
    });
  }

  test("a review that would write but names no pull request is a usage error that says what to do", async () => {
    const result = await run("review", "--base", "main");

    expect(result.code).toBe(ExitCode.USAGE);

    expect(result.err).toBe(
      "kerpeten review: a review without --dry-run writes its comments to a pull request, and this one names none, so it has nowhere to write: give --mr <n> to review pull request n and write to it, or --dry-run to only print the findings",
    );
  });

  test("a wrong harness wiring stops every call, help and version included, with every problem", async () => {
    const components = [...KerpetenApp.COMPONENTS, BrokenReviewer];

    const err = [
      "kerpeten: the harness wiring is wrong:",
      "- harness broken does not list the permission repo:search, which its tool grep needs",
      "- harness broken lists the permission repo:write, which none of its tools uses",
    ].join("\n");

    for (const argv of [[], ["--version"], ["--help"], ["capabilities"], ["self-check"], ["review"], ["deploy"]]) {
      expect({ argv, ...(await runWith(components, argv)) }).toEqual({ argv, code: ExitCode.FAILED, out: "", err });
    }
  });

  test("a command the CLI lists that is missing from the component list stops the start", async () => {
    const components = KerpetenApp.COMPONENTS.filter((component) => component !== AuthCommand);
    let thrown: unknown;

    try {
      await KerpetenApp.start({ io: { out: () => {}, err: () => {} }, env: {} }, components);
    } catch (error) {
      thrown = error;
    }

    expect(errorChain(thrown)).toEqual([
      "the CLI kerpeten lists AuthCommand, which is not registered in the container",
    ]);
  });

  test("the start gives the review harnesses their tool singletons", async () => {
    const { app } = await KerpetenApp.start({ io: { out: () => {}, err: () => {} }, env: {} }, KerpetenApp.COMPONENTS);

    for (const harness of [ReviewerHarness, JudgeHarness]) {
      const singleton = await app.resolve<ReviewerHarness | JudgeHarness>(harness);

      expect(() => singleton.bind([])).toThrow(`the harness ${harnessSpec(harness).name} already has its tools`);
    }

    await app.stop();
  });

  test("a tool a harness lists that is missing from the component list stops the start", async () => {
    const components = KerpetenApp.COMPONENTS.filter((component) => component !== GlobTool);
    let thrown: unknown;

    try {
      await KerpetenApp.start({ io: { out: () => {}, err: () => {} }, env: {} }, components);
    } catch (error) {
      thrown = error;
    }

    expect(errorChain(thrown)).toEqual([
      [
        "the harness wiring is wrong:",
        "- harness judge lists GlobTool, which is not registered in the container",
        "- harness reviewer lists GlobTool, which is not registered in the container",
      ].join("\n"),
    ]);
  });

  test("the start gives the review workflow its flow step singletons", async () => {
    const { app } = await KerpetenApp.start({ io: { out: () => {}, err: () => {} }, env: {} }, KerpetenApp.COMPONENTS);
    const workflow = await app.resolve(ReviewWorkflow);

    expect(() => workflow.bind([])).toThrow("the workflow review already has its flow steps");

    await app.stop();
  });

  test("a flow step the review workflow lists that is missing from the component list stops the start", async () => {
    const components = KerpetenApp.COMPONENTS.filter((component) => component !== JudgeStep);

    expect(await runWith(components, ["--version"])).toEqual({
      code: ExitCode.FAILED,
      out: "",
      err: [
        "kerpeten: the harness wiring is wrong:",
        "- workflow review lists JudgeStep, which is not registered in the container",
      ].join("\n"),
    });
  });

  test("a component a flow step injects that is missing from the component list stops the start", async () => {
    const components = KerpetenApp.COMPONENTS.filter((component) => component !== Scorer);

    expect(await runWith(components, ["--version"])).toEqual({
      code: ExitCode.FAILED,
      out: "",
      err: [
        "kerpeten: 'kerpeten:scorer' is not registered (injected into ScoreStep.scorer)",
        "kerpeten: kerpeten:scorer is not registered",
      ].join("\n"),
    });
  });

  test("a class in the component list that is not marked as a component stops the start", async () => {
    const components = [...KerpetenApp.COMPONENTS, Unregistered];

    await expect(KerpetenApp.start({ io: { out: () => {}, err: () => {} }, env: {} }, components)).rejects.toThrow(
      "'Unregistered' is listed in components but carries no component decorator",
    );
  });

  test("self-check passes", async () => {
    const result = await run("self-check");

    expect(result.code).toBe(ExitCode.OK);
    expect(result.out).toContain("self-check: model SDK round trip passed");
  });
});
