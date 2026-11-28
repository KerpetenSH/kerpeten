import type { CommentWordSet } from "./types/comment.ts";

/**
 * The fixed texts of a comment, in English and in Turkish. The comment language `tr`, with or without a region, gets
 * the Turkish texts; every other language gets the English ones. The texts a model wrote are in the comment language
 * already.
 */
export class CommentWords {
  public static readonly ENGLISH: CommentWordSet = {
    heading: "## Kerpeten review",
    fix: "**Fix:**",
    thumbsDown: "👎 If you do not want this finding again, react with 👎; you can reply with the reason.",
    nothing: "The review found nothing to report.",
    untitled: "(no title)",
    cut: "_This text was cut: it is too long for one comment._",
    reviewed: (commit, lineComments, alreadyWritten) =>
      `Reviewed commit ${commit}. Line comments in this run: ${lineComments}.${
        alreadyWritten > 0 ? ` Findings that already had a line comment: ${alreadyWritten}.` : ""
      }`,
    unwritten: (count) =>
      `Findings whose comment may be missing here, because writing it failed: ${count}. The output of the review run lists them.`,
    unjudged: (count) =>
      `Findings that could not be checked, so they are not written here: ${count}. The output of the review run lists them.`,
    partial: (reason) => `**Partial review:** the review stopped early (${reason}), so it may have missed findings.`,
    omitted: (count) => `Findings not shown here, because the comment would be too long: ${count}.`,
  };

  public static readonly TURKISH: CommentWordSet = {
    heading: "## Kerpeten incelemesi",
    fix: "**Düzeltme:**",
    thumbsDown: "👎 Bu bulgu tekrar gelmesin istiyorsan 👎 bas; nedenini cevap olarak yazabilirsin.",
    nothing: "İnceleme bildirilecek bir şey bulmadı.",
    untitled: "(başlıksız)",
    cut: "_Bu metin kesildi: tek bir yorum için çok uzun._",
    reviewed: (commit, lineComments, alreadyWritten) =>
      `İncelenen commit: ${commit}. Bu çalıştırmadaki satır yorumları: ${lineComments}.${
        alreadyWritten > 0 ? ` Satır yorumu zaten olan bulgular: ${alreadyWritten}.` : ""
      }`,
    unwritten: (count) =>
      `Yazılması başarısız olduğu için yorumu burada eksik olabilecek bulgular: ${count}. İnceleme çalıştırmasının çıktısında listelenir.`,
    unjudged: (count) =>
      `Doğrulanamadığı için buraya yazılmayan bulgular: ${count}. İnceleme çalıştırmasının çıktısında listelenir.`,
    partial: (reason) => `**Kısmi inceleme:** inceleme erken durdu (${reason}); gözden kaçan bulgular olabilir.`,
    omitted: (count) => `Yorum çok uzun olacağı için burada gösterilmeyen bulgular: ${count}.`,
  };

  private static readonly TURKISH_TAG = /^tr(-|$)/;

  public static of(language: string): CommentWordSet {
    return CommentWords.TURKISH_TAG.test(language) ? CommentWords.TURKISH : CommentWords.ENGLISH;
  }
}
