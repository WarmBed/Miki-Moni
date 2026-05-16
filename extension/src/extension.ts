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
      vscode.commands.registerCommand("cc-hub-helper.showStatus", () =>
        vscode.window.showInformationMessage("cc-hub helper: no workspace folder open, not registered with daemon"),
      ),
    );
    return;
  }

  const cfg = vscode.workspace.getConfiguration("cc-hub-helper");
  const daemonUrl = cfg.get<string>("daemonUrl", "ws://127.0.0.1:8765/ws_ext");
  const prefillDelayMs = cfg.get<number>("prefillDelayMs", 500);

  const workspaceRoot = normalizePath(folder.uri.fsPath);
  const workspaceFolderName = path.basename(folder.uri.fsPath);
  const version = context.extension.packageJSON.version as string;

  const submitterDeps: SubmitterDeps = {
    openExternal: async (uri) => Boolean(await vscode.env.openExternal(vscode.Uri.parse(uri))),
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
    log: (msg, ctx) => console.log(`[cc-hub-helper] ${msg}`, ctx ?? ""),
  });
  client.start();

  context.subscriptions.push(
    vscode.commands.registerCommand("cc-hub-helper.showStatus", () =>
      vscode.window.showInformationMessage(
        `cc-hub helper v${version}, workspace=${workspaceRoot}, daemon=${daemonUrl}`,
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
