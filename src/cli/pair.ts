import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
import qrcode from "qrcode-terminal";
import { loadOrInitConfig, saveConfig, addPairedPeer, removePairedPeer, type Config } from "../config.js";
import { fromBase64, toBase64 } from "../crypto.js";
import { PairingSession, pairingQrPayload, PAIRING_TOKEN_TTL_MS } from "../pairing.js";
import { encodeEnvelope, decodeEnvelope, type Plaintext } from "../relay-protocol.js";

const CONFIG_PATH = path.join(os.homedir(), ".cc-hub", "config.json");

function usage(): never {
  console.error("Usage: pnpm pair [--new | --list | --revoke <peer_id>]");
  console.error("       pnpm pair --new --worker-url=<wss://...> --token=<x-daemon-auth-token>");
  process.exit(1);
}

function parseArgs(argv: string[]): { cmd: "new" | "list" | "revoke"; workerUrl?: string; token?: string; peerId?: string } {
  const args = argv.slice(2);
  if (args.includes("--list")) return { cmd: "list" };
  const revIdx = args.indexOf("--revoke");
  if (revIdx >= 0) {
    const peerId = args[revIdx + 1];
    if (!peerId) usage();
    return { cmd: "revoke", peerId };
  }
  if (args.includes("--new")) {
    const workerUrl = args.find((a) => a.startsWith("--worker-url="))?.split("=")[1];
    const token = args.find((a) => a.startsWith("--token="))?.split("=")[1];
    return { cmd: "new", workerUrl, token };
  }
  usage();
}

async function cmdList(cfg: Config): Promise<void> {
  if (cfg.paired_peers.length === 0) {
    console.log("(no paired peers)");
    return;
  }
  for (const p of cfg.paired_peers) {
    const paired = new Date(p.paired_at).toISOString();
    console.log(`${p.peer_id}  ${p.peer_name}  paired=${paired}  last_seen=${p.last_seen_at ? new Date(p.last_seen_at).toISOString() : "never"}`);
  }
}

async function cmdRevoke(cfg: Config, peerId: string): Promise<void> {
  const before = cfg.paired_peers.length;
  const next = removePairedPeer(cfg, peerId);
  if (next.paired_peers.length === before) {
    console.error(`No peer with id ${peerId}`);
    process.exit(1);
  }
  await saveConfig(CONFIG_PATH, next);
  console.log(`Revoked peer ${peerId}`);
}

async function cmdNew(cfg: Config, workerUrlArg?: string, tokenArg?: string): Promise<void> {
  const workerUrl = workerUrlArg ?? cfg.remote?.worker_url;
  const token = tokenArg ?? cfg.remote?.x_daemon_auth_token;
  if (!workerUrl || !token) {
    console.error("Missing worker URL or daemon auth token.");
    console.error("Either pre-populate ~/.cc-hub/config.json's `remote` field, or pass:");
    console.error("  pnpm pair --new --worker-url=wss://... --token=<token>");
    process.exit(1);
  }

  const daemonPriv = fromBase64(cfg.device.privkey);
  const daemonPub = fromBase64(cfg.device.pubkey);
  const session = new PairingSession(daemonPriv, daemonPub);

  const qrPayload = pairingQrPayload({
    worker_url: workerUrl,
    pairing_token: session.pairingToken,
    daemon_pubkey: cfg.device.pubkey,
    device_name: cfg.device.name,
  });

  console.log("\nScan this QR with your phone (Happy app / cc-hub phone web client):\n");
  qrcode.generate(qrPayload, { small: true });
  console.log(`\nPairing token expires in ${PAIRING_TOKEN_TTL_MS / 60000} minutes.`);
  console.log(`Connecting to ${workerUrl} ...`);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(workerUrl, {
      headers: {
        "X-Daemon-Auth": token,
        "X-Pairing-Token": session.pairingToken,
      },
    });

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Pairing timed out"));
    }, PAIRING_TOKEN_TTL_MS);

    ws.on("open", () => { console.log("Connected. Waiting for phone to scan and offer..."); });

    ws.on("message", async (raw) => {
      try {
        const msg: Plaintext | { kind?: string; phone_pk?: string; phone_name?: string } = JSON.parse(raw.toString());
        if (!msg || typeof msg !== "object" || !("kind" in msg)) {
          console.warn("Ignoring non-plaintext message during pairing");
          return;
        }
        if (msg.kind === "pair_offer" && typeof (msg as any).phone_pk === "string" && typeof (msg as any).phone_name === "string") {
          const { peer, pairAck } = session.handleOffer({
            phone_pk: (msg as any).phone_pk,
            phone_name: (msg as any).phone_name,
          });
          // Send pair_ack (encrypted) to confirm
          const sharedSecret = fromBase64(peer.shared_secret);
          const ackEnv = encodeEnvelope(pairAck, sharedSecret, `phone:${peer.peer_id}`);
          ws.send(JSON.stringify(ackEnv));

          // Persist
          const updated = addPairedPeer({
            ...cfg,
            remote: { worker_url: workerUrl, x_daemon_auth_token: token },
          }, peer);
          await saveConfig(CONFIG_PATH, updated);

          console.log(`\n[ok] Paired ${peer.peer_name} (id=${peer.peer_id})`);
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch (err) {
        console.error("Error handling pairing message:", err);
      }
    });

    ws.on("close", () => {
      if (session.state !== "paired") {
        clearTimeout(timeout);
        reject(new Error("WebSocket closed before pairing completed"));
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const cfg = await loadOrInitConfig(CONFIG_PATH);
  switch (args.cmd) {
    case "list": await cmdList(cfg); return;
    case "revoke": await cmdRevoke(cfg, args.peerId!); return;
    case "new": await cmdNew(cfg, args.workerUrl, args.token); return;
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
