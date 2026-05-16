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
