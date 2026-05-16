import WebSocket from "ws";
import qrcode from "qrcode-terminal";
import { createHash } from "node:crypto";
import {
  loadOrInitConfig,
  saveConfig,
  addPairedPeer,
  removePairedPeer,
  type Config,
  type PairedPeer,
} from "../config.js";
import {
  fromBase64,
  toBase64,
  deriveSharedSecret,
  sign as signMsg,
} from "../crypto.js";
import {
  generateNewPairingToken,
  pairingQrPayload,
  computePeerId,
  PAIRING_TOKEN_TTL_MS,
} from "../pairing.js";
import { CONFIG_FILE as CONFIG_PATH } from "../data-dir.js";

function usage(): never {
  console.error("Usage: pnpm pair [--new | --list | --revoke <peer_id>]");
  console.error("       pnpm pair --new --worker-url=<wss://...>");
  console.error("");
  console.error("If --worker-url is omitted, reads from ~/.miki-moni/config.json:remote.worker_url");
  process.exit(1);
}

function parseArgs(argv: string[]): {
  cmd: "new" | "list" | "revoke";
  workerUrl?: string;
  peerId?: string;
  name?: string;
} {
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
    const name = args.find((a) => a.startsWith("--name="))?.split("=")[1];
    return { cmd: "new", workerUrl, name };
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
    console.log(
      `${p.peer_id}  ${p.peer_name}  paired=${paired}  last_seen=${
        p.last_seen_at ? new Date(p.last_seen_at).toISOString() : "never"
      }`,
    );
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

/** Bytes the daemon must sign in response to a challenge:
 *  nonce (32B) ++ issued_at_ms (8B big-endian). Matches worker's
 *  handshake.ts:buildChallengeMessage exactly. */
function buildChallengeMessage(nonce: Uint8Array, issuedAtMs: number): Uint8Array {
  const out = new Uint8Array(nonce.length + 8);
  out.set(nonce, 0);
  new DataView(out.buffer, nonce.length, 8).setBigUint64(0, BigInt(issuedAtMs), false);
  return out;
}

async function cmdNew(cfg: Config, workerUrlArg?: string): Promise<void> {
  const workerUrl = workerUrlArg ?? cfg.remote?.worker_url;
  if (!workerUrl) {
    console.error("Missing worker URL.");
    console.error("Either set `remote.worker_url` in ~/.miki-moni/config.json, or pass:");
    console.error("  pnpm pair --new --worker-url=wss://relay.f1telemetrystationpro.org");
    process.exit(1);
  }

  // Daemon-side Ed25519 (signing) + X25519 (encryption) keys from config.
  const signPriv = fromBase64(cfg.device.signing_privkey);
  const signPub = fromBase64(cfg.device.signing_pubkey);
  const encPriv = fromBase64(cfg.device.privkey);
  const encPub = fromBase64(cfg.device.pubkey);
  const daemonId = createHash("sha256").update(signPub).digest("hex").slice(0, 32);

  // 16-char Crockford base32 token shown in QR + manual entry.
  const pairingToken = generateNewPairingToken();
  const qrPayload = pairingQrPayload({
    worker_url: workerUrl,
    pairing_token: pairingToken,
    daemon_pubkey: cfg.device.pubkey,
    device_name: cfg.device.name,
  });

  // Daemon-side WS hits /v1/daemon endpoint. Append path if caller passed bare host.
  const wsUrl = workerUrl.replace(/\/$/, "").includes("/v1/")
    ? workerUrl.replace(/\/$/, "")
    : `${workerUrl.replace(/\/$/, "")}/v1/daemon`;

  console.log(`\nConnecting to ${wsUrl} ...`);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        "X-Daemon-Pubkey": cfg.device.signing_pubkey,
        "X-Daemon-Id": daemonId,
      },
    });

    let ready = false;
    let printedQr = false;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Pairing timed out after ${PAIRING_TOKEN_TTL_MS / 60_000} min`));
    }, PAIRING_TOKEN_TTL_MS);

    ws.on("open", () => { /* wait for challenge */ });

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // --- Challenge-response handshake ---
      if (!ready && msg.type === "challenge") {
        const nonce = fromBase64(msg.nonce);
        const sigMsg = buildChallengeMessage(nonce, msg.issued_at_ms);
        const sig = signMsg(sigMsg, signPriv);
        ws.send(JSON.stringify({ type: "challenge_response", sig: toBase64(sig) }));
        return;
      }
      if (!ready && msg.type === "ready") {
        ready = true;
        // Register this pairing token with the coordinator so the phone can claim it.
        ws.send(JSON.stringify({ type: "register_pairing", token: pairingToken }));
        if (!printedQr) {
          printedQr = true;
          console.log("Ready. Scan this QR with your phone:\n");
          qrcode.generate(qrPayload, { small: true });
          console.log("\nOr type this 16-char code (case-insensitive, dashes optional):\n");
          const grouped = pairingToken.match(/.{1,4}/g)?.join("-") ?? pairingToken;
          console.log(`  ${grouped}\n`);
          console.log(`Pairing URL: ${qrPayload}`);
          console.log(`Token expires in ${PAIRING_TOKEN_TTL_MS / 60_000} min.\n`);
          console.log("Waiting for phone to scan and complete pairing...");
        }
        return;
      }

      // --- Phone offer arrives via DO ---
      if (ready && msg.type === "pair_offer") {
        const phonePubB64 = msg.phone_pubkey as string;
        if (typeof phonePubB64 !== "string") {
          console.warn("pair_offer missing phone_pubkey, ignoring");
          return;
        }
        const phonePub = fromBase64(phonePubB64);
        const sharedSecret = deriveSharedSecret(encPriv, phonePub);
        const peer: PairedPeer = {
          peer_id: computePeerId(phonePubB64),
          peer_name: typeof msg.phone_name === "string" ? msg.phone_name : "phone",
          peer_pubkey: phonePubB64,
          shared_secret: toBase64(sharedSecret),
          paired_at: Date.now(),
          last_seen_at: null,
        };

        // Acknowledge to phone (worker DO will route this back).
        ws.send(JSON.stringify({ type: "pair_ack", daemon_id: daemonId }));

        // Persist.
        const updated = addPairedPeer(
          { ...cfg, remote: { worker_url: workerUrl } },
          peer,
        );
        await saveConfig(CONFIG_PATH, updated);

        console.log(`\n[ok] Paired ${peer.peer_name} (id=${peer.peer_id})`);
        console.log("You can now restart the daemon — it will auto-connect to the relay.");
        clearTimeout(timeout);
        ws.close();
        resolve();
        return;
      }
    });

    ws.on("close", (code) => {
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`WebSocket closed before handshake (code ${code})`));
      }
      // After ready but before pair_offer arrived — caller's timeout handles it.
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
    case "list":
      await cmdList(cfg);
      return;
    case "revoke":
      await cmdRevoke(cfg, args.peerId!);
      return;
    case "new":
      await cmdNew(cfg, args.workerUrl);
      return;
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
