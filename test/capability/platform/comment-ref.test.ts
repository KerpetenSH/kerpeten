import { describe, expect, test } from "bun:test";
import { CommentRef } from "../../../src/capability/platform/CommentRef.ts";

describe("comment ref", () => {
  test("writes the platform, the kind and the id of a comment as one text, and reads it back", () => {
    const texts = [
      "github:review_comment/2501234567",
      "github:issue_comment/77",
      "github:review/9001",
      "gitlab:note/301",
    ];

    expect([
      CommentRef.of("github", "review_comment", 2501234567).text,
      CommentRef.of("github", "issue_comment", "77").text,
      CommentRef.of("github", "review", 9001).text,
      CommentRef.of("gitlab", "note", 301).text,
    ]).toEqual(texts);

    for (const text of texts) expect(CommentRef.parse(text).text).toBe(text);

    const ref = CommentRef.parse("github:review_comment/2501234567");

    expect({ platform: ref.platform, kind: ref.kind, id: ref.id }).toEqual({
      platform: "github",
      kind: "review_comment",
      id: "2501234567",
    });
  });

  test("only a comment of the conversation of a pull request can be the summary comment", () => {
    expect(CommentRef.parse("github:issue_comment/77").inConversation).toBe(true);
    expect(CommentRef.parse("github:review_comment/77").inConversation).toBe(false);
    expect(CommentRef.parse("github:review/77").inConversation).toBe(false);
    expect(CommentRef.parse("gitlab:note/77").inConversation).toBe(false);
  });

  test("an id is digits without a leading zero, and a kind belongs to its platform", () => {
    for (const id of ["", "0", "012", "-1", "1.5", "7/../8", "7 ", "x", 0, -3, 1.5, Number.NaN]) {
      expect(() => CommentRef.of("github", "review_comment", id)).toThrow("not the id of a comment");
    }

    expect(() => CommentRef.of("github", "note", 1)).toThrow("github has no comment of the kind note");
    expect(() => CommentRef.of("gitlab", "review", 1)).toThrow("gitlab has no comment of the kind review");
  });

  test("a text that is no reference is refused: another form, another platform, a kind of the other platform, a path", () => {
    const wrong = [
      "",
      "github",
      "github:review_comment",
      "github:review_comment/",
      "github:review_comment/0",
      "github:review_comment/12x",
      "github:review_comment/12/comments",
      "github:issue_comment/77/../../pulls/1",
      "github:note/12",
      "gitlab:review_comment/12",
      "bitbucket:comment/12",
      "GitHub:review_comment/12",
      " github:review_comment/12",
      "github:review_comment/12\n",
    ];

    for (const text of wrong) expect(() => CommentRef.parse(text)).toThrow("not a comment reference");
  });

  test("a reference has 1 to 256 characters", () => {
    const longest = "9".repeat(CommentRef.MAX_LENGTH - "github:review/".length);

    expect(CommentRef.of("github", "review", longest).text.length).toBe(CommentRef.MAX_LENGTH);
    expect(CommentRef.parse(`github:review/${longest}`).id).toBe(longest);
    expect(() => CommentRef.of("github", "review", `${longest}9`)).toThrow("at most 256 characters");
    expect(() => CommentRef.parse(`github:review/${longest}9`)).toThrow("not a comment reference");
  });
});
