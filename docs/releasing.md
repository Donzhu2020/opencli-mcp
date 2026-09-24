# Releasing opencli-mcp

The npm package and Chrome extension have separate versions. This workflow releases the npm package only. Update the Chrome Web Store extension separately when extension code changes.

## One-time npm setup

In the [opencli-mcp npm package settings](https://www.npmjs.com/package/opencli-mcp), add a **Trusted Publisher** for GitHub Actions:

- GitHub owner: `jackwener`
- Repository: `opencli-mcp`
- Workflow filename: `release.yml`
- Environment: leave blank

The workflow uses GitHub OIDC to publish to npm. It does not need an `NPM_TOKEN` secret. GitHub Actions must be enabled for this repository.

## Each release

1. Commit and push the changes you want to release to `main`.
2. Open [Actions → Release npm package](https://github.com/jackwener/opencli-mcp/actions/workflows/release.yml), choose **Run workflow** on `main`, and enter an unused version such as `0.0.19`.
3. Optionally enter release notes. If omitted, the workflow uses commit subjects since the previous tag. An existing `CHANGELOG.md` section for that version takes precedence.

The workflow updates `package.json`, `package-lock.json`, and `CHANGELOG.md`, runs a small set of checks, builds and installs the tarball, commits the release version, pushes its tag, publishes to npm with provenance, creates a GitHub Release with the tarball, and waits for npm to expose the version. Re-run the same version if publication or release creation fails after the tag was pushed; it checks the existing tag and package instead of bumping again.

Do not use this workflow to publish an unpacked Chrome extension. The extension manifest version is independent of the npm package version.
