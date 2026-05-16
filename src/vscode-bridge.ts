import { spawn } from "node:child_process";

export type LaunchFn = (url: string) => Promise<void>;

export const defaultLaunch: LaunchFn = (url) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-Command", `Start-Process -FilePath '${url.replace(/'/g, "''")}'`],
      { stdio: "ignore", windowsHide: true }
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.on("error", reject);
  });

export class VscodeBridge {
  constructor(private launch: LaunchFn = defaultLaunch) {}

  async focus(sessionUuid: string | null): Promise<void> {
    const base = "vscode://anthropic.claude-code/open";
    const url = sessionUuid ? `${base}?session=${sessionUuid}` : base;
    await this.launch(url);
  }

  async send(sessionUuid: string | null, prompt: string): Promise<void> {
    const parts: string[] = [];
    if (sessionUuid) parts.push(`session=${encodeURIComponent(sessionUuid)}`);
    parts.push(`prompt=${encodeURIComponent(prompt)}`);
    const url = `vscode://anthropic.claude-code/open?${parts.join("&")}`;
    await this.launch(url);
  }
}
