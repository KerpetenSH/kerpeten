import type { PlatformLineComment } from "../../../../src/capability/platform/types/platform.ts";

/** One call of the recording writer: the line comments of a merge request at a commit, or its summary comment. */
export type WriterCall =
  | {
      readonly kind: "lines";
      readonly number: number;
      readonly headSha: string;
      readonly comments: readonly PlatformLineComment[];
    }
  | { readonly kind: "summary"; readonly number: number; readonly body: string; readonly existing: string | undefined };
