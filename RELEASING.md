# Releasing

Kerpeten is published to npm as four packages with one version:

- `kerpeten`: the launcher. It is the package people install.
- `@kerpetensh/kerpeten-linux-x64`, `@kerpetensh/kerpeten-linux-arm64`, `@kerpetensh/kerpeten-darwin-arm64`: one binary each. `kerpeten` lists them as optional dependencies, pinned to its own version, and npm installs the one that fits the machine.

The version is the `version` in `package.json`. That file stays `private`; the published manifests are generated into `dist/npm/`.

Nobody writes the version by hand. [Changesets](https://changesets.dev) raises it from the changeset files that pull requests add, and the `release` workflow publishes it.

## A release

1. **Pull requests add changesets.** A pull request that changes what a user gets adds a file under `.changeset/` that says `patch`, `minor` or `major` and describes the change in a sentence or two. [.changeset/README.md](.changeset/README.md) shows the file.
2. **The version pull request opens by itself.** After every merge to `master`, the `release` workflow looks for changeset files. When there are some, it opens a pull request named `chore: version packages`, or updates the open one. That pull request raises the `version` in `package.json` by the largest bump among the files, moves their texts into `CHANGELOG.md` and removes the files.
3. **Merging it releases.** Merge the version pull request when the version should go out. The `release` workflow then runs the same jobs as every pull request: the checks, the four tarballs, and an install of those tarballs with npm on Linux x64, Linux arm64 and macOS arm64. It publishes the same tarballs, the platform packages first. Then it waits until npm shows each platform package, and only then publishes `kerpeten`, so that an install of the new `kerpeten` always finds its binary. Last it creates the GitHub release `v<version>` with the section of `CHANGELOG.md` as its text.

Good to know:

- The workflow publishes whenever the version in `package.json` is not on npm yet. A package version that is already on npm is skipped, so a failed run can be started again, and a merge without a new version publishes nothing.
- The version pull request is opened by GitHub Actions, and GitHub starts no checks on such a pull request. The checks run on `master` right after the merge, before anything is published.
- npm shows a new version some minutes after it is published; a platform package of about 50 MB took nine minutes for 0.3.0. The workflow waits up to 30 minutes for the platform packages. When one is still missing then, the run fails and `kerpeten` is not published: start the run again later, and it publishes only what is missing.
- The README badge of the version reads npm, so it follows by itself.

## Trusted publishing

The workflow has no npm token. It publishes through npm trusted publishing, which works only for a package that already exists on npm and names this repository and `release.yml` as its trusted publisher. All four packages exist since 0.1.0, which was published by hand.

On npmjs.com, open the settings of each of the four packages and add a trusted publisher: GitHub Actions, organization `KerpetenSH`, repository `kerpeten`, workflow `release.yml`. Do this shortly before a release: npm drops a new trusted publisher that has not published within 2 days.

## By hand, when the workflow cannot publish

Publish the tarballs that the workflow built and ran on all three platforms, not ones built on your machine.

1. Find the `release` run of the commit to release on `master` and download its tarballs:

   ```sh
   gh run list --workflow release --branch master --limit 1
   gh run download <run-id> --name npm-tarballs --dir tarballs
   ```

2. Sign in: `npm login`.
3. Publish the platform packages:

   ```sh
   cd tarballs
   for tarball in kerpetensh-kerpeten-*.tgz; do npm publish "$tarball" --access public; done
   ```

4. Wait until npm shows all three, which can take some minutes. With the new version in the place of `<version>`, each of these prints the version when npm shows it:

   ```sh
   npm view @kerpetensh/kerpeten-linux-x64@<version> version --prefer-online
   npm view @kerpetensh/kerpeten-linux-arm64@<version> version --prefer-online
   npm view @kerpetensh/kerpeten-darwin-arm64@<version> version --prefer-online
   ```

5. Then publish the main package:

   ```sh
   npm publish kerpeten-*.tgz --access public
   ```
