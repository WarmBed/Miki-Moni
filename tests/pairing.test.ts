import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeypair, deriveSharedSecret, toBase64, fromBase64 } from "../src/crypto.js";
import {
  PairingSession,
  pairingQrPayload,
  computePeerId,
  PAIRING_TOKEN_TTL_MS,
  generateNewPairingToken,
} from "../src/pairing.js";

describe("pairingQrPayload", () => {
  it("returns an HTTPS URL pointing at the PWA, with token+relay in the URL fragment", () => {
    const kp = generateKeypair();
    const payload = pairingQrPayload({
      worker_url: "wss://example.workers.dev",
      pairing_token: "tok123",
      daemon_pubkey: toBase64(kp.pubkey),
      device_name: "mike2-pc",
    });
    expect(payload.startsWith("https://miki-moni.pages.dev/")).toBe(true);
    expect(payload).toContain("#t=tok123");
    expect(payload).toContain("r=wss%3A%2F%2Fexample.workers.dev");
  });
});

describe("computePeerId", () => {
  it("returns a deterministic 16-char id derived from pubkey", () => {
    const kp = generateKeypair();
    const id1 = computePeerId(toBase64(kp.pubkey));
    const id2 = computePeerId(toBase64(kp.pubkey));
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(16);
  });

  it("different pubkeys produce different ids", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(computePeerId(toBase64(a.pubkey))).not.toBe(computePeerId(toBase64(b.pubkey)));
  });
});

describe("PairingSession", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts in 'pending' state and produces a 16-byte base64 pairing token", () => {
    const daemonKp = generateKeypair();
    const session = new PairingSession(daemonKp.privkey, daemonKp.pubkey);
    expect(session.state).toBe("pending");
    expect(fromBase64(session.pairingToken)).toHaveLength(16);
  });

  it("handleOffer transitions to 'paired' and returns peer + pair_ack plaintext", () => {
    const daemonKp = generateKeypair();
    const phoneKp = generateKeypair();
    const session = new PairingSession(daemonKp.privkey, daemonKp.pubkey);

    const result = session.handleOffer({
      phone_pk: toBase64(phoneKp.pubkey),
      phone_name: "iPhone 15",
    });

    expect(session.state).toBe("paired");
    expect(result.peer.peer_name).toBe("iPhone 15");
    expect(result.peer.peer_pubkey).toBe(toBase64(phoneKp.pubkey));
    expect(result.peer.peer_id).toBe(computePeerId(toBase64(phoneKp.pubkey)));
    // Shared secret matches phone-side derivation
    const phoneDerived = deriveSharedSecret(phoneKp.privkey, daemonKp.pubkey);
    expect(result.peer.shared_secret).toBe(toBase64(phoneDerived));
    expect(result.pairAck.kind).toBe("pair_ack");
    expect(result.pairAck.ok).toBe(true);
  });

  it("handleOffer throws when called twice", () => {
    const daemonKp = generateKeypair();
    const phoneKp = generateKeypair();
    const session = new PairingSession(daemonKp.privkey, daemonKp.pubkey);
    session.handleOffer({ phone_pk: toBase64(phoneKp.pubkey), phone_name: "x" });
    expect(() => session.handleOffer({ phone_pk: toBase64(phoneKp.pubkey), phone_name: "y" }))
      .toThrow(/already/i);
  });

  it("isExpired() returns true after PAIRING_TOKEN_TTL_MS elapses", () => {
    const daemonKp = generateKeypair();
    const session = new PairingSession(daemonKp.privkey, daemonKp.pubkey);
    expect(session.isExpired()).toBe(false);
    vi.advanceTimersByTime(PAIRING_TOKEN_TTL_MS - 1);
    expect(session.isExpired()).toBe(false);
    vi.advanceTimersByTime(2);
    expect(session.isExpired()).toBe(true);
  });
});

describe("pairing QR payload (HTTPS + URL fragment)", () => {
  it("emits an HTTPS PWA URL with t= and r= in the fragment", () => {
    const payload = pairingQrPayload({
      worker_url: "https://relay.f1telemetrystationpro.org",
      pairing_token: "K7H2X9PNRT4BMWQ8",
      daemon_pubkey: "(unused for now)",
      device_name: "(unused)",
    });
    expect(payload.startsWith("https://miki-moni.pages.dev/")).toBe(true);
    expect(payload).toContain("#t=K7H2X9PNRT4BMWQ8");
    expect(payload).toContain("r=https%3A%2F%2Frelay.f1telemetrystationpro.org");
  });

  it("URL-encodes special characters in worker_url", () => {
    const payload = pairingQrPayload({
      worker_url: "https://relay.example.com:8443",
      pairing_token: "AAAA1111BBBB2222",
      daemon_pubkey: "x",
      device_name: "x",
    });
    expect(payload).toContain("r=https%3A%2F%2Frelay.example.com%3A8443");
  });

  it("keeps the secret token in the fragment, not the query string", () => {
    // CF/Pages access logs see ?query but never #fragment — so the token
    // never hits anyone's request log even if the URL is visited.
    const payload = pairingQrPayload({
      worker_url: "https://r.example.com",
      pairing_token: "SECRET0000000000",
      daemon_pubkey: "x",
      device_name: "x",
    });
    const url = new URL(payload);
    expect(url.search).toBe("");                  // no query
    expect(url.hash).toContain("t=SECRET0000000000");
  });
});

describe("generateNewPairingToken", () => {
  it("returns a 16-char Crockford base32 token (no hyphens)", () => {
    const t = generateNewPairingToken();
    expect(t).toHaveLength(16);
    expect(t).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/);
  });
});
