# Deploying miki-moni Relay

miki-moni's remote control feature needs a tiny Cloudflare Worker between your daemon (laptop) and your phone/browser. You have two options.

## Option A — Use the hosted relay (recommended for most users)

Hosted at **`relay.f1telemetrystationpro.org`**. Default for the daemon. Zero setup.

The hosted relay is end-to-end encrypted. Even the operator (us) literally cannot read your messages or transcripts — the server only sees opaque encrypted blobs and routes them between your paired devices.

```bash
# Your daemon already points at relay.f1telemetrystationpro.org by default. Just run:
miki claude       # or whatever your CLI invocation is
# Scan the QR or copy the 16-char code into the phone app.
```

## Option B — Self-host on your own Cloudflare account (free tier OK)

Some users prefer their own infrastructure. Cloudflare Workers free tier (100k req/day) handles this trivially.

### Prerequisites

- A free Cloudflare account: <https://dash.cloudflare.com/sign-up>
- `wrangler` CLI: `npm install -g wrangler`

### Steps

```bash
git clone https://github.com/miki-moni/miki-moni
cd miki-moni/worker

# 1. Log into Cloudflare
wrangler login

# 2. (Optional) edit wrangler.toml to use a custom domain you own.
#    To use the free *.workers.dev subdomain instead, delete the `routes = [...]` block.

# 3. Deploy
wrangler deploy
```

Output will show your live URL — either `https://miki-relay.<your-account>.workers.dev` or `https://miki.your-domain.com`.

### Point your daemon at your own relay

```bash
miki config set remote.worker_url https://miki-relay.<your-account>.workers.dev
```

That's it. Same QR / 16-char pairing flow as the hosted version.

## What the Worker stores

- **Pending pairing tokens** for up to 10 minutes (auto-deleted on claim or TTL)
- **Per-daemon WS connections** (RAM only, recovered via Hibernating WS API)
- **Phone-side public keys** of paired devices so reconnect signatures can be verified

It does NOT store:
- Message content (ciphertext is forwarded byte-for-byte and never persisted)
- Transcripts
- Email, IP, or user identifiers
- Any logs containing message bodies
