import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityRegistry, type CapabilitySpec, ExitCode } from "@kerpetensh/harness-kit";
import { KerpetenApp } from "../../src/app/KerpetenApp.ts";

const root = join(import.meta.dir, "..", "..");

async function registered(): Promise<readonly CapabilitySpec[]> {
  const { app } = await KerpetenApp.start({ io: { out: () => {}, err: () => {} }, env: {} }, KerpetenApp.COMPONENTS);

  try {
    return (await app.resolve(CapabilityRegistry)).specs;
  } finally {
    await app.stop();
  }
}

describe("capabilities", () => {
  test("prints every capability with its permission and description, then the permission groups and the harnesses", async () => {
    const out: string[] = [];

    const code = await KerpetenApp.run({ io: { out: (line) => out.push(line), err: () => {} }, env: {} }, [
      "capabilities",
    ]);

    expect(code).toBe(ExitCode.OK);

    expect(out.filter((line) => !line.startsWith(" "))).toEqual([
      "answer-reader",
      "chatgpt-auth-file",
      "chatgpt-oauth",
      "chatgpt-sign-in",
      "config-file",
      "config-file-writer (permission: config:write)",
      "context-pack-file",
      "extra-context-file",
      "git",
      "git-diff",
      "git-root",
      "github-comment-writer",
      "github-platform",
      "gitlab-platform",
      "repo-jail (permission: repo:read)",
      "ripgrep (permission: repo:search)",
      "search-timer (permission: repo:read)",
      "",
      "permission groups",
      "",
      "harnesses",
    ]);

    expect(out.length).toBe((await registered()).length * 2 + 8);

    expect(out.slice(-8)).toEqual([
      "",
      "permission groups",
      "    all: every permission",
      "    read: repo:read, repo:search",
      "",
      "harnesses",
      "    judge: repo:read, repo:search",
      "    reviewer: repo:read, repo:search",
    ]);

    expect(out).toContain(
      "    Reads .kerpeten.yml, checks it against the schema, applies the defaults and hashes the result.",
    );
  });

  test("the repository capabilities and the config file writer declare their permissions and the others declare none", async () => {
    const permissions = Object.fromEntries((await registered()).map((spec) => [spec.name, spec.permission]));

    expect(permissions).toEqual({
      "answer-reader": undefined,
      "chatgpt-auth-file": undefined,
      "chatgpt-oauth": undefined,
      "chatgpt-sign-in": undefined,
      "config-file": undefined,
      "config-file-writer": "config:write",
      "context-pack-file": undefined,
      "extra-context-file": undefined,
      git: undefined,
      "git-diff": undefined,
      "git-root": undefined,
      "github-comment-writer": undefined,
      "github-platform": undefined,
      "gitlab-platform": undefined,
      "repo-jail": "repo:read",
      ripgrep: "repo:search",
      "search-timer": "repo:read",
    });
  });

  test("the kit lists every class of the project marked with @Capability, from the container", async () => {
    const marked = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: root })].filter((path) =>
      /^@Capability\(/m.test(readFileSync(join(root, path), "utf8")),
    );

    expect(marked.length).toBe(17);
    expect((await registered()).length).toBe(marked.length);
  });
});
