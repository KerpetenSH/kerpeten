import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@kerpetensh/harness-kit";
import { KerpetenApp } from "../../src/app/KerpetenApp.ts";
import { plan, signIn, tempHome } from "../capability/chatgpt/chatgpt-utils.ts";
import { FakeChatGpt } from "../capability/chatgpt/FakeChatGpt.ts";
import { commit, sh, tempRepo, write } from "../capability/git/git-utils.ts";
import { FakeGitHub } from "../capability/platform/FakeGitHub.ts";
import { fakeGitHub, GITHUB_ORIGIN, gitHub, gitHubWrites, pullJson } from "../capability/platform/platform-utils.ts";

const CONFIG = `models:
  reviewer: { provider: chatgpt, model: gpt-6.1-sol }
  judge: { provider: chatgpt, model: gpt-6.1-sol, effort: low }
`;

const FINDING = {
  file: "src/a.ts",
  start_line: 2,
  end_line: 2,
  category: "bug",
  title: "Division by zero",
  body: "y can be 0",
  fix: "Throw when y is 0.",
  evidence: [{ location: "src/a.ts:2", note: "no guard" }],
};

const dirs: string[] = [];

let fake: FakeChatGpt;

const globals = globalThis as Record<string, unknown>;

const warnings = globals.AI_SDK_LOG_WARNINGS;

beforeEach(() => {
  globals.AI_SDK_LOG_WARNINGS = false;
  fake = new FakeChatGpt();
});

afterEach(() => {
  fake.stop();
  globals.AI_SDK_LOG_WARNINGS = warnings;
});

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = tempRepo("kerpeten-review-chatgpt-");

  dirs.push(dir);
  write(dir, { "src/a.ts": "export const a = 1;\n", ".kerpeten.yml": CONFIG });
  commit(dir, "base");
  sh(dir, ["checkout", "-q", "-b", "feature"]);
  write(dir, { "src/a.ts": "export const a = 1;\nexport const div = (x: number, y: number) => x / y;\n" });
  commit(dir, "add div");

  return dir;
}

/** Runs the command in `cwd`, a new repository when none is given, with the folder `bin` first on the PATH when one is given. */
async function review(
  home: string,
  argv: string[] = ["review", "--dry-run", "--base", "main", "--json"],
  place: { cwd?: string; bin?: string } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const path = process.env.PATH ?? "";

  const code = await KerpetenApp.run(
    {
      io: { out: (line) => out.push(line), err: (line) => err.push(line) },
      env: { HOME: home, PATH: place.bin === undefined ? path : `${place.bin}:${path}`, KERPETEN_LOG_LEVEL: "debug" },
      cwd: place.cwd ?? repo(),
      now: () => 0,
      chatgpt: fake.endpoints,
    },
    argv,
  );

  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function signedInHome(): Promise<string> {
  const home = tempHome(dirs);

  await signIn(fake, await plan(fake, home));

  return home;
}

function leaks(text: string): string[] {
  return [...fake.issuedTokens, FakeChatGpt.CODE_PREFIX].filter((secret) => text.includes(secret));
}

describe("kerpeten review with provider chatgpt", () => {
  test("without a sign-in the review stops before any model call and says to sign in", async () => {
    const result = await review(tempHome(dirs));

    expect(result.code).toBe(ExitCode.USAGE);
    expect(result.out).toBe("");
    expect(result.err).toContain("not signed in to ChatGPT; run `kerpeten auth login`");
    expect(fake.requests("/v1/responses")).toHaveLength(0);
  });

  test("a plan limit in the judge flow step ends the review with an error and prints no findings", async () => {
    const home = await signedInHome();

    fake.responses.push(
      () => FakeChatGpt.text("done"),
      () => FakeChatGpt.text(JSON.stringify({ findings: [FINDING] })),
      () => FakeChatGpt.limit(),
    );

    const result = await review(home);

    expect(result.code).toBe(ExitCode.FAILED);
    expect(result.out).toBe("");
    expect(result.err).toContain("the review stopped and gave no result");
    expect(result.err).toContain("subscription_sharing_usage_limit_exceeded");
    expect(result.err).toContain("https://chatgpt.com/settings/usage");

    const calls = fake.requests("/v1/responses");

    expect(calls).toHaveLength(3);

    for (const call of calls) {
      expect(call.json).toMatchObject({ store: false, stream: true, model: "gpt-6.1-sol" });
      expect(call.json).not.toHaveProperty("max_output_tokens");
      expect(call.headers.authorization).toBe("Bearer fake-access-token-1");
    }

    expect(calls[2]?.json?.reasoning).toMatchObject({ effort: "low" });
    expect(leaks(result.out + result.err)).toEqual([]);
  });

  test("a review the plan stopped writes nothing to the pull request: the summary comment that is there stays as it is", async () => {
    const home = await signedInHome();
    const cwd = repo();
    const head = sh(cwd, ["rev-parse", "HEAD"]);
    const base = sh(cwd, ["rev-parse", "main"]);

    sh(cwd, ["remote", "add", "origin", GITHUB_ORIGIN]);

    const good = {
      id: 77,
      user: { login: FakeGitHub.USER },
      body: `## Kerpeten review\n\nA good summary of an earlier run.\n\n<!-- kerpeten:summary v1 head=${head} -->`,
      created_at: FakeGitHub.NOW,
    };

    for (const stopped of ["in the judge", "in the reviewer"]) {
      const bin = mkdtempSync(join(tmpdir(), "kerpeten-review-chatgpt-bin-"));

      dirs.push(bin);
      fakeGitHub(bin, { pull: pullJson({ headSha: head, baseSha: base }), conversation: [good] });

      fake.responses.push(
        ...(stopped === "in the judge"
          ? [() => FakeChatGpt.text("done"), () => FakeChatGpt.text(JSON.stringify({ findings: [FINDING] }))]
          : []),
        () => FakeChatGpt.limit(),
      );

      const result = await review(home, ["review", "--mr", "12"], { cwd, bin });

      expect({ stopped, code: result.code, out: result.out }).toEqual({ stopped, code: ExitCode.FAILED, out: "" });
      expect(result.err).toContain("the ChatGPT plan usage limit is reached");
      expect(gitHubWrites(bin)).toEqual([]);
      expect(gitHub(bin).conversation).toEqual([good]);
      expect(result.err).not.toContain('"comments written"');
      expect(result.err).not.toContain("no comment");
    }
  });

  test("a plan limit in the reviewer's tool phase ends the review before the judge", async () => {
    const home = await signedInHome();

    fake.responses.push(() => FakeChatGpt.limit());

    const result = await review(home, ["review", "--dry-run", "--base", "main"]);

    expect(result.code).toBe(ExitCode.FAILED);
    expect(result.out).toBe("");
    expect(result.err).toContain("the ChatGPT plan usage limit is reached");
    expect(fake.requests("/v1/responses")).toHaveLength(1);
    expect(leaks(result.out + result.err)).toEqual([]);
  });

  test("a full review through the plan prints the findings and the usage under provider chatgpt", async () => {
    const home = await signedInHome();

    const verdict = {
      verdict: "verified",
      priority: "P1",
      nature: "edge_case",
      fix_effort: "easy",
      rationale: "y is never checked",
      evidence: [{ location: "src/a.ts:2", note: "no guard" }],
    };

    fake.responses.push(
      () => FakeChatGpt.text("done"),
      () => FakeChatGpt.text(JSON.stringify({ findings: [FINDING] })),
      () => FakeChatGpt.text("checked"),
      () => FakeChatGpt.text(JSON.stringify(verdict)),
    );

    const result = await review(home);
    const printed = JSON.parse(result.out);

    expect(result.code).toBe(ExitCode.OK);
    expect(printed.usage.map((entry: { provider: string }) => entry.provider)).toEqual(["chatgpt", "chatgpt"]);
    expect(printed.findings).toHaveLength(1);
    expect(leaks(result.out + result.err)).toEqual([]);
  });
});
