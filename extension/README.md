# miki-helper

Companion VSCode extension for [miki-moni](../). Runs inside the VSCode extension host, opens a WebSocket to the miki-moni daemon, and dispatches `/send` requests from the dashboard to the matching Claude panel session.

## Why

The miki-moni daemon, running outside VSCode, can fire `vscode://anthropic.claude-code/open?session=…&prompt=…` URIs to prefill prompts in a Claude panel. But it cannot reliably submit them — `SendKeys ENTER` from a PowerShell child process either lands in the wrong control or never reaches the panel webview. This extension runs *inside* VSCode, where it can call `claude-vscode.focus` (an internal command) and submit via a controlled flow.

## Install

From the miki-moni repo root:

```sh
npm run install-helper
```

This packages the extension into a VSIX and installs it via `code --install-extension`. Restart each VSCode window you want the helper to run in.

## Verify

1. Open dashboard at `http://127.0.0.1:8765/`
2. Pick any session whose workspace folder is open in one of your VSCode windows
3. Type a distinctive prompt (e.g. "smoke-test-2026") in the inline input box
4. Click 送出
5. Verify the prompt appears as a new user message in that VSCode's Claude panel session

If it fails:
- Dashboard inline feedback shows the daemon's error / extension's diag
- `~/.miki-moni/miki-moni.log` has full structured logs
- `Help → Toggle Developer Tools → Console` in VSCode shows extension's console.log

## Uninstall

```sh
code --uninstall-extension miki-moni.miki-helper
```

## Settings

- `miki-helper.daemonUrl` — default `ws://127.0.0.1:8765/ws_ext`
- `miki-helper.prefillDelayMs` — default `500` (ms to wait between URI fire and Enter)

## Development

```sh
cd extension
npm install
npm test                    # vitest unit tests
npm run compile             # tsc → dist/
npm run package             # vsce → .vsix
```

To deploy your changes, run `npm run install-helper` from the miki-moni root and restart VSCode.
