---
"kerpeten": minor
---

`kerpeten review --mr <n>` without `--dry-run` now writes its comments to the GitHub pull request, from the account `gh` is signed in with: a comment on the lines of each finding that earns one and one summary comment, which a later run updates. The output shows a `comment_ref` for every written finding, and the command ends with 1 when a comment could not be written.
