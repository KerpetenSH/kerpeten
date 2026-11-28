import type { ChatGptPlan } from "../../../capability/chatgpt/ChatGptPlan.ts";
import type { KerpetenConfig } from "../../../capability/config/types/config.ts";
import type { MergeRequestState, PlatformKind } from "../../../capability/platform/types/platform.ts";
import type { ProviderLlm, UsageEntry } from "../../../harnesses/types/harnesses.ts";
import type { PlannedFinding } from "../../../layer/comment/types/comment.ts";

/** What the `review` command line asks for: the input of the review command workflow. */
export interface ReviewFlags {
  readonly dryRun: boolean;
  readonly full: boolean;
  readonly base?: string;
  readonly mr?: number;
  readonly contextFile?: string;
  readonly extraContext?: string;
  readonly group: string;
  readonly json: boolean;
}

/** The merge request of a review in the JSON output: whose review of what it is. */
export interface MergeRequestJson {
  readonly tenant: string;
  readonly platform: { readonly kind: PlatformKind; readonly host: string };
  readonly project: { readonly id: string };
  readonly mr: number;
  readonly title: string;
  readonly state: MergeRequestState;
  readonly head_sha: string;
  readonly base_sha: string;
}

/**
 * A line comment of the comment plan in the JSON output: where it would be written, and its whole text. A comment
 * that was written has its ref as `comment_ref`.
 */
export interface LineCommentJson {
  readonly file: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly body: string;
  readonly comment_ref?: string;
}

/** The summary comment of the comment plan in the JSON output: its whole text, and its ref as `comment_ref` when it was written. */
export interface SummaryCommentJson {
  readonly body: string;
  readonly comment_ref?: string;
}

/**
 * The comment plan in the JSON output: what a posted review would write to the merge request. For a review that
 * wrote its comments it is what was written: the line comments are the written ones.
 */
export interface CommentPlanJson {
  readonly line_comments: readonly LineCommentJson[];
  readonly summary: SummaryCommentJson;
}

export interface ReviewJson {
  readonly merge_request?: MergeRequestJson;
  readonly findings: readonly PlannedFinding[];
  readonly comment_plan?: CommentPlanJson;
  readonly usage: readonly UsageEntry[];
}

/** A review that is ready to run: its repository, its configuration and both model clients. */
export interface PreparedReview {
  readonly repo: string;
  readonly config: KerpetenConfig;
  readonly configHash: string;
  readonly reviewerClient: ProviderLlm;
  readonly judgeClient: ProviderLlm;
  readonly plan: ChatGptPlan | undefined;
  readonly pathEnv: string;
}

export type ReviewPreparation =
  | { readonly ok: true; readonly review: PreparedReview }
  | { readonly ok: false; readonly problems: readonly string[] };
