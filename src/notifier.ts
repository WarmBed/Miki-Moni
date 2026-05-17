import notifier from "node-notifier";

export interface NotifyArgs {
  project: string;
  message: string;
}

export type SendFn = (opts: { title: string; message: string }) => void;

export const defaultSend: SendFn = (opts) => notifier.notify(opts);

export class Notifier {
  constructor(private send: SendFn = defaultSend) {}

  async notify(args: NotifyArgs): Promise<void> {
    this.send({
      title: `miki-moni · ${args.project}`,
      message: args.message,
    });
  }
}
