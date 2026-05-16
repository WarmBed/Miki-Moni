import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeypair, deriveSharedSecret, toBase64, fromBase64 } from "../src/crypto.js";
import {
  PairingSession,
  pairingQrPayload,
  computePeerId,
  PAIRING_TOKEN_TTL_MS,
} from "../src/pairing.js";

describe("pairingQrPayload", () => {
  it("returns a JSON string containing worker_url, pairing_token, daemon_pk, name", () => {
    const kp = generateKeypair();
    const payload = pairingQrPayload({
      worker_url: "wss://example.workers.dev",
      pairing_token: "tok123",
      daemon_pubkey: toBase64(kp.pubkey),
      device_name: "mike2-pc",
    });
    const parsed = JSON.parse(payload);
    expect(parsed.worker_url).toBe("wss://example.workers.dev");
    expect(parsed.pairing_token).toBe("tok123");
    expect(parsed.daemon_pk).toBe(toBase64(kp.pubkey));
    expect(parsed.name).toBe("mike2-pc");
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
