import * as vscode from "vscode";
import * as path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

import { WsClient } from "./ws-client.js";
import { submit, type SubmitterDeps } from "./submitter.js";
import { normalizePath } from "./protocol.js";

let client: WsClient | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    // No workspace open — extension still loads (for showStatus command) but does NOT register.
    context.subscriptions.push(
      vscode.commands.registerCommand("miki-helper.showStatus", () =>
        vscode.window.showInformationMessage("miki-moni helper: no workspace folder open, not registered with daemon"),
      ),
    );
    return;
  }

  const cfg = vscode.workspace.getConfiguration("miki-helper");
  const daemonUrl = cfg.get<string>("daemonUrl", "ws://127.0.0.1:8765/ws_ext");
  // Default 1000ms — Claude panel needs time to switch tabs / clear previous
  // response state before the new prefill + Enter lands cleanly. Lower values
  // race against panel reloading and SendKeys lands on a disabled/wrong control.
  const prefillDelayMs = cfg.get<number>("prefillDelayMs", 1000);

  const workspaceRoot = normalizePath(folder.uri.fsPath);
  const workspaceFolderName = path.basename(folder.uri.fsPath);
  const version = context.extension.packageJSON.version as string;

  const submitterDeps: SubmitterDeps = {
    revealClaudePanel: (sessionUuid) =>
      Promise.resolve(vscode.commands.executeCommand("claude-vscode.primaryEditor.open", sessionUuid, undefined)),
    executeCommand: (cmd, ...args) => Promise.resolve(vscode.commands.executeCommand(cmd, ...args)),
    spawnPS: defaultSpawnPS,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    prefillDelayMs,
    workspaceFolderName,
  };

  client = new WsClient({
    url: daemonUrl,
    registerInfo: () => ({ workspace_root: workspaceRoot, helper_version: version }),
    onSubmit: (req) => submit(req, submitterDeps),
    WebSocketCtor: WebSocket as any,
    log: (msg, ctx) => console.log(`[miki-helper] ${msg}`, ctx ?? ""),
  });
  client.start();

  context.subscriptions.push(
    vscode.commands.registerCommand("miki-helper.showStatus", () =>
      vscode.window.showInformationMessage(
        `miki-moni helper v${version}, workspace=${workspaceRoot}, daemon=${daemonUrl}`,
      ),
    ),
    { dispose: () => client?.stop() },
  );
}

export function deactivate(): void {
  client?.stop();
  client = null;
}

function defaultSpawnPS(script: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", script], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => { stdout += c.toString(); });
    child.stderr?.on("data", (c) => { stderr += c.toString(); });
    child.on("exit", (code) => resolve({ ok: code === 0, stdout, stderr }));
    child.on("error", (err) => resolve({ ok: false, stdout, stderr: String(err) }));
  });
}
