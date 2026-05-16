// Minimal push-able async iterable used as the `prompt` stream into Agent SDK's
// query(). Each push() makes a new SDKUserMessage available to the consumer
// (the SDK). end() terminates the iterable. Pull-before-push and push-before-pull
// are both supported.

export class PushableAsyncIterable<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private buffer: T[] = [];
  private pendingResolve: ((v: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      r({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      r({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> { return this; }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      return Promise.resolve({ value: this.buffer.shift()!, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.pendingResolve = resolve;
    });
  }
}
