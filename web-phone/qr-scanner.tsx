// In-PWA QR scanner. Uses getUserMedia + jsQR to scan the daemon's pairing QR
// directly from the pair screen — no need for the user to leave the PWA, open
// the system camera, scan, and bounce back in.
//
// Returns the raw scanned string via onScan. Caller decides what to do (usually:
// parse as URL → extract #t=…&r=… fragment → call auto-pair).

import { useEffect, useRef, useState } from "preact/hooks";
import jsQR from "jsqr";

interface QrScannerProps {
  onScan: (text: string) => void;
  onCancel: () => void;
}

export function QrScanner({ onScan, onCancel }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // Prefer back camera on phones; falls back to whatever's available.
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        // iOS Safari needs playsInline + an explicit play() before frames arrive.
        video.setAttribute("playsinline", "true");
        await video.play();
        setReady(true);
        scanLoop();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      }
    }

    function scanLoop() {
      if (cancelled) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        rafRef.current = requestAnimationFrame(scanLoop);
        return;
      }
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w === 0 || h === 0) {
        rafRef.current = requestAnimationFrame(scanLoop);
        return;
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const code = jsQR(imageData.data, w, h, { inversionAttempts: "dontInvert" });
      if (code && code.data) {
        cleanup();
        onScan(code.data);
        return;
      }
      rafRef.current = requestAnimationFrame(scanLoop);
    }

    function cleanup() {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    void start();
    return cleanup;
  // onScan intentionally not in deps — the loop reads it via closure and we
  // tear down on unmount anyway.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div class="fixed inset-0 bg-black flex flex-col items-center justify-center z-50">
      <video
        ref={videoRef}
        class="max-w-full max-h-[70vh] rounded-lg"
        style={{ objectFit: "cover" }}
        muted
      />
      <canvas ref={canvasRef} style={{ display: "none" }} />

      <div class="text-slate-300 text-sm mt-4 px-4 text-center">
        {error
          ? `相機無法啟動：${error}`
          : ready
            ? "把 QR 框進畫面中央"
            : "啟動相機中…"}
      </div>

      <button
        class="mt-6 bg-slate-700 hover:bg-slate-600 text-slate-100 rounded px-6 py-3 text-base"
        onClick={onCancel}
      >
        取消
      </button>
    </div>
  );
}
