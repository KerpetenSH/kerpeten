import { PlatformChoice } from "../../../src/capability/platform/PlatformChoice.ts";
import type {
  MergeRequest,
  Platform,
  PlatformComments,
  PlatformKind,
  PlatformWriter,
} from "../../../src/capability/platform/types/platform.ts";

/**
 * A platform choice that is GitHub with the writer it was given, or a platform without a writer when it was given
 * none. Its platform reads one merge request, the one it was given as `current`, or fails with the error it was given
 * in its place; `reads` counts those reads.
 */
export class GivenPlatformChoice extends PlatformChoice implements Platform {
  public reads = 0;

  private readonly given: PlatformWriter | undefined;
  private readonly current: MergeRequest | Error | undefined;

  public constructor(given?: PlatformWriter, current?: MergeRequest | Error) {
    super();
    this.given = given;
    this.current = current;
  }

  public override async kind(): Promise<PlatformKind> {
    return this.given === undefined ? "gitlab" : "github";
  }

  public override async writer(): Promise<PlatformWriter | undefined> {
    return this.given;
  }

  public override async platform(): Promise<Platform> {
    return this;
  }

  public async mergeRequest(number: number): Promise<MergeRequest> {
    this.reads++;

    if (this.current === undefined) throw new Error(`no merge request ${number} was given`);

    if (this.current instanceof Error) throw this.current;

    return this.current;
  }

  public async comments(number: number): Promise<PlatformComments> {
    throw new Error(`the comments of merge request ${number} are not read here`);
  }
}
