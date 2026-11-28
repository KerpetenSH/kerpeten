import type { CommentRefKind, PlatformKind } from "./types/platform.ts";

/**
 * The reference of a comment on its platform, as a review gives it for a written finding (`comment_ref`): the
 * platform, the kind of comment and the platform's id of it, written `<platform>:<kind>/<id>`. With the merge request
 * known it is enough to find the comment again. This class is the one place that writes and reads the form.
 *
 * - `github:review_comment/<id>`: a comment on lines of a pull request.
 * - `github:issue_comment/<id>`: a comment of the conversation of a pull request, which the summary comment is.
 * - `github:review/<id>`: the body of a review.
 * - `gitlab:note/<id>`: a note of a merge request.
 *
 * The id is digits without a leading zero, and the whole text is 1 to `MAX_LENGTH` characters. Anything else is no
 * reference: `parse` and `of` throw a `RangeError` for it.
 */
export class CommentRef {
  public static readonly MAX_LENGTH = 256;

  private static readonly FORM = /^([a-z]+):([a-z_]+)\/([1-9][0-9]*)$/;

  private static readonly ID = /^[1-9][0-9]*$/;

  private static readonly PLATFORMS: readonly PlatformKind[] = ["github", "gitlab"];

  private static readonly KINDS: Readonly<Record<PlatformKind, readonly CommentRefKind[]>> = {
    github: ["review_comment", "issue_comment", "review"],
    gitlab: ["note"],
  };

  private static readonly SHOWN_CHARS = 80;

  public readonly platform: PlatformKind;
  public readonly kind: CommentRefKind;
  public readonly id: string;

  private constructor(platform: PlatformKind, kind: CommentRefKind, id: string) {
    this.platform = platform;
    this.kind = kind;
    this.id = id;
  }

  /** The reference of the comment `id` of `kind` on `platform`. */
  public static of(platform: PlatformKind, kind: CommentRefKind, id: string | number): CommentRef {
    const digits = String(id);

    if (!CommentRef.ID.test(digits)) throw new RangeError(`not the id of a comment: ${CommentRef.shown(digits)}`);

    if (!CommentRef.KINDS[platform].includes(kind)) {
      throw new RangeError(`${platform} has no comment of the kind ${kind}`);
    }

    const ref = new CommentRef(platform, kind, digits);

    if (ref.text.length > CommentRef.MAX_LENGTH) {
      throw new RangeError(`a comment reference has at most ${CommentRef.MAX_LENGTH} characters`);
    }

    return ref;
  }

  /** The reference that `text` is. */
  public static parse(text: string): CommentRef {
    const match = text.length > CommentRef.MAX_LENGTH ? null : CommentRef.FORM.exec(text);
    const [, platform = "", kind = "", id = ""] = match ?? [];
    const known = CommentRef.PLATFORMS.find((candidate) => candidate === platform);
    const found = known === undefined ? undefined : CommentRef.KINDS[known].find((candidate) => candidate === kind);

    if (known === undefined || found === undefined) {
      throw new RangeError(`not a comment reference: ${CommentRef.shown(text)}`);
    }

    return new CommentRef(known, found, id);
  }

  private static shown(text: string): string {
    return JSON.stringify(text.slice(0, CommentRef.SHOWN_CHARS));
  }

  /** The reference as text: `<platform>:<kind>/<id>`. */
  public get text(): string {
    return `${this.platform}:${this.kind}/${this.id}`;
  }

  /**
   * Whether the comment is one of the conversation of a pull request, the only kind the summary comment of a review
   * is written as. A review body or a line comment that ends with the summary's marker is somebody's copy of it.
   */
  public get inConversation(): boolean {
    return this.kind === "issue_comment";
  }
}
