# Contributing to ITFFTP

Thank you for helping maintain ITFFTP. This fork is maintained by Stephen Stern under ITFinesse and preserves attribution to the upstream SFTP and StackerFTP projects.

## Development setup

Prerequisites:

- Node.js 18 or newer
- npm 9 or newer
- VS Code 1.75 or newer

```powershell
git clone https://github.com/ITFinesse/ITFFTP.git
cd ITFFTP
npm install
code .
```

Press `F5` to launch an Extension Development Host.

## Project areas

- `src/core/`: configuration, connection lifecycle, FTP/SFTP clients, transfers, watcher, and hopping.
- `src/providers/`: Remote Explorer, Connections, Settings dashboard, documents, comparisons, and transfer queue.
- `src/commands/`: command registration and context actions.
- `src/webmaster/`: permissions, checksums, search, backup, cache, and replace tools.
- `resources/`: webview assets, icons, and local Codicons.
- `schema/`: `.vscode/sftp.json` validation schema.

## Checks before a commit

```powershell
npm run compile
npm test -- --run
npm run bundle
npm run package
```

For connection or WebView changes, also verify:

- ITFFTP activates without extension-host errors.
- **ITFFTP: Open Settings** opens the native VS Code dashboard.
- Dashboard profile validation and save/reset work.
- SFTP, FTP, and FTPS failures reach a bounded error state.
- The Output channel contains activation and connection diagnostics.
- The basic Connections side panel does not receive credentials.
- Explorer, editor, and Source Control ITFFTP context actions remain grouped at the bottom.

## Feature and security expectations

- Keep the historical `stackerftp.*` command and configuration identifiers unless a migration is documented.
- Treat credentials, private keys, remote paths, and server responses as untrusted or sensitive.
- Do not log passwords, passphrases, private keys, or raw credential-bearing configuration.
- Keep connection timeouts bounded and ensure every progress indicator has a completion or failure path.
- Preserve safe path validation and system-path deletion guards.
- Prefer focused changes and add a regression test when behavior is not covered by the existing suite.

## Upstream and fork contributions

When adapting work from the original SFTP lineage or StackerFTP:

1. Preserve the original authors and project attribution.
2. Explain the source and license of materially copied code or assets.
3. Separate upstream-compatible fixes from ITFFTP-specific dashboard, branding, or workflow changes.
4. Update `README.md` and `CHANGELOG.md` when a user-visible feature or behavior changes.

## Pull requests

Use a focused branch and a concise conventional commit message:

```powershell
git checkout -b agent/short-description
git add path/to/changed/files
git commit -m "fix: describe the behavior change"
git push -u origin agent/short-description
```

Pull requests should describe the user impact, root cause, files changed, checks run, and any runtime or authenticated-server coverage that remains outstanding.

## Code style and manual testing

- Keep TypeScript strictness enabled, follow the existing formatting, and keep functions focused.
- Add JSDoc for public APIs and use meaningful names for connection, transfer, and WebView state.
- Before a release, manually cover password and private-key SFTP, FTP, FTPS, transfers, sync, delete/create/rename, WebMaster tools, dashboard save/reset, timeout handling, and the bottom context-menu placement.

## Reporting issues

Include the VS Code/editor and ITFFTP versions, operating system, server protocol, reproduction steps, expected and actual behavior, and relevant Output-channel messages. Do not include passwords, private keys, passphrases, or credential-bearing configuration.

Feature requests should explain the use case, proposed behavior, alternatives considered, and any compatibility impact.

## Code of conduct

Be respectful, inclusive, and constructive. Welcome newcomers and focus discussions on improving the project.

## Questions

Open an issue or discussion for project questions and include enough context for the behavior to be reproduced safely.

## License

By contributing, you agree that your contribution is provided under the repository's MIT License. See [LICENSE](LICENSE).
