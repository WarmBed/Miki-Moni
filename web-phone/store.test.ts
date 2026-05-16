import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  loadOrCreateIdentity,
  loadIdentity,
  resetDbForTesting,
} from "./store.js";

beforeEach(() => {
  resetDbForTesting(new IDBFactory());
});

describe("web-phone store identity", () => {
  it("loadOrCreateIdentity generates X25519 + Ed25519 keypairs on first call", async () => {
    const id = await loadOrCreateIdentity();
    expect(id.encryption_pubkey).toBeTruthy();
    expect(id.encryption_privkey).toBeTruthy();
    expect(id.signing_pubkey).toBeTruthy();
    expect(id.signing_privkey).toBeTruthy();
    expect(id.signing_pubkey).not.toBe(id.encryption_pubkey);
  });

  it("loadOrCreateIdentity is idempotent (second call returns same keys)", async () => {
    const a = await loadOrCreateIdentity();
    const b = await loadOrCreateIdentity();
    expect(b.signing_pubkey).toBe(a.signing_pubkey);
    expect(b.encryption_pubkey).toBe(a.encryption_pubkey);
  });

  it("loadIdentity returns null when no identity stored", async () => {
    const id = await loadIdentity();
    expect(id).toBeNull();
  });
});
