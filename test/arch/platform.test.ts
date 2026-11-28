import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityUses, capabilitySpec, harnessSpec } from "@kerpetensh/harness-kit";
import { GitHubCommentWriter } from "../../src/capability/platform/GitHubCommentWriter.ts";
import { GitHubPlatform } from "../../src/capability/platform/GitHubPlatform.ts";
import { GitLabPlatform } from "../../src/capability/platform/GitLabPlatform.ts";
import { OriginProject } from "../../src/capability/platform/OriginProject.ts";
import { PlatformChoice } from "../../src/capability/platform/PlatformChoice.ts";
import { RepoJail } from "../../src/capability/repo/RepoJail.ts";
import { Harnesses } from "../../src/harnesses/Harnesses.ts";
import { CommentWriteStep } from "../../src/workflow/review/step/CommentWriteStep.ts";
import { MergeRequestStep } from "../../src/workflow/review/step/MergeRequestStep.ts";
import { WrittenCommentStep } from "../../src/workflow/review/step/WrittenCommentStep.ts";

const root = join(import.meta.dir, "..", "..");
const PLATFORM = "src/capability/platform/";

const IMPORT =
  /\b(?:import|export)\b[^;]*from\s*["'][^"']*capability\/platform\/[^"']*["']|\bimport\s*\(\s*["'][^"']*capability\/platform\//;

const READERS = ["src/app/KerpetenApp.ts", "src/workflow/review/", "src/workflow/review-command/"];

const PLATFORMS = [
  { capability: GitHubPlatform, file: "GitHubPlatform.ts" },
  { capability: GitLabPlatform, file: "GitLabPlatform.ts" },
];

const WRITER = { capability: GitHubCommentWriter, file: "GitHubCommentWriter.ts" };

const GITHUB_CLI = "GitHubCli.ts";

const CONCRETE = /\bfrom\s*["'][^"']*capability\/platform\/Git(?:Hub|Lab)(?:Platform|CommentWriter|Cli)\.ts["']/;

const WRITES = /\b(?:POST|PATCH|PUT|DELETE)\b|--input|--field|--raw-field|"-[fFX]"/;

function platformSource(file: string): string {
  return readFileSync(join(root, PLATFORM, file), "utf8");
}

/** The names of the methods a class of the platform folder declares `public`, sorted. */
function published(capability: { readonly prototype: object }, file: string): string[] {
  const own = Object.getOwnPropertyNames(capability.prototype).filter((name) => name !== "constructor");
  const source = platformSource(file);

  return own.filter((name) => new RegExp(`^  public (?:async )?${name}\\(`, "m").test(source)).sort();
}

test("only the review workflows and the composition root import the platform capability, its types included", () => {
  const importing = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: root })]
    .filter((path) => !path.startsWith(PLATFORM))
    .filter((path) => IMPORT.test(readFileSync(join(root, path), "utf8")))
    .sort();

  expect(importing).toContain("src/app/KerpetenApp.ts");
  expect(importing).toContain("src/workflow/review/step/MergeRequestStep.ts");
  expect(importing).toContain("src/workflow/review/step/WrittenCommentStep.ts");
  expect(importing).toContain("src/workflow/review/step/CommentWriteStep.ts");
  expect(importing.filter((path) => !READERS.some((reader) => path.startsWith(reader)))).toEqual([]);
});

test("no workflow names a platform capability: the flow steps take the platform from the run's platform choice", () => {
  const naming = [...new Bun.Glob("src/workflow/**/*.ts").scanSync({ cwd: root })]
    .filter((path) => CONCRETE.test(readFileSync(join(root, path), "utf8")))
    .sort();

  expect(naming).toEqual([]);

  expect(CapabilityUses.of(PlatformChoice).map((use) => use.capability)).toEqual(
    expect.arrayContaining([...PLATFORMS.map((platform) => platform.capability), WRITER.capability]),
  );

  expect(CapabilityUses.of(MergeRequestStep).map((use) => use.capability)).toEqual([PlatformChoice]);
  expect(CapabilityUses.of(WrittenCommentStep).map((use) => use.capability)).toEqual([PlatformChoice]);
  expect(CapabilityUses.of(CommentWriteStep).map((use) => use.capability)).toEqual([PlatformChoice]);
});

/** Every class the tools of the harnesses take with `@Use`, and what those take in turn. */
function reachedByTools(): Set<object> {
  const reached = new Set<object>();
  const open: object[] = Harnesses.ALL.flatMap((harness) => [...harnessSpec(harness).tools]);

  for (let target = open.pop(); target !== undefined; target = open.pop()) {
    for (const use of CapabilityUses.of(target)) {
      if (reached.has(use.capability)) continue;

      reached.add(use.capability);
      open.push(use.capability);
    }
  }

  return reached;
}

test("the platform capabilities, the writer among them, declare no permission, so no tool can take them, and no tool of a harness reaches them or the platform choice", () => {
  const reached = reachedByTools();

  expect(reached).toContain(RepoJail);
  expect(reached).not.toContain(PlatformChoice);
  expect(reached).not.toContain(OriginProject);

  for (const { capability } of [...PLATFORMS, WRITER]) {
    expect(capabilitySpec(capability).permission).toBeUndefined();
    expect(reached).not.toContain(capability);
  }
});

for (const { capability, file } of PLATFORMS) {
  test(`every public method of ${capability.name} is one of its typed reads, and nothing in it writes`, () => {
    const source = platformSource(file);

    expect(published(capability, file)).toEqual(["comments", "mergeRequest"]);
    expect(source).not.toMatch(/^ {2}public (?:async )?\w+\([^)]*(?:args|string\[\])/m);
    expect(source).not.toMatch(WRITES);
  });
}

test("the GitHub reader starts gh only through the shared GET: neither it nor what it shares with the writer can write", () => {
  const reader = platformSource("GitHubPlatform.ts");
  const shared = platformSource(GITHUB_CLI);

  expect(reader).toContain("export class GitHubPlatform extends GitHubCli ");
  expect(reader).not.toMatch(/this\.(?:stream|collect)\(|--method/);

  expect(shared).not.toMatch(WRITES);
  expect([...shared.matchAll(/"--method", "(\w+)"/g)].map((match) => match[1])).toEqual(["GET"]);
  expect(shared.match(/this\.(?:stream|collect)\(/g)).toEqual(["this.stream("]);
  expect(shared).toContain('const read = [...GitHubCli.READ, "--hostname", project.host, ...args];');
  expect(published({ prototype: Object.getPrototypeOf(GitHubPlatform.prototype) }, GITHUB_CLI)).toEqual([]);
});

test("the GitHub writer has two typed methods and makes three fixed requests, with the text on standard input", () => {
  const source = platformSource(WRITER.file);

  expect(published(WRITER.capability, WRITER.file)).toEqual(["writeLineComments", "writeSummary"]);
  expect(source).not.toMatch(/^ {2}public (?:async )?\w+\([^)]*(?:args|string\[\])/m);

  expect([...source.matchAll(/"--method", "(\w+)"/g)].map((match) => match[1]).sort()).toEqual(["PATCH", "POST"]);
  expect(source).not.toMatch(/\b(?:PUT|DELETE)\b|--field|--raw-field|"-[fFX]"/);

  expect(source.match(/this\.(?:stream|collect)\(/g)).toEqual(["this.stream("]);

  expect(source).toContain(
    'const write = [...method, "--hostname", project.host, path, ...GitHubCommentWriter.FROM_STDIN];',
  );

  expect(source).toContain('private static readonly FROM_STDIN: readonly string[] = ["--input", "-"];');
  expect(source).toMatch(/const path = `repos\/\$\{project\.path\}\/\$\{endpoint\}`;/);

  const sent = [...source.matchAll(/this\.send\(\s*project,\s*number,\s*GitHubCommentWriter\.(\w+),\s*(`[^`]*`)/g)];

  expect(source.match(/this\.send\(/g)?.length).toBe(sent.length);

  const shown = sent.map((match) => `${match[1]} ${match[2]?.replace(/\$\{([\w.]+)\}/g, "<$1>")}`);

  expect(shown.sort()).toEqual([
    "CREATE `issues/<number>/comments`",
    "CREATE `pulls/<number>/reviews`",
    "UPDATE `issues/comments/<ref.id>`",
  ]);
});

test("the platform capabilities, the writer and the platform choice take the project from the origin remote, and only the origin project reads the URL of a remote", () => {
  for (const user of [...PLATFORMS.map((platform) => platform.capability), WRITER.capability, PlatformChoice]) {
    expect(CapabilityUses.of(user).map((use) => use.capability)).toContain(OriginProject);
  }

  const reading = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: root })]
    .filter((path) => /originUrl\(|RemoteProject\.parse\(/.test(readFileSync(join(root, path), "utf8")))
    .sort();

  expect(reading).toEqual(["src/capability/git/Git.ts", "src/capability/platform/OriginProject.ts"]);

  for (const file of [GITHUB_CLI, "GitLabPlatform.ts", WRITER.file]) {
    const source = platformSource(file);

    expect(source).not.toMatch(/\{owner\}\/\{repo\}|:fullpath/);
    expect(source).toContain('"--hostname", project.host');
  }
});
