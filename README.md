# ITFinesse FTP

ITFinesse FTP is a VS Code extension for FTP, FTPS, and SFTP connections, remote file browsing, transfers, synchronization, and webmaster utilities.

## Getting started

1. Open a folder in VS Code.
2. Run **ITFinesse FTP: Open Settings**.
3. Add one connection object or an array of connection objects under **Connection profiles**.
4. Save the dashboard and use the **Connections** side panel to connect or disconnect.

Connection profiles are stored in `.vscode/sftp.json`. The Settings dashboard also manages all `stackerftp.*` workspace preferences. Existing command and configuration identifiers retain the `stackerftp` prefix for compatibility with earlier installs.

## Diagnostics

Run **ITFinesse FTP: Show Output** to open the extension output channel. Connection attempts report a visible lifecycle state and terminate with an error when their configured timeout expires.

## Security

Passwords and key passphrases placed in connection profiles are stored in the workspace configuration file. Prefer private keys and avoid committing credentials.

## Attribution

This ITFinesse fork is maintained by Stephen Stern and derives from the original [StackerFTP project](https://github.com/yasinkuyu/StackerFTP). It remains licensed under the MIT License.
