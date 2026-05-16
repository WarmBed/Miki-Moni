import type { MsgSubmit, MsgSubmitAck } from "./protocol.js";
import { buildFocusAndEnterPS } from "./foreground-ps.js";

export interface SubmitterDeps {
  openExternal: (uri: string) => Promise<boolean>;
  executeCommand: (cmd: string, ...args: unknown[]) => Promise<unknown>;
  spawnPS: (script: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  sleep: (ms: number) => Promise<void>;
  prefillDelayMs: number;
  workspaceFolderName: string;
}

export async function submit(
  req: Pick<MsgSubmit, "request_id" | "session_uuid" | "prompt">,
  deps: SubmitterDeps,
): Promise<MsgSubmitAck> {
  const reply = (ok: boolean, extra: { error?: string; diag?: string } = {}): MsgSubmitAck => ({
    type: "submit_ack",
    request_id: req.request_id,
    ok,
    ...(extra.error !== undefined ? { error: extra.error } : {}),
    ...(extra.diag !== undefined ? { diag: extra.diag } : {}),
  });

  // 1. Fire URI via VSCode's openExternal — prefills the Claude panel input box.
  const uri =
    `vscode://anthropic.claude-code/open?session=${encodeURIComponent(req.session_uuid)}` +
    `&prompt=${encodeURIComponent(req.prompt)}`;
  let opened: boolean;
  try {
    opened = await deps.openExternal(uri);
  } catch (err) {
    return reply(false, { error: `URI dispatch threw: ${String(err)}` });
  }
  if (!opened) return reply(false, { error: "URI dispatch refused by OS shell handler" });

  // 2. Wait for prefill to settle inside Claude panel.
  await deps.sleep(deps.prefillDelayMs);

  // 3. Focus the Claude panel input box via claude-code's exposed command.
  try {
    await deps.executeCommand("claude-vscode.focus");
  } catch (err) {
    return reply(false, { error: `claude-vscode.focus failed: ${String(err)}` });
  }

  // 4. Bring VSCode to OS foreground + SendKeys ENTER via PowerShell.
  const script = buildFocusAndEnterPS({ folderHint: deps.workspaceFolderName });
  const psResult = await deps.spawnPS(script);
  if (!psResult.ok) {
    return reply(false, {
      error: `foreground/SendKeys failed: ${psResult.stderr.trim() || psResult.stdout.trim()}`,
      diag: psResult.stdout,
    });
  }
  return reply(true, { diag: psResult.stdout });
}
