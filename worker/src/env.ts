// Bindings exposed by wrangler.toml to the Worker runtime.
export interface Env {
  PAIRING: DurableObjectNamespace;
  RELAY: DurableObjectNamespace;
  RATE_LIMITER: RateLimit;
}

// CF rate-limit binding (not in workers-types yet).
export interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}
