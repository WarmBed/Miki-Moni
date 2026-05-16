import type { MsgSubmit, MsgSubmitAck } from "./protocol.js";
import { buildFocusAndEnterPS } from "./foreground-ps.js";

export interface SubmitterDeps {
  /**
   * Reveal the matching Claude panel (without prompt prefill — see comment in
   * submit() for why). In production:
   *   vscode.commands.executeCommand("claude-vscode.primaryEditor.open", session, undefined)
   */
  revealClaudePanel: (sessionUuid: string) => Promise<unknown>;
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

  // 1. Reveal the Claude panel for this session. We deliberately do NOT pass the
  //    prompt because `claude-vscode.primaryEditor.open` IGNORES the prompt
  //    arg when the session already exists in its sessionPanels map and pops
  //    up a noisy "Session is already open. Your prompt was not applied —
  //    enter it manually." notification. That breaks the 2nd send to any
  //    session. We carry the prompt via clipboard paste in step 4 instead.
  try {
    await deps.revealClaudePanel(req.session_uuid);
  } catch (err) {
    return reply(false, { error: `claude-vscode.primaryEditor.open failed: ${String(err)}` });
  }

  // 2. Give the panel time to fully render + accept keyboard focus.
  await deps.sleep(deps.prefillDelayMs);

  // 3. Focus the panel input box (idempotent if already focused).
  try {
    await deps.executeCommand("claude-vscode.focus");
  } catch (err) {
    return reply(false, { error: `claude-vscode.focus failed: ${String(err)}` });
  }

  // 4. Bring VSCode to OS foreground + clipboard-paste prompt + SendKeys ENTER.
  //    Clipboard is the only reliable way to deliver the prompt now that the
  //    URI/command-arg path is broken on re-opens (see step 1 comment).
  const script = buildFocusAndEnterPS({
    folderHint: deps.workspaceFolderName,
    prompt: req.prompt,
  });
  const psResult = await deps.spawnPS(script);
  if (!psResult.ok) {
    return reply(false, {
      error: `foreground/paste/Enter failed: ${psResult.stderr.trim() || psResult.stdout.trim()}`,
      diag: psResult.stdout,
    });
  }
  return reply(true, { diag: psResult.stdout });
}
