# cc-hub-helper VSCode Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a companion VSCode extension `cc-hub-helper` that runs inside the extension host, opens a WebSocket to the cc-hub daemon, and reliably submits prompts to the right Claude panel session — replacing the proven-broken pure-PowerShell SendKeys path.

**Architecture:** Daemon already runs an HTTP+WS server on `127.0.0.1:8765` (existing `/ws` for dashboard). We add a second WebSocket path `/ws_ext` that each VSCode-with-helper-installed connects to. Extension registers its workspace folder on connect; daemon routes `/send` requests to the right extension via longest-prefix workspace match; extension internally fires `vscode://anthropic.claude-code/open?session=…&prompt=…`, calls `claude-vscode.focus` command, then spawns the existing Win32 PowerShell script (URI step removed) to bring VSCode to foreground + SendKeys ENTER.

**Tech Stack:** TypeScript, Node.js, `ws` (WebSocket), `vscode` extension API, `vsce` (packaging), Vitest (testing). Windows-only (matches existing daemon scope).

---

## File Structure

### New — extension package (separate npm package at `cc-hub/extension/`)
- `extension/package.json` — VSCode manifest + npm scripts (build/package/test)
- `extension/tsconfig.json` — TS config compiling to CommonJS for VSCode runtime
- `extension/vitest.config.ts` — vitest config aliasing `vscode` → mock module
- `extension/.vscodeignore` — exclude tests/sources from VSIX
- `extension/README.md` — install + usage + manual E2E test instructions
- `extension/src/protocol.ts` — wire-protocol TS types (mirror in daemon)
- `extension/src/foreground-ps.ts` — PS script builder (URI step removed)
- `extension/src/submitter.ts` — orchestrates URI prefill + focus + PS Enter
- `extension/src/ws-client.ts` — WS connection + reconnect backoff
- `extension/src/extension.ts` — `activate()`/`deactivate()` wires everything
- `extension/tests/vscode-mock.ts` — minimal `vscode` mock for vitest
- `extension/tests/foreground-ps.test.ts` — PS script content assertions
- `extension/tests/submitter.test.ts` — submit flow unit tests (mocked deps)
- `extension/tests/ws-client.test.ts` — WS lifecycle tests (mocked socket)

### New — daemon side
- `src/protocol-ext.ts` — wire-protocol TS types (mirror of extension's)
- `src/ext-registry.ts` — `ExtRegistry` class + longest-prefix-wins routing
- `tests/ext-registry.test.ts` — registry unit tests
- `scripts/install-helper.mjs` — packages extension + installs VSIX

### Modified
- `src/server.ts` — add `/ws_ext` WebSocketServer wired to registry; modify `/send` to route via registry → `submitViaHelper`
- `src/vscode-bridge.ts` — add `submitViaHelper(...)`; rename existing `prefillAndSubmit` → `prefillAndSubmitLegacy`
- `tests/integration.test.ts` — add `/ws_ext` registry + `/send` routing tests
- `package.json` (root) — add `install-helper` npm script
- `web/app.tsx` — show 503/504 daemon errors in dashboard inline feedback

---

## Task 1: Shared protocol types + extension scaffolding

**Files:**
- Create: `d:/code/cc-hub/extension/package.json`
- Create: `d:/code/cc-hub/extension/tsconfig.json`
- Create: `d:/code/cc-hub/extension/.vscodeignore`
- Create: `d:/code/cc-hub/extension/vitest.config.ts`
- Create: `d:/code/cc-hub/extension/tests/vscode-mock.ts`
- Create: `d:/code/cc-hub/extension/src/protocol.ts`
- Create: `d:/code/cc-hub/src/protocol-ext.ts`

- [ ] **Step 1: Create `extension/package.json`**

```json
{
  "name": "cc-hub-helper",
  "displayName": "cc-hub helper",
  "publisher": "cc-hub",
  "version": "0.1.0",
  "description": "Companion VSCode extension for cc-hub daemon — receives prompt-submit commands and dispatches them to the local Claude panel.",
  "engines": { "vscode": "^1.85.0" },
  "main": "./dist/extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "commands": [
      { "command": "cc-hub-helper.showStatus", "title": "cc-hub helper: Show status" }
    ],
    "configuration": {
      "title": "cc-hub helper",
      "properties": {
        "cc-hub-helper.daemonUrl": {
          "type": "string",
          "default": "ws://127.0.0.1:8765/ws_ext",
          "description": "WebSocket URL of the cc-hub daemon"
        },
        "cc-hub-helper.prefillDelayMs": {
          "type": "number",
          "default": 500,
          "description": "Milliseconds to wait after firing the vscode:// URI before pressing Enter"
        }
      }
    }
  },
  "scripts": {
    "compile": "tsc -p .",
    "watch": "tsc -p . --watch",
    "package": "vsce package --no-dependencies",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "@types/vscode": "^1.85.0",
    "@types/ws": "^8.5.12",
    "@vscode/vsce": "^3.0.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: Create `extension/tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "outDir": "dist",
    "lib": ["ES2022"],
    "sourceMap": true,
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "tests", "dist"]
}
```

- [ ] **Step 3: Create `extension/.vscodeignore`**

```
.vscode/**
.vscode-test/**
tests/**
src/**
**/*.map
**/*.ts
!dist/**
node_modules/**
!node_modules/ws/**
vitest.config.ts
tsconfig.json
```

- [ ] **Step 4: Create `extension/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    alias: {
      vscode: path.resolve(__dirname, "./tests/vscode-mock.ts"),
    },
  },
});
```

- [ ] **Step 5: Create `extension/tests/vscode-mock.ts`** (minimal API surface that source code may import)

```ts
// Minimal `vscode` namespace mock for vitest. Tests requiring richer behavior
// inject their own implementations via Submitter / WsClient deps interfaces;
// this file just provides type-safe symbols the imports won't crash on.
export const Uri = {
  parse: (s: string) => ({ toString: () => s, fsPath: s }),
};
export const window = {
  showInformationMessage: (_msg: string) => Promise.resolve(undefined),
};
export const workspace = {
  workspaceFolders: undefined as any,
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  }),
};
export const commands = {
  executeCommand: <T>(_cmd: string, ..._args: any[]): Thenable<T> => Promise.resolve(undefined as any),
  registerCommand: (_cmd: string, _fn: (...a: any[]) => any) => ({ dispose: () => {} }),
};
export const env = {
  openExternal: (_uri: any) => Promise.resolve(true),
};
export const extensions = {
  getExtension: (_id: string) => ({ packageJSON: { version: "0.0.0-test" } }),
};
export class Disposable {
  static from(..._d: any[]) { return new Disposable(); }
  dispose() {}
}
```

- [ ] **Step 6: Create `extension/src/protocol.ts`** (TS types for wire protocol — both sides will import the SAME shape)

```ts
// Wire protocol between cc-hub daemon (WS server at /ws_ext) and
// cc-hub-helper VSCode extension (WS client). One JSON object per WS frame.

// ── Extension → Daemon ─────────────────────────────────────────────────────
export interface MsgRegister {
  type: "register";
  workspace_root: string;   // absolute path, lowercase forward-slash on Windows
  helper_version: string;   // semver from extension's package.json
}

export interface MsgSubmitAck {
  type: "submit_ack";
  request_id: string;
  ok: boolean;
  error?: string;
  diag?: string;
}

export interface MsgPong {
  type: "pong";
  request_id: string;
}

export type ExtMessage = MsgRegister | MsgSubmitAck | MsgPong;

// ── Daemon → Extension ─────────────────────────────────────────────────────
export interface MsgSubmit {
  type: "submit";
  request_id: string;
  session_uuid: string;
  prompt: string;
}

export interface MsgPing {
  type: "ping";
  request_id: string;
}

export type DaemonMessage = MsgSubmit | MsgPing;

// ── Normalization helper ───────────────────────────────────────────────────
// Daemon and extension MUST normalize workspace/cwd paths identically for the
// longest-prefix-wins routing to work. Lower-case, forward-slash, no trailing /.
export function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/").toLowerCase();
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}
```

- [ ] **Step 7: Create `d:/code/cc-hub/src/protocol-ext.ts`** (mirror, daemon side)

```ts
// Daemon-side mirror of extension/src/protocol.ts. Kept duplicate (not a
// symlink/shared package) because the extension is a separate npm package
// with its own dist; cross-package import would complicate the VSIX build.
// Drift risk is low — types are small and stable. If they ever diverge, both
// integration test (ws_ext routing) and submitter test will fail.

export interface MsgRegister {
  type: "register";
  workspace_root: string;
  helper_version: string;
}

export interface MsgSubmitAck {
  type: "submit_ack";
  request_id: string;
  ok: boolean;
  error?: string;
  diag?: string;
}

export interface MsgPong {
  type: "pong";
  request_id: string;
}

export type ExtMessage = MsgRegister | MsgSubmitAck | MsgPong;

export interface MsgSubmit {
  type: "submit";
  request_id: string;
  session_uuid: string;
  prompt: string;
}

export interface MsgPing {
  type: "ping";
  request_id: string;
}

export type DaemonMessage = MsgSubmit | MsgPing;

export function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/").toLowerCase();
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}
```

- [ ] **Step 8: Install extension deps**

Run: `cd d:/code/cc-hub/extension && npm install`
Expected: completes without errors; `node_modules/` populated.

- [ ] **Step 9: Verify TypeScript compiles**

Run: `cd d:/code/cc-hub/extension && npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 10: Verify daemon protocol types compile**

Run: `cd d:/code/cc-hub && npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 11: Commit**

```bash
git add d:/code/cc-hub/extension/package.json d:/code/cc-hub/extension/tsconfig.json \
        d:/code/cc-hub/extension/.vscodeignore d:/code/cc-hub/extension/vitest.config.ts \
        d:/code/cc-hub/extension/tests/vscode-mock.ts d:/code/cc-hub/extension/src/protocol.ts \
        d:/code/cc-hub/src/protocol-ext.ts
git commit -m "feat(helper): scaffold extension package + shared WS protocol types"
```

---

## Task 2: ExtRegistry (daemon-side, TDD)

**Files:**
- Create: `d:/code/cc-hub/src/ext-registry.ts`
- Create: `d:/code/cc-hub/tests/ext-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `d:/code/cc-hub/tests/ext-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ExtRegistry, type ExtInfo } from "../src/ext-registry.js";

// Minimal "WebSocket" stand-in — registry doesn't call any methods on it
// during these tests, just uses it as a map key.
function fakeWs(name: string): any {
  return { _name: name };
}

const baseInfo = (root: string): ExtInfo => ({
  workspace_root: root,
  version: "0.1.0",
  registered_at: 1,
});

describe("ExtRegistry", () => {
  it("add + findForCwd returns the registered ws when cwd is the workspace itself", () => {
    const r = new ExtRegistry();
    const ws = fakeWs("a");
    r.add(ws, baseInfo("d:/code"));
    expect(r.findForCwd("d:/code")).toBe(ws);
  });

  it("findForCwd returns the registered ws when cwd is a descendant of workspace", () => {
    const r = new ExtRegistry();
    const ws = fakeWs("a");
    r.add(ws, baseInfo("d:/code"));
    expect(r.findForCwd("d:/code/cc-hub/src")).toBe(ws);
  });

  it("findForCwd returns null when no workspace covers the cwd", () => {
    const r = new ExtRegistry();
    r.add(fakeWs("a"), baseInfo("d:/code"));
    expect(r.findForCwd("d:/other/path")).toBeNull();
  });

  it("normalizes case (Windows) — uppercase cwd still matches lowercase root", () => {
    const r = new ExtRegistry();
    const ws = fakeWs("a");
    r.add(ws, baseInfo("d:/code"));
    expect(r.findForCwd("D:\\Code\\sub")).toBe(ws);
  });

  it("longest-prefix-wins when multiple workspaces match", () => {
    const r = new ExtRegistry();
    const wsBroad = fakeWs("broad");
    const wsDeep = fakeWs("deep");
    r.add(wsBroad, baseInfo("d:/code"));
    r.add(wsDeep, baseInfo("d:/code/xianyu-assistant"));
    expect(r.findForCwd("d:/code/xianyu-assistant/lib")).toBe(wsDeep);
    expect(r.findForCwd("d:/code/other-project/lib")).toBe(wsBroad);
  });

  it("remove unregisters the ws", () => {
    const r = new ExtRegistry();
    const ws = fakeWs("a");
    r.add(ws, baseInfo("d:/code"));
    r.remove(ws);
    expect(r.findForCwd("d:/code")).toBeNull();
  });

  it("list returns all registered entries", () => {
    const r = new ExtRegistry();
    r.add(fakeWs("a"), baseInfo("d:/code"));
    r.add(fakeWs("b"), baseInfo("d:/other"));
    expect(r.list()).toHaveLength(2);
    expect(r.list().map((e) => e.info.workspace_root).sort()).toEqual(["d:/code", "d:/other"]);
  });

  it("does NOT match when cwd shares a prefix but isn't a path-descendant (false-positive guard)", () => {
    // "d:/codex" must NOT match workspace "d:/code"
    const r = new ExtRegistry();
    const ws = fakeWs("a");
    r.add(ws, baseInfo("d:/code"));
    expect(r.findForCwd("d:/codex/sub")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (no source yet)**

Run: `cd d:/code/cc-hub && npx vitest run tests/ext-registry.test.ts`
Expected: FAIL — "Cannot find module '../src/ext-registry.js'".

- [ ] **Step 3: Write minimal implementation**

Create `d:/code/cc-hub/src/ext-registry.ts`:

```ts
import type { WebSocket } from "ws";
import { normalizePath } from "./protocol-ext.js";

export interface ExtInfo {
  workspace_root: string;   // will be re-normalized inside add() — caller can pass raw
  version: string;
  registered_at: number;
}

interface InternalEntry {
  ws: WebSocket | any;      // `any` to keep tests trivially mockable
  info: ExtInfo;            // info.workspace_root is normalized
}

export class ExtRegistry {
  private entries: InternalEntry[] = [];

  add(ws: WebSocket | any, info: ExtInfo): void {
    const normalized: ExtInfo = { ...info, workspace_root: normalizePath(info.workspace_root) };
    // Replace existing entry for same ws (defensive — re-register on reconnect)
    this.entries = this.entries.filter((e) => e.ws !== ws);
    this.entries.push({ ws, info: normalized });
  }

  remove(ws: WebSocket | any): void {
    this.entries = this.entries.filter((e) => e.ws !== ws);
  }

  findForCwd(cwd: string): WebSocket | null {
    const target = normalizePath(cwd);
    const matches = this.entries
      .filter((e) => isAncestor(e.info.workspace_root, target))
      .sort((a, b) => b.info.workspace_root.length - a.info.workspace_root.length);
    return matches[0]?.ws ?? null;
  }

  list(): Array<{ info: ExtInfo }> {
    return this.entries.map((e) => ({ info: e.info }));
  }
}

// True when `cwd` equals `root` OR is a path-descendant of it.
// Critically guards against false prefix matches: "d:/codex" must NOT match "d:/code".
function isAncestor(root: string, cwd: string): boolean {
  if (root === cwd) return true;
  return cwd.startsWith(root + "/");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub && npx vitest run tests/ext-registry.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/src/ext-registry.ts d:/code/cc-hub/tests/ext-registry.test.ts
git commit -m "feat(daemon): ExtRegistry — longest-prefix-wins workspace routing"
```

---

## Task 3: foreground-ps.ts (extension, TDD)

**Files:**
- Create: `d:/code/cc-hub/extension/src/foreground-ps.ts`
- Create: `d:/code/cc-hub/extension/tests/foreground-ps.test.ts`

This task ports the existing PowerShell script from `cc-hub/src/vscode-bridge.ts:buildFocusAndEnterPS` **with the leading `Start-Process URI` step removed** (the extension fires the URI in-process via `vscode.env.openExternal`).

- [ ] **Step 1: Write failing tests**

Create `d:/code/cc-hub/extension/tests/foreground-ps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFocusAndEnterPS } from "../src/foreground-ps.js";

describe("buildFocusAndEnterPS", () => {
  it("contains the Win32 P/Invoke signature block", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code" });
    expect(ps).toContain("SetForegroundWindow");
    expect(ps).toContain("AttachThreadInput");
    expect(ps).toContain("SwitchToThisWindow");
    expect(ps).toContain("keybd_event");
  });

  it("does NOT fire a vscode:// URI — that's the extension's job", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code" });
    expect(ps).not.toContain("Start-Process");
    expect(ps).not.toContain("vscode://");
  });

  it("ends with SendKeys ENTER (so a successful run actually submits)", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code" });
    expect(ps).toContain("SendKeys");
    expect(ps).toContain("{ENTER}");
  });

  it("interpolates folderHint into the title-matching regex", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "my-special-workspace" });
    expect(ps).toContain("my-special-workspace");
  });

  it("escapes single quotes in folderHint", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "weird'name" });
    expect(ps).toContain("weird''name");
  });

  it("emits diagnostic Write-Output lines for stdout capture", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code" });
    expect(ps).toContain("candidates=");
    expect(ps).toContain("picked hwnd=");
    expect(ps).toContain("enter-sent");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/code/cc-hub/extension && npx vitest run tests/foreground-ps.test.ts`
Expected: FAIL — "Cannot find module '../src/foreground-ps.js'".

- [ ] **Step 3: Write the implementation**

Create `d:/code/cc-hub/extension/src/foreground-ps.ts`:

```ts
/**
 * PowerShell script: find a VSCode top-level window (prefer one whose title
 * contains `folderHint`), force it to OS foreground via Win32 P/Invoke
 * (LockSetForegroundWindow unlock + ALT keypress + AttachThreadInput +
 * SetForegroundWindow + SwitchToThisWindow), then SendKeys {ENTER}.
 *
 * This is a variant of cc-hub/src/vscode-bridge.ts:buildFocusAndEnterPS with
 * the `Start-Process vscode://...` step removed — the extension already fired
 * the URI in-process via vscode.env.openExternal, so there's nothing to launch.
 *
 * The `'@` here-string terminator MUST be at column 0 — the function builds
 * the script without leading whitespace on that line.
 */
export function buildFocusAndEnterPS(opts: { folderHint: string }): string {
  const h = opts.folderHint.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'

$sig = @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
[DllImport("user32.dll")] public static extern bool LockSetForegroundWindow(uint uLockCode);
'@
Add-Type -MemberDefinition $sig -Name 'U' -Namespace 'CcHubHelper'

$candidates = New-Object System.Collections.ArrayList
$proc = [CcHubHelper.U+EnumWindowsProc]{
  param([IntPtr]$h, [IntPtr]$l)
  if (-not [CcHubHelper.U]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [CcHubHelper.U]::GetWindowText($h, $sb, 512) | Out-Null
  $title = $sb.ToString()
  if ($title -match 'Visual Studio Code') {
    [void]$candidates.Add(@{ Hwnd = $h; Title = $title })
  }
  return $true
}
[CcHubHelper.U]::EnumWindows($proc, [IntPtr]::Zero) | Out-Null

$best = $null
$hint = '${h}'
if ($hint -ne '') {
  $best = $candidates | Where-Object { $_.Title -match [regex]::Escape($hint) } | Select-Object -First 1
}
if (-not $best) {
  $fg = [CcHubHelper.U]::GetForegroundWindow()
  $best = $candidates | Where-Object { $_.Hwnd -eq $fg } | Select-Object -First 1
}
if (-not $best -and $candidates.Count -gt 0) { $best = $candidates[0] }

Write-Output ("candidates=" + $candidates.Count)
foreach ($c in $candidates) { Write-Output ("  cand hwnd=" + $c.Hwnd + " title=" + $c.Title) }

if (-not $best) {
  Write-Error ("No VSCode window found (candidates: " + $candidates.Count + ")")
  exit 2
}

$fgBefore = [CcHubHelper.U]::GetForegroundWindow()
$hwnd = $best.Hwnd
Write-Output ("picked hwnd=" + $hwnd + " title=" + $best.Title)
Write-Output ("fg-before hwnd=" + $fgBefore)

if ([CcHubHelper.U]::IsIconic($hwnd)) { [CcHubHelper.U]::ShowWindow($hwnd, 9) | Out-Null }

[CcHubHelper.U]::LockSetForegroundWindow(2) | Out-Null
[CcHubHelper.U]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
[CcHubHelper.U]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
Start-Sleep -Milliseconds 30

$targetTid = [CcHubHelper.U]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
$myTid     = [CcHubHelper.U]::GetCurrentThreadId()
$attachOk  = [CcHubHelper.U]::AttachThreadInput($myTid, $targetTid, $true)
$setFgOk   = [CcHubHelper.U]::SetForegroundWindow($hwnd)
[CcHubHelper.U]::BringWindowToTop($hwnd) | Out-Null
[CcHubHelper.U]::SwitchToThisWindow($hwnd, $true)
[CcHubHelper.U]::AttachThreadInput($myTid, $targetTid, $false) | Out-Null
Start-Sleep -Milliseconds 200

$fgAfter = [CcHubHelper.U]::GetForegroundWindow()
Write-Output ("attach=" + $attachOk + " setFg=" + $setFgOk + " fg-after=" + $fgAfter + " match=" + ($fgAfter -eq $hwnd))

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output "enter-sent"
`.trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub/extension && npx vitest run tests/foreground-ps.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/extension/src/foreground-ps.ts d:/code/cc-hub/extension/tests/foreground-ps.test.ts
git commit -m "feat(helper): foreground-ps script (Win32 focus + SendKeys ENTER, no URI)"
```

---

## Task 4: Submitter (extension, TDD)

**Files:**
- Create: `d:/code/cc-hub/extension/src/submitter.ts`
- Create: `d:/code/cc-hub/extension/tests/submitter.test.ts`

`Submitter` is a pure function — takes a request and a `deps` object, returns a `SubmitAck`. All external interactions (URI dispatch, command exec, PS spawn, sleep) come through `deps` for testability.

- [ ] **Step 1: Write failing tests**

Create `d:/code/cc-hub/extension/tests/submitter.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { submit, type SubmitterDeps } from "../src/submitter.js";

function makeDeps(overrides: Partial<SubmitterDeps> = {}): SubmitterDeps {
  return {
    openExternal: vi.fn().mockResolvedValue(true),
    executeCommand: vi.fn().mockResolvedValue(undefined),
    spawnPS: vi.fn().mockResolvedValue({ ok: true, stdout: "enter-sent", stderr: "" }),
    sleep: vi.fn().mockResolvedValue(undefined),
    prefillDelayMs: 500,
    workspaceFolderName: "code",
    ...overrides,
  };
}

describe("submit", () => {
  it("returns ok=true with diag when whole flow succeeds", async () => {
    const deps = makeDeps();
    const ack = await submit({ request_id: "r1", session_uuid: "uuid-x", prompt: "hi" }, deps);
    expect(ack).toEqual({ type: "submit_ack", request_id: "r1", ok: true, diag: "enter-sent" });
  });

  it("calls openExternal with correctly-encoded vscode:// URI", async () => {
    const deps = makeDeps();
    await submit({ request_id: "r1", session_uuid: "uuid-x", prompt: "hello world" }, deps);
    const [uri] = (deps.openExternal as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(uri).toBe("vscode://anthropic.claude-code/open?session=uuid-x&prompt=hello%20world");
  });

  it("sleeps prefillDelayMs between URI fire and focus command", async () => {
    const deps = makeDeps({ prefillDelayMs: 750 });
    await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(deps.sleep).toHaveBeenCalledWith(750);
  });

  it("calls executeCommand('claude-vscode.focus') after URI + sleep", async () => {
    const deps = makeDeps();
    await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(deps.executeCommand).toHaveBeenCalledWith("claude-vscode.focus");
  });

  it("calls spawnPS with a script that includes workspaceFolderName as hint", async () => {
    const deps = makeDeps({ workspaceFolderName: "my-ws" });
    await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    const [script] = (deps.spawnPS as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(script).toContain("my-ws");
  });

  it("returns ok=false when openExternal returns false", async () => {
    const deps = makeDeps({ openExternal: vi.fn().mockResolvedValue(false) });
    const ack = await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/URI dispatch refused/);
  });

  it("returns ok=false when executeCommand throws", async () => {
    const deps = makeDeps({
      executeCommand: vi.fn().mockRejectedValue(new Error("cmd not found")),
    });
    const ack = await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/cmd not found/);
  });

  it("returns ok=false with diag when PS exits non-zero", async () => {
    const deps = makeDeps({
      spawnPS: vi.fn().mockResolvedValue({ ok: false, stdout: "candidates=0", stderr: "No VSCode window found" }),
    });
    const ack = await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/No VSCode window/);
    expect(ack.diag).toContain("candidates=0");
  });

  it("preserves request_id in ack regardless of outcome", async () => {
    const deps = makeDeps({ openExternal: vi.fn().mockResolvedValue(false) });
    const ack = await submit({ request_id: "abc-xyz-123", session_uuid: "u", prompt: "p" }, deps);
    expect(ack.request_id).toBe("abc-xyz-123");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/code/cc-hub/extension && npx vitest run tests/submitter.test.ts`
Expected: FAIL — "Cannot find module '../src/submitter.js'".

- [ ] **Step 3: Write the implementation**

Create `d:/code/cc-hub/extension/src/submitter.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub/extension && npx vitest run tests/submitter.test.ts`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/extension/src/submitter.ts d:/code/cc-hub/extension/tests/submitter.test.ts
git commit -m "feat(helper): Submitter — URI prefill + focus cmd + PS Win32 + Enter"
```

---

## Task 5: WsClient (extension, TDD)

**Files:**
- Create: `d:/code/cc-hub/extension/src/ws-client.ts`
- Create: `d:/code/cc-hub/extension/tests/ws-client.test.ts`

`WsClient` opens a WS to the daemon, sends `register` on connect, dispatches incoming `submit`/`ping` to caller-supplied handlers, and reconnects with exponential backoff on close.

- [ ] **Step 1: Write failing tests**

Create `d:/code/cc-hub/extension/tests/ws-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WsClient, type WsClientOptions } from "../src/ws-client.js";
import type { ExtMessage, DaemonMessage } from "../src/protocol.js";

// Fake WebSocket factory — captures sent messages, allows test to drive
// open/message/close events from outside.
class FakeWs {
  static instances: FakeWs[] = [];
  sent: string[] = [];
  listeners: Record<string, ((arg?: any) => void)[]> = {};
  readyState = 0;  // CONNECTING
  static OPEN = 1; static CLOSED = 3;
  constructor(public url: string) { FakeWs.instances.push(this); }
  on(ev: string, fn: (arg?: any) => void) { (this.listeners[ev] ??= []).push(fn); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = FakeWs.CLOSED; this.fire("close"); }
  // Drive from tests
  fire(ev: string, arg?: any) { (this.listeners[ev] ?? []).forEach((f) => f(arg)); }
  simulateOpen() { this.readyState = FakeWs.OPEN; this.fire("open"); }
  simulateServerMessage(msg: DaemonMessage) { this.fire("message", JSON.stringify(msg)); }
}

function makeOpts(overrides: Partial<WsClientOptions> = {}): WsClientOptions {
  return {
    url: "ws://test/ws_ext",
    registerInfo: () => ({ workspace_root: "d:/code", helper_version: "0.1.0" }),
    onSubmit: vi.fn().mockResolvedValue({
      type: "submit_ack", request_id: "stub", ok: true,
    }),
    WebSocketCtor: FakeWs as any,
    backoffMs: () => 10,   // fast for tests
    ...overrides,
  };
}

beforeEach(() => { FakeWs.instances.length = 0; });

describe("WsClient", () => {
  it("creates a WebSocket pointed at the configured URL on start()", () => {
    const c = new WsClient(makeOpts());
    c.start();
    expect(FakeWs.instances).toHaveLength(1);
    expect(FakeWs.instances[0]!.url).toBe("ws://test/ws_ext");
    c.stop();
  });

  it("sends register message immediately on open", () => {
    const c = new WsClient(makeOpts());
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    expect(FakeWs.instances[0]!.sent).toHaveLength(1);
    const msg = JSON.parse(FakeWs.instances[0]!.sent[0]!) as ExtMessage;
    expect(msg).toEqual({
      type: "register", workspace_root: "d:/code", helper_version: "0.1.0",
    });
    c.stop();
  });

  it("dispatches incoming submit message to onSubmit and sends ack back", async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      type: "submit_ack", request_id: "r1", ok: true, diag: "ok",
    });
    const c = new WsClient(makeOpts({ onSubmit }));
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    FakeWs.instances[0]!.simulateServerMessage({
      type: "submit", request_id: "r1", session_uuid: "u", prompt: "p",
    });
    // Yield so async ack send completes
    await new Promise((r) => setTimeout(r, 0));
    expect(onSubmit).toHaveBeenCalledWith({
      type: "submit", request_id: "r1", session_uuid: "u", prompt: "p",
    });
    // sent[0] = register, sent[1] = submit_ack
    const ack = JSON.parse(FakeWs.instances[0]!.sent[1]!) as ExtMessage;
    expect(ack).toMatchObject({ type: "submit_ack", request_id: "r1", ok: true });
    c.stop();
  });

  it("responds to ping with pong (same request_id)", async () => {
    const c = new WsClient(makeOpts());
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    FakeWs.instances[0]!.simulateServerMessage({ type: "ping", request_id: "p1" });
    await new Promise((r) => setTimeout(r, 0));
    // sent[0] = register, sent[1] = pong
    expect(JSON.parse(FakeWs.instances[0]!.sent[1]!)).toEqual({ type: "pong", request_id: "p1" });
    c.stop();
  });

  it("reconnects on close (calls WebSocketCtor again)", async () => {
    const c = new WsClient(makeOpts());
    c.start();
    expect(FakeWs.instances).toHaveLength(1);
    FakeWs.instances[0]!.simulateOpen();
    FakeWs.instances[0]!.close();
    await new Promise((r) => setTimeout(r, 20)); // wait > backoffMs (10ms)
    expect(FakeWs.instances).toHaveLength(2);
    c.stop();
  });

  it("re-sends register after reconnect", async () => {
    const c = new WsClient(makeOpts());
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    FakeWs.instances[0]!.close();
    await new Promise((r) => setTimeout(r, 20));
    FakeWs.instances[1]!.simulateOpen();
    const msg = JSON.parse(FakeWs.instances[1]!.sent[0]!);
    expect(msg.type).toBe("register");
    c.stop();
  });

  it("stop() prevents further reconnects", async () => {
    const c = new WsClient(makeOpts());
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    c.stop();
    FakeWs.instances[0]!.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeWs.instances).toHaveLength(1);  // no new instance
  });

  it("ignores malformed JSON messages without crashing", async () => {
    const onSubmit = vi.fn();
    const c = new WsClient(makeOpts({ onSubmit }));
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    FakeWs.instances[0]!.fire("message", "not-valid-json{");
    await new Promise((r) => setTimeout(r, 0));
    expect(onSubmit).not.toHaveBeenCalled();
    c.stop();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/code/cc-hub/extension && npx vitest run tests/ws-client.test.ts`
Expected: FAIL — "Cannot find module '../src/ws-client.js'".

- [ ] **Step 3: Write the implementation**

Create `d:/code/cc-hub/extension/src/ws-client.ts`:

```ts
import type {
  DaemonMessage, ExtMessage, MsgSubmit, MsgSubmitAck, MsgPong,
} from "./protocol.js";

// Structural shape — extension uses `ws` package's WebSocket at runtime,
// tests substitute a fake. Both satisfy this interface.
interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: any) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export interface WsClientOptions {
  url: string;
  registerInfo: () => { workspace_root: string; helper_version: string };
  onSubmit: (req: MsgSubmit) => Promise<MsgSubmitAck>;
  WebSocketCtor: new (url: string) => WsLike;
  // Returns the next reconnect delay in ms given the current attempt count (1-based).
  // Default: exponential backoff 1s, 2s, 4s, 8s, 16s, capped at 30s.
  backoffMs?: (attempt: number) => number;
  log?: (msg: string, ctx?: object) => void;
}

const DEFAULT_BACKOFF = (attempt: number) => Math.min(30_000, 1000 * Math.pow(2, attempt - 1));

export class WsClient {
  private ws: WsLike | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private readonly backoff: (attempt: number) => number;

  constructor(private readonly opts: WsClientOptions) {
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
  }

  private connect(): void {
    const ws = new this.opts.WebSocketCtor(this.opts.url);
    this.ws = ws;
    ws.on("open", () => {
      this.attempt = 0;
      const info = this.opts.registerInfo();
      this.sendMsg({ type: "register", workspace_root: info.workspace_root, helper_version: info.helper_version });
      this.opts.log?.("ws connected, registered", info);
    });
    ws.on("message", (data: any) => {
      this.handleMessage(String(data));
    });
    ws.on("close", () => {
      this.ws = null;
      if (this.stopped) return;
      this.attempt += 1;
      const delay = this.backoff(this.attempt);
      this.opts.log?.("ws closed, reconnecting", { attempt: this.attempt, delay });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
    ws.on("error", (err) => {
      this.opts.log?.("ws error", { error: String(err) });
      // Let `close` handler trigger the reconnect; do nothing here.
    });
  }

  private handleMessage(text: string): void {
    let msg: DaemonMessage;
    try { msg = JSON.parse(text); } catch {
      this.opts.log?.("ws got malformed json, ignoring", { text: text.slice(0, 200) });
      return;
    }
    if (msg.type === "submit") {
      this.opts.onSubmit(msg).then((ack) => this.sendMsg(ack));
      return;
    }
    if (msg.type === "ping") {
      const pong: MsgPong = { type: "pong", request_id: msg.request_id };
      this.sendMsg(pong);
      return;
    }
  }

  private sendMsg(msg: ExtMessage): void {
    if (!this.ws) return;
    try { this.ws.send(JSON.stringify(msg)); }
    catch (err) { this.opts.log?.("ws send failed", { error: String(err) }); }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub/extension && npx vitest run tests/ws-client.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/extension/src/ws-client.ts d:/code/cc-hub/extension/tests/ws-client.test.ts
git commit -m "feat(helper): WsClient — register-on-connect + reconnect backoff"
```

---

## Task 6: Extension entry point (extension.ts)

**Files:**
- Create: `d:/code/cc-hub/extension/src/extension.ts`

This task wires WsClient + Submitter to the real VSCode API and the `ws` package. Tested manually via the VSIX install step (Task 11); no unit test added (would test only glue code with little value).

- [ ] **Step 1: Write the implementation**

Create `d:/code/cc-hub/extension/src/extension.ts`:

```ts
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
```

- [ ] **Step 2: Compile to verify TypeScript is clean**

Run: `cd d:/code/cc-hub/extension && npm run compile`
Expected: no errors; produces `dist/extension.js` (plus other files).

- [ ] **Step 3: Run all extension tests to verify nothing else broke**

Run: `cd d:/code/cc-hub/extension && npm test`
Expected: all tests pass (17 total: 6 PS + 9 submitter + 8 ws-client).

- [ ] **Step 4: Commit**

```bash
git add d:/code/cc-hub/extension/src/extension.ts
git commit -m "feat(helper): extension entry — wires WsClient + Submitter to vscode API"
```

---

## Task 7: Daemon `/ws_ext` WebSocketServer wired to ExtRegistry

**Files:**
- Modify: `d:/code/cc-hub/src/server.ts`
- Modify: `d:/code/cc-hub/tests/integration.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `d:/code/cc-hub/tests/integration.test.ts` (after the existing `describe`s, before the trailing newline). Note: the file already imports `WebSocket from "ws"` at the top — do NOT add a duplicate import.

```ts
describe("daemon /ws_ext extension registry", () => {
  it("accepts ws connection, processes register, adds to registry", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { server, registry } = createApp({
      store, handler, bridge: null as any, notifier: null as any, webDir: "/tmp/none",
    }) as any;  // registry is a new exported property — Task 7 adds it
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const port = addr.port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({
      type: "register", workspace_root: "d:/code", helper_version: "0.1.0",
    }));
    // Give server a tick to process
    await new Promise((r) => setTimeout(r, 50));

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].info.workspace_root).toBe("d:/code");

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.list()).toHaveLength(0);

    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  it("ignores non-register messages on a not-yet-registered ws (graceful)", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { server, registry } = createApp({
      store, handler, bridge: null as any, notifier: null as any, webDir: "/tmp/none",
    }) as any;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ type: "submit_ack", request_id: "x", ok: true }));
    await new Promise((r) => setTimeout(r, 50));

    // Server should not crash, registry should remain empty
    expect(registry.list()).toHaveLength(0);

    ws.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/code/cc-hub && npx vitest run tests/integration.test.ts`
Expected: FAIL on the new `describe("daemon /ws_ext extension registry")` block — `registry` is undefined.

- [ ] **Step 3: Modify `src/server.ts`** — add the registry + new WS server

In `d:/code/cc-hub/src/server.ts`:

(a) Add imports at top of file (after the existing imports):

```ts
import { ExtRegistry } from "./ext-registry.js";
import type { ExtMessage } from "./protocol-ext.js";
```

(b) Change the `ServerDeps` interface (around line 17-24) — add no new field; registry lives in the returned object.

(c) Modify the `createApp` return type signature (around line 43):

Change:
```ts
export function createApp(deps: ServerDeps): { app: Express; server: http.Server } {
```
to:
```ts
export function createApp(deps: ServerDeps): { app: Express; server: http.Server; registry: ExtRegistry } {
```

(d) Add the registry + second WS server right before the existing `wss` declaration (around line 242, near the bottom of `createApp` before the final `return`):

```ts
  const registry = new ExtRegistry();
  const wssExt = new WebSocketServer({ server, path: "/ws_ext" });
  wssExt.on("connection", (ws) => {
    deps.log?.info({ route: "/ws_ext" }, "extension ws connected");
    ws.on("message", (raw) => {
      let msg: ExtMessage;
      try { msg = JSON.parse(String(raw)); } catch {
        deps.log?.warn({ route: "/ws_ext", raw: String(raw).slice(0, 200) }, "malformed json, ignoring");
        return;
      }
      if (msg.type === "register") {
        registry.add(ws, {
          workspace_root: msg.workspace_root,
          version: msg.helper_version,
          registered_at: Date.now(),
        });
        deps.log?.info({ route: "/ws_ext", workspace_root: msg.workspace_root, version: msg.helper_version }, "extension registered");
        return;
      }
      // submit_ack and pong are handled by per-request listeners attached in
      // VscodeBridge.submitViaHelper (Task 8). Nothing to do here.
    });
    ws.on("close", () => {
      registry.remove(ws);
      deps.log?.info({ route: "/ws_ext" }, "extension ws disconnected");
    });
    ws.on("error", (err) => {
      deps.log?.warn({ route: "/ws_ext", error: String(err) }, "extension ws error");
    });
  });
```

(e) Modify the final return statement (around line 253):

Change:
```ts
  return { app, server };
}
```
to:
```ts
  return { app, server, registry };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub && npx vitest run tests/integration.test.ts`
Expected: all tests pass (old ones plus the 2 new ones for `/ws_ext`).

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/src/server.ts d:/code/cc-hub/tests/integration.test.ts
git commit -m "feat(daemon): /ws_ext WebSocket server + ExtRegistry wiring"
```

---

## Task 7.5: Daemon-side ping heartbeat (spec line 91)

**Files:**
- Modify: `d:/code/cc-hub/src/server.ts`
- Modify: `d:/code/cc-hub/tests/integration.test.ts`

Per spec: daemon pings every 30s; if no pong within 10s, drop the connection. Extension's ws-client reconnects naturally. Without this, hung-but-socket-alive extensions linger in registry; submitViaHelper times out at 10s on a dead recipient. Heartbeat removes them sooner.

- [ ] **Step 1: Write failing test (compress to one for speed — heartbeat is mechanical)**

Append to `tests/integration.test.ts`:

```ts
describe("daemon /ws_ext heartbeat", () => {
  it("drops connection when no pong arrives within timeout", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    // Fast intervals for tests: pingMs=50, pongTimeoutMs=30
    const { server, registry } = createApp({
      store, handler, bridge: null as any, notifier: null as any, webDir: "/tmp/none",
      heartbeat: { pingMs: 50, pongTimeoutMs: 30 },
    } as any);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    // Connect a deliberately-silent client (never responds to ping)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ type: "register", workspace_root: "d:/code", helper_version: "test" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(registry.list()).toHaveLength(1);

    // Wait: 50ms ping fires, 30ms pong timeout → connection dropped by daemon
    await new Promise((r) => setTimeout(r, 200));
    expect(registry.list()).toHaveLength(0);

    ws.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd d:/code/cc-hub && npx vitest run tests/integration.test.ts -t heartbeat`
Expected: FAIL — registry still has 1 entry after 200ms (no heartbeat implemented).

- [ ] **Step 3: Extend `ServerDeps` and `createApp` in `src/server.ts`**

(a) Add optional `heartbeat` field to `ServerDeps`:

```ts
export interface ServerDeps {
  store: SessionStore;
  handler: HookHandler;
  bridge: VscodeBridge;
  notifier: Notifier;
  webDir: string;
  log?: Log;
  heartbeat?: { pingMs: number; pongTimeoutMs: number };  // default: { 30_000, 10_000 }
}
```

(b) In `createApp`, after the `wssExt.on("connection", (ws) => {...})` block, attach a heartbeat per connection. Modify the connection handler to track ping state per ws:

```ts
  const hb = deps.heartbeat ?? { pingMs: 30_000, pongTimeoutMs: 10_000 };
  const pendingPong = new WeakMap<any, { request_id: string; deadline: number }>();

  wssExt.on("connection", (ws) => {
    deps.log?.info({ route: "/ws_ext" }, "extension ws connected");

    // Existing message handler — extend it to clear pendingPong on incoming pong:
    ws.on("message", (raw) => {
      let msg: ExtMessage;
      try { msg = JSON.parse(String(raw)); } catch {
        deps.log?.warn({ route: "/ws_ext", raw: String(raw).slice(0, 200) }, "malformed json, ignoring");
        return;
      }
      if (msg.type === "register") {
        registry.add(ws, {
          workspace_root: msg.workspace_root,
          version: msg.helper_version,
          registered_at: Date.now(),
        });
        deps.log?.info({ route: "/ws_ext", workspace_root: msg.workspace_root, version: msg.helper_version }, "extension registered");
        return;
      }
      if (msg.type === "pong") {
        const pending = pendingPong.get(ws);
        if (pending && pending.request_id === msg.request_id) {
          pendingPong.delete(ws);
        }
        return;
      }
      // submit_ack handled by per-request listener in submitViaHelper.
    });

    // Heartbeat: fire ping every pingMs; if pendingPong unresolved past deadline, close.
    const pingTimer = setInterval(() => {
      const existing = pendingPong.get(ws);
      if (existing && Date.now() > existing.deadline) {
        deps.log?.warn({ route: "/ws_ext", request_id: existing.request_id }, "pong timeout, closing");
        try { ws.terminate(); } catch { /* ignore */ }
        clearInterval(pingTimer);
        return;
      }
      if (!existing) {
        const request_id = randomUUID();
        pendingPong.set(ws, { request_id, deadline: Date.now() + hb.pongTimeoutMs });
        try { ws.send(JSON.stringify({ type: "ping", request_id })); }
        catch { /* ws may be closing; let close handler clean up */ }
      }
    }, hb.pingMs);

    ws.on("close", () => {
      clearInterval(pingTimer);
      registry.remove(ws);
      deps.log?.info({ route: "/ws_ext" }, "extension ws disconnected");
    });
    ws.on("error", (err) => {
      deps.log?.warn({ route: "/ws_ext", error: String(err) }, "extension ws error");
    });
  });
```

Add import at top:
```ts
import { randomUUID } from "node:crypto";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub && npx vitest run tests/integration.test.ts`
Expected: all tests pass including the new heartbeat one.

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/src/server.ts d:/code/cc-hub/tests/integration.test.ts
git commit -m "feat(daemon): /ws_ext heartbeat — ping/pong with pongTimeout terminate"
```

---

## Task 8: `VscodeBridge.submitViaHelper` (daemon, TDD)

**Files:**
- Modify: `d:/code/cc-hub/src/vscode-bridge.ts`
- Modify: `d:/code/cc-hub/tests/integration.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `d:/code/cc-hub/tests/integration.test.ts`:

```ts
describe("VscodeBridge.submitViaHelper", () => {
  it("sends submit message over ws and resolves on matching submit_ack", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { server, registry } = createApp({
      store, handler, bridge: new VscodeBridge(async () => {}), notifier: null as any, webDir: "/tmp/none",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    // Fake extension connects, registers, echoes a successful ack for any submit
    const extWs = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => extWs.on("open", () => r()));
    extWs.send(JSON.stringify({ type: "register", workspace_root: "d:/code", helper_version: "test" }));
    extWs.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "submit") {
        extWs.send(JSON.stringify({
          type: "submit_ack", request_id: m.request_id, ok: true, diag: "test-ok",
        }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const bridge = new VscodeBridge(async () => {});
    const result = await bridge.submitViaHelper({
      sessionUuid: "uuid-1", prompt: "hi", cwd: "d:/code", registry, timeoutMs: 2000,
    });
    expect(result).toEqual({ ok: true, diag: "test-ok" });

    extWs.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  it("returns {ok:false} when no extension registered for cwd", async () => {
    const registry = new ExtRegistry();   // import added at top of test file
    const bridge = new VscodeBridge(async () => {});
    const result = await bridge.submitViaHelper({
      sessionUuid: "u", prompt: "p", cwd: "d:/code", registry, timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no cc-hub-helper.*registered/i);
  });

  it("returns {ok:false} after timeoutMs when extension doesn't ack", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { server, registry } = createApp({
      store, handler, bridge: new VscodeBridge(async () => {}), notifier: null as any, webDir: "/tmp/none",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    const extWs = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => extWs.on("open", () => r()));
    extWs.send(JSON.stringify({ type: "register", workspace_root: "d:/code", helper_version: "test" }));
    // Deliberately don't ack
    await new Promise((r) => setTimeout(r, 50));

    const bridge = new VscodeBridge(async () => {});
    const result = await bridge.submitViaHelper({
      sessionUuid: "u", prompt: "p", cwd: "d:/code", registry, timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/i);

    extWs.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  it("propagates {ok:false, error} from submit_ack to caller", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { server, registry } = createApp({
      store, handler, bridge: new VscodeBridge(async () => {}), notifier: null as any, webDir: "/tmp/none",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    const extWs = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => extWs.on("open", () => r()));
    extWs.send(JSON.stringify({ type: "register", workspace_root: "d:/code", helper_version: "test" }));
    extWs.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "submit") {
        extWs.send(JSON.stringify({
          type: "submit_ack", request_id: m.request_id, ok: false, error: "URI dispatch refused", diag: "x",
        }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const bridge = new VscodeBridge(async () => {});
    const result = await bridge.submitViaHelper({
      sessionUuid: "u", prompt: "p", cwd: "d:/code", registry, timeoutMs: 2000,
    });
    expect(result).toEqual({ ok: false, error: "URI dispatch refused", diag: "x" });

    extWs.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});
```

Add to the imports at the top of `tests/integration.test.ts`:
```ts
import { ExtRegistry } from "../src/ext-registry.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/code/cc-hub && npx vitest run tests/integration.test.ts`
Expected: FAIL — `bridge.submitViaHelper is not a function`.

- [ ] **Step 3: Modify `src/vscode-bridge.ts`** — add `submitViaHelper`, rename existing

(a) Add imports at top of file:

```ts
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { ExtRegistry } from "./ext-registry.js";
import type { MsgSubmit, MsgSubmitAck, ExtMessage } from "./protocol-ext.js";
```

(b) Rename the existing method `prefillAndSubmit` to `prefillAndSubmitLegacy`. Find the method around line 256 (`async prefillAndSubmit(...)`) and rename it. Update any callers in `src/server.ts` accordingly in Task 9.

(c) Add the new method `submitViaHelper` inside `class VscodeBridge` (after `prefillAndSubmitLegacy`):

```ts
  /**
   * Send a submit request to the helper extension that owns the given cwd's
   * workspace, and await its ack. Returns {ok, error?, diag?}.
   */
  async submitViaHelper(args: {
    sessionUuid: string;
    prompt: string;
    cwd: string;
    registry: ExtRegistry;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; error?: string; diag?: string }> {
    const ws = args.registry.findForCwd(args.cwd) as WebSocket | null;
    if (!ws) {
      return {
        ok: false,
        error: `no cc-hub-helper extension registered for workspace covering ${args.cwd}; install the VSIX into that VSCode window: npm run install-helper`,
      };
    }
    const requestId = randomUUID();
    const submitMsg: MsgSubmit = {
      type: "submit",
      request_id: requestId,
      session_uuid: args.sessionUuid,
      prompt: args.prompt,
    };
    const timeoutMs = args.timeoutMs ?? 10_000;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        resolve({ ok: false, error: `submit_ack timeout after ${timeoutMs}ms` });
      }, timeoutMs);

      const onMessage = (raw: any) => {
        let msg: ExtMessage;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type !== "submit_ack") return;
        if (msg.request_id !== requestId) return;
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve({
          ok: msg.ok,
          ...(msg.error !== undefined ? { error: msg.error } : {}),
          ...(msg.diag !== undefined ? { diag: msg.diag } : {}),
        });
      };
      ws.on("message", onMessage);
      try { ws.send(JSON.stringify(submitMsg)); }
      catch (err) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve({ ok: false, error: `ws send failed: ${String(err)}` });
      }
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub && npx vitest run tests/integration.test.ts`
Expected: all tests pass (existing + 4 new for `submitViaHelper`).

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/src/vscode-bridge.ts d:/code/cc-hub/tests/integration.test.ts
git commit -m "feat(daemon): submitViaHelper — WS submit + ack/timeout; rename legacy"
```

---

## Task 9: `/send` routing change

**Files:**
- Modify: `d:/code/cc-hub/src/server.ts`
- Modify: `d:/code/cc-hub/tests/integration.test.ts`

The dashboard's `/send` with `submit:false, auto_enter:true` (default) currently calls `bridge.prefillAndSubmit(...)` (now renamed `prefillAndSubmitLegacy`). Replace with the new routing: try `submitViaHelper` first; if no extension registered → return 503 with helpful message; never silently fall back to legacy (it's broken).

- [ ] **Step 1: Write failing tests**

Append to `tests/integration.test.ts`:

```ts
describe("server POST /send routing (helper path)", () => {
  it("returns 503 with helpful message when no helper registered for cwd", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code\\xianyu-assistant", session_uuid: "uuid-y", project_name: "xianyu",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const bridge = new VscodeBridge(async () => {});
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app } = createApp({ store, handler, bridge, notifier: null as any, webDir: "/tmp/none" });

    const res = await request(app).post("/send").send({
      session_uuid: "uuid-y", prompt: "hi",  // auto_enter:true (default), submit:false (default)
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/no cc-hub-helper.*registered/i);
    expect(res.body.error).toMatch(/install the VSIX/i);
    store.close();
  });

  it("returns 200 with ok=true when helper acks success", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code", session_uuid: "uuid-z", project_name: "code",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const bridge = new VscodeBridge(async () => {});
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app, server, registry } = createApp({
      store, handler, bridge, notifier: null as any, webDir: "/tmp/none",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    const extWs = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => extWs.on("open", () => r()));
    extWs.send(JSON.stringify({ type: "register", workspace_root: "d:/code", helper_version: "test" }));
    extWs.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "submit") {
        extWs.send(JSON.stringify({
          type: "submit_ack", request_id: m.request_id, ok: true, diag: "all-good",
        }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const res = await request(app).post("/send").send({ session_uuid: "uuid-z", prompt: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mode).toBe("helper");
    expect(res.body.diag).toBe("all-good");

    extWs.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  it("returns 200 with ok=false when helper acks error (propagates message)", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code", session_uuid: "uuid-w", project_name: "code",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const bridge = new VscodeBridge(async () => {});
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app, server } = createApp({
      store, handler, bridge, notifier: null as any, webDir: "/tmp/none",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    const extWs = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => extWs.on("open", () => r()));
    extWs.send(JSON.stringify({ type: "register", workspace_root: "d:/code", helper_version: "test" }));
    extWs.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "submit") {
        extWs.send(JSON.stringify({
          type: "submit_ack", request_id: m.request_id, ok: false, error: "claude-vscode.focus not found",
        }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const res = await request(app).post("/send").send({ session_uuid: "uuid-w", prompt: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/claude-vscode.focus not found/);

    extWs.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/code/cc-hub && npx vitest run tests/integration.test.ts`
Expected: 3 new tests FAIL (current `/send` calls `prefillAndSubmit` which is now legacy + uses SendKeys path).

- [ ] **Step 3: Modify `src/server.ts` `/send` handler**

Find the `if (!submitFlag)` branch inside the `/send` handler (around line 213). Replace the body of that branch with:

```ts
    if (!submitFlag) {
      // PREFILL+ENTER mode — route via helper extension. The legacy direct-SendKeys
      // path (prefillAndSubmitLegacy) does NOT reliably deliver prompts (verified
      // end-to-end: see 2026-05-16 spec). Opt in to legacy explicitly with ?legacy=1
      // for debugging the Win32 focus mechanism in isolation.
      const url = buildSendUrl(session.session_uuid, prompt);
      const legacyMode = req.query.legacy === "1";

      if (legacyMode) {
        try {
          const r = await deps.bridge.prefillAndSubmitLegacy(session.session_uuid, prompt, { cwd: session.cwd });
          deps.log?.info({ route: "/send", mode: "legacy", session_uuid: session.session_uuid, diag: r.diag }, "legacy path used");
          res.status(200).json({ ok: true, mode: "legacy", url, session_uuid: session.session_uuid, cwd: session.cwd, project: session.project_name, diag: r.diag });
        } catch (err) {
          deps.log?.error({ route: "/send", mode: "legacy", error: String(err) }, "legacy path threw");
          res.status(500).json({ error: String(err), url });
        }
        return;
      }

      // Default: helper path
      const result = await deps.bridge.submitViaHelper({
        sessionUuid: session.session_uuid!,
        prompt,
        cwd: session.cwd,
        registry,
        timeoutMs: 10_000,
      });
      if (!result.ok && result.error?.includes("no cc-hub-helper")) {
        deps.log?.warn({ route: "/send", mode: "helper", cwd: session.cwd }, "no helper for cwd");
        res.status(503).json({ ok: false, error: result.error, mode: "helper", url, cwd: session.cwd });
        return;
      }
      deps.log?.info({ route: "/send", mode: "helper", session_uuid: session.session_uuid, ok: result.ok, error: result.error, diag: result.diag }, "helper path");
      res.status(200).json({
        ok: result.ok, mode: "helper",
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.diag !== undefined ? { diag: result.diag } : {}),
        url, session_uuid: session.session_uuid, cwd: session.cwd, project: session.project_name,
      });
      return;
    }
```

Also: `registry` is in scope because the `/send` handler is defined inside `createApp` after the registry constant. Verify by reading the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub && npx vitest run`
Expected: all tests pass.

- [ ] **Step 5: Update `web/app.tsx`** to surface 503 properly

In `d:/code/cc-hub/web/app.tsx`, find the `onSend` function (around line 1044). Modify the existing line:

```ts
return { ok: r.ok, status: r.status, url: body?.url, reply: body?.reply, duration_ms: body?.duration_ms, diag: body?.diag };
```
to add the error field:
```ts
return { ok: r.ok, status: r.status, url: body?.url, reply: body?.reply, duration_ms: body?.duration_ms, diag: body?.diag, error: body?.error };
```

Then update the return type in the parent call sites — find `onSend: (uuid: string, prompt: string, submit: boolean) => Promise<...>` (around line 300 and line 814) and add `error?: string` to both.

Find the `setSendResult({...})` call (around line 437) — add `error: r.error` to the object literal, and update the `ActionResult` type (around line 295) to include `error?: string`.

Finally, modify the inline feedback rendering (around line 612) to show 503 errors prominently. After the existing `送 prompt: {sendResult.label}` line, add:

```tsx
              {sendResult.error && (
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--accent)", padding: 8, background: "var(--bg-subtle)", borderRadius: 4 }}>
                  ⚠️ {sendResult.error}
                </div>
              )}
```

- [ ] **Step 6: Type-check everything**

Run: `cd d:/code/cc-hub && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add d:/code/cc-hub/src/server.ts d:/code/cc-hub/tests/integration.test.ts d:/code/cc-hub/web/app.tsx
git commit -m "feat(daemon): /send routes via helper; surface 503/error in dashboard"
```

---

## Task 10: `install-helper` script

**Files:**
- Create: `d:/code/cc-hub/scripts/install-helper.mjs`
- Modify: `d:/code/cc-hub/package.json`

- [ ] **Step 1: Create the install script**

Create `d:/code/cc-hub/scripts/install-helper.mjs`:

```js
#!/usr/bin/env node
/**
 * Package the cc-hub-helper VSCode extension into a .vsix and install it
 * into the user's local VSCode (`code --install-extension`).
 *
 * Idempotent — uses `--force` to overwrite any existing install. Re-run this
 * after editing extension/src/* to deploy changes.
 */
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, "..", "extension");

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: true, ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.on("error", reject);
  });
}

async function main() {
  console.log(`[install-helper] extension dir: ${extDir}`);

  console.log("[install-helper] compiling TypeScript…");
  await run("npm", ["run", "compile"], { cwd: extDir });

  console.log("[install-helper] packaging VSIX…");
  await run("npm", ["run", "package"], { cwd: extDir });

  const entries = await readdir(extDir);
  const vsixes = entries.filter((e) => e.endsWith(".vsix"));
  if (vsixes.length === 0) throw new Error("no .vsix produced in extension/");
  const withMtime = await Promise.all(
    vsixes.map(async (f) => ({ f, mtime: (await stat(path.join(extDir, f))).mtimeMs })),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const vsix = path.join(extDir, withMtime[0].f);
  console.log(`[install-helper] installing: ${vsix}`);

  await run("code", ["--install-extension", vsix, "--force"]);

  console.log("");
  console.log("✅ cc-hub-helper installed. Restart your VSCode windows to activate it.");
  console.log("   Then in the dashboard, click 送出 to verify prompts reach the right Claude panel.");
}

main().catch((err) => { console.error("[install-helper] failed:", err.message); process.exit(1); });
```

- [ ] **Step 2: Add npm script in root `package.json`**

Find the `"scripts"` block in `d:/code/cc-hub/package.json` and add:

```json
    "install-helper": "node scripts/install-helper.mjs",
```

(Insert in alphabetical order if convention applies, or just append.)

- [ ] **Step 3: Verify the script syntactically loads**

Run: `cd d:/code/cc-hub && node --check scripts/install-helper.mjs`
Expected: no output (clean).

- [ ] **Step 4: Smoke-test the script (requires `code` CLI on PATH)**

Run: `cd d:/code/cc-hub && npm run install-helper`
Expected:
- TypeScript compiles
- VSIX produced in `extension/`
- `code --install-extension` reports success
- Final message printed: "Restart your VSCode windows…"

If `vsce` complains about missing `LICENSE` or `README.md`, those are added in Task 11. Run again after Task 11.

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/scripts/install-helper.mjs d:/code/cc-hub/package.json
git commit -m "feat(scripts): install-helper — package + install VSIX in one command"
```

---

## Task 11: README + final smoke test

**Files:**
- Create: `d:/code/cc-hub/extension/README.md`
- Modify: `d:/code/cc-hub/extension/.vscodeignore` (allow README in VSIX)

- [ ] **Step 1: Create the extension README**

Create `d:/code/cc-hub/extension/README.md`:

```markdown
# cc-hub-helper

Companion VSCode extension for [cc-hub](../). Runs inside the VSCode extension host, opens a WebSocket to the cc-hub daemon, and dispatches `/send` requests from the dashboard to the matching Claude panel session.

## Why

The cc-hub daemon, running outside VSCode, can fire `vscode://anthropic.claude-code/open?session=…&prompt=…` URIs to prefill prompts in a Claude panel. But it cannot reliably submit them — `SendKeys ENTER` from a PowerShell child process either lands in the wrong control or never reaches the panel webview. This extension runs *inside* VSCode, where it can call `claude-vscode.focus` (an internal command) and submit via a controlled flow.

## Install

From the cc-hub repo root:

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
- `~/.cc-hub/cc-hub.log` has full structured logs
- `Help → Toggle Developer Tools → Console` in VSCode shows extension's console.log

## Uninstall

```sh
code --uninstall-extension cc-hub.cc-hub-helper
```

## Settings

- `cc-hub-helper.daemonUrl` — default `ws://127.0.0.1:8765/ws_ext`
- `cc-hub-helper.prefillDelayMs` — default `500` (ms to wait between URI fire and Enter)

## Development

```sh
cd extension
npm install
npm test                    # vitest unit tests
npm run compile             # tsc → dist/
npm run package             # vsce → .vsix
```

To deploy your changes, run `npm run install-helper` from the cc-hub root and restart VSCode.
```

- [ ] **Step 2: Update `.vscodeignore` to include README**

Edit `d:/code/cc-hub/extension/.vscodeignore`. The file currently excludes everything except `dist/**` and `node_modules/ws/**`. Add `!README.md` near the bottom to allow it through (vsce requires a README in the VSIX):

```
.vscode/**
.vscode-test/**
tests/**
src/**
**/*.map
**/*.ts
!dist/**
node_modules/**
!node_modules/ws/**
vitest.config.ts
tsconfig.json
!README.md
```

- [ ] **Step 3: Final type-check + full test sweep**

Run: `cd d:/code/cc-hub && npx tsc --noEmit && npx vitest run`
Expected: typechecks clean; all tests pass (existing + all new).

Run: `cd d:/code/cc-hub/extension && npx tsc --noEmit && npm test`
Expected: typechecks clean; all extension tests pass (23 total).

- [ ] **Step 4: Build VSIX and install end-to-end**

Run: `cd d:/code/cc-hub && npm run install-helper`
Expected: completes successfully, prints "Restart your VSCode windows…".

- [ ] **Step 5: Manual E2E test (cannot be automated)**

1. Restart the VSCode window with workspace `d:/code` (or whichever workspace has the target session)
2. Open dashboard at the daemon URL (`http://127.0.0.1:8765/`)
3. Pick the cell for a session in that workspace
4. Type "e2e-smoke-test-A" in the input box and click 送出
5. Verify: the prompt appears as a new user message in that VSCode's Claude panel session (`~/.claude/projects/<workspace>/<uuid>.jsonl` should gain a new user-role line containing the test string)
6. Repeat for at least one additional VSCode window (e.g. d:/code/openruterati)
7. Verify: pick a session whose workspace is NOT open in any installed-helper VSCode → dashboard shows 503 with "no cc-hub-helper extension registered…" message

- [ ] **Step 6: Commit**

```bash
git add d:/code/cc-hub/extension/README.md d:/code/cc-hub/extension/.vscodeignore
git commit -m "docs(helper): README + .vscodeignore tweak; verify VSIX install"
```

---

## Wrap-up

After all tasks complete, the dashboard's default 送出 path is:

```
Dashboard → POST /send → daemon /send handler
  → ExtRegistry.findForCwd(session.cwd) → WS for matching helper
  → daemon sends {type:"submit", ...}
  → helper extension: openExternal(URI) → sleep → claude-vscode.focus → spawn PS (Win32 + SendKeys ENTER)
  → helper sends {type:"submit_ack", ok, diag}
  → daemon /send responds 200 with diag
  → dashboard shows success or error inline
```

The legacy direct-PowerShell path remains accessible via `POST /send?legacy=1` for debugging the OS-level focus mechanism in isolation. It is documented but not used by the dashboard's default 送出.
