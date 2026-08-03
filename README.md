# ITFFTP

ITFFTP is a VS Code FTP, FTPS, and SFTP client maintained by Stephen Stern under ITFinesse. It runs in Visual Studio Code and compatible VS Code-based editors.

This repository preserves the feature set developed through the original SFTP project lineage, the StackerFTP project, and this ITFinesse fork.

This release is **ITFFTP 2.0.0**, the ITFinesse-branded major release containing the dashboard, connection reliability, packaging, and menu-placement refactors described in [CHANGELOG.md](CHANGELOG.md).

## What ITFFTP provides

### Connection dashboard

- Native VS Code Settings webview dashboard for connection profiles and every ITFFTP workspace preference.
- Connection profiles stored in `.vscode/sftp.json`, with JSON validation before saving.
- SFTP, FTP, and FTPS connections, password or private-key authentication, custom ports, remote paths, passive mode, and TLS options.
- Multiple simultaneous connections, primary-connection selection, profiles, and connection hopping through SSH jump hosts.
- Basic Connections side panel for connect, disconnect, refresh, and current lifecycle status.
- Explicit `connecting`, `connected`, `disconnected`, and `error` states, bounded connection timeouts, and output-channel diagnostics.
- Auto-connect and auto-reconnect controls, including protection against retry loops after an initial connection failure.

### Remote file management

- Upload, download, delete, rename, duplicate, create, and open remote files and folders.
- Recursive directory transfers with parent-directory creation.
- Remote file metadata, permissions, modification dates, hidden-file visibility, and native file icons.
- Edit a remote text file locally with upload-on-save support.
- Remote-to-remote copy, remote comparisons, revision listing, and local/remote reveal actions.
- Safe handling for system paths, traversal attempts, binary files, and multi-selection operations.

### Synchronization and transfers

- Local-to-remote, remote-to-local, and bidirectional synchronization.
- Upload to all configured profiles and upload only files changed in Git.
- Project upload/download commands and transfer queue management.
- Retry, cancel, clear, and inspect transfer items with progress indicators and stall recovery.
- Configurable transfer concurrency and serialized FTP operations for reliable client state.

### WebMaster tools

- Change remote permissions with `chmod`.
- Calculate and compare MD5, SHA1, SHA256, and other supported checksums.
- Inspect remote file information and search remote content.
- Create timestamped backups and purge common remote caches.
- Compare local and remote folders in a split-view panel.
- Quick remote search with wildcard patterns, parallel traversal, path changes, and result actions.
- Find and replace text across remote files.
- Open an SSH terminal for SFTP connections.

### Development and integration features

- Git and Source Control integration for changed-file uploads.
- File watcher with configured auto-upload and auto-delete behavior.
- Remote document viewing with binary-file safeguards and optional download-on-open.
- Native Remote Explorer tree plus the legacy WebView explorer surface.
- Structured ITFFTP output logging and clickable status/progress indicators.
- Right-click ITFFTP actions grouped together at the bottom of Explorer, editor, and Source Control menus.

## Quick start

1. Open a workspace folder.
2. Run **ITFFTP: Open Settings** from the Command Palette or the Connections view title bar.
3. Add one connection object or an array of objects under **Connection profiles**.
4. Save the dashboard, then connect from the basic Connections side panel or **ITFFTP: Quick Connect**.
5. Open **ITFFTP: Show Output** if a server rejects a connection or a transfer needs diagnosis.

Example profile (replace values; do not commit real credentials):

```json
{
  "name": "Production",
  "host": "server.example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "remotePath": "/var/www/html",
  "uploadOnSave": false
}
```

FTP and FTPS use the same profile shape with `"protocol": "ftp"` or `"protocol": "ftps"` and the appropriate port/security settings. Profiles may also contain `profiles`, `defaultProfile`, `watcher`, `ignore`, `syncMode`, `connTimeout`, and `keepalive` options documented by `schema/sftp.schema.json`.

## Dashboard settings

The dashboard owns auto-connect, auto-reconnect, refresh behavior, hidden files, delete/sync confirmations, WebMaster visibility, file watching, syntax highlighting, native-tree selection, download-on-open, transfer concurrency, explorer sorting, reusable named remotes, and connection profile JSON. The native VS Code configuration namespace remains available for compatibility, but the dashboard is the supported editing surface.

## Installation

### From a VSIX

1. Open Extensions in VS Code (`Ctrl+Shift+X`).
2. Select **… → Install from VSIX…**.
3. Choose the ITFFTP `.vsix` package.
4. Reload the window if VS Code requests it.

### From a marketplace

Search for **ITFFTP**. The extension identity is `ITFinesse.stackerftp`; the historical `stackerftp` command/configuration prefix is intentionally retained for workspace compatibility.

## Reliability and security fixes in this fork

- Bundled runtime dependencies into the extension so activation cannot fail because `ssh2`, `basic-ftp`, or MIME support is absent from the VSIX.
- Added a portable local Codicon asset instead of depending on an unbundled `node_modules` directory.
- Added bounded connection promises, lifecycle state reporting, unique progress identifiers, error propagation, and output logging at activation and connection start.
- Prevented an unsuccessful initial connection cleanup from triggering automatic reconnect storms.
- Kept credentials out of the basic Connections side-panel payload.
- Preserved safe remote-path checks, atomic configuration behavior, transfer queue recovery, and FTP serialization from the existing codebase.

## Development

```powershell
npm install
npm run compile
npm test -- --run
npm run bundle
npm run package
```

Press `F5` to launch an Extension Development Host. Test at least one SFTP, FTP, and FTPS profile, dashboard save/reset, connect timeout, reconnect behavior, upload/download, synchronization, WebMaster action, and right-click menu placement before publishing.

## Lineage and attribution

ITFFTP is an independent ITFinesse fork maintained by Stephen Stern. It acknowledges and builds upon the SFTP client lineage from the original liximomo SFTP plugin, the Natizyskunk `vscode-sftp` project, and the yasinkuyu StackerFTP project. Changes in this repository include continued maintenance, reliability fixes, multi-connection and transfer work, WebMaster tooling, dashboard settings, and the refactors documented in [CHANGELOG.md](CHANGELOG.md).

Contributions should preserve upstream attribution and clearly describe whether a change belongs to the original SFTP lineage, StackerFTP, or ITFFTP-specific behavior. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review workflow.

## License

MIT License. See [LICENSE](LICENSE).
