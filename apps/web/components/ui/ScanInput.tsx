"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Button } from "./Button";
import { Input } from "./Field";
import { Modal } from "./Modal";
import styles from "./ScanInput.module.css";

const FORMATS = ["code_128", "ean_13", "ean_8", "upc_a", "upc_e", "qr_code"];

// The browser's native detector — absent on iPhone Safari, where ZXing takes over.
interface NativeDetector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
type NativeDetectorCtor = new (opts: { formats: string[] }) => NativeDetector;

const CAMERA_ERROR = "Kameran kunde inte startas — kontrollera att sidan får använda kameran";

// Skanningsfält: a text field that takes what a handheld scanner types (the
// characters, then Enter) plus a Kamera button that decodes with the phone's
// camera. Both end in onScan(code); the field clears and keeps focus so the
// next scan can follow straight away. `inputRef` lets a routine send focus
// back to the field (Inleverans does after a typed quantity).
export function ScanInput({
  onScan,
  autoFocus = false,
  placeholder = "Skanna eller skriv en kod…",
  inputRef: externalRef,
}: {
  onScan: (code: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [value, setValue] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? ownRef;

  function submit(raw: string) {
    const code = raw.trim();
    if (code === "") return;
    setValue("");
    onScan(code);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submit(value);
  }

  return (
    <>
      <div className={styles.row}>
        <div className={styles.field}>
          <Input
            ref={inputRef}
            value={value}
            autoFocus={autoFocus}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={placeholder}
            aria-label="Skanna kod"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <Button type="button" variant="secondary" onClick={() => setCameraOpen(true)}>
          Kamera
        </Button>
      </div>
      <Modal open={cameraOpen} onClose={() => setCameraOpen(false)} title="Skanna med kameran">
        <CameraScanner
          onDecoded={(code) => {
            setCameraOpen(false);
            submit(code);
          }}
        />
      </Modal>
    </>
  );
}

// Mounted only while the dialog is open (Modal unmounts its children), so the
// camera starts on open and the cleanup stops every track on close.
function CameraScanner({ onDecoded }: { onDecoded: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Latest callback without restarting the camera when the parent re-renders.
  const onDecodedRef = useRef(onDecoded);
  onDecodedRef.current = onDecoded;

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let stopZxing: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function finish(code: string) {
      if (cancelled) return;
      cancelled = true;
      cleanup();
      onDecodedRef.current(code);
    }

    function cleanup() {
      if (timer) clearTimeout(timer);
      stopZxing?.();
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    }

    async function start() {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          media.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = media;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = media;
        await video.play().catch(() => undefined);

        const Native = (window as unknown as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
        if (Native) {
          const detector = new Native({ formats: FORMATS });
          const tick = async () => {
            if (cancelled) return;
            try {
              const found = await detector.detect(video);
              const hit = found.find((f) => f.rawValue);
              if (hit) return finish(hit.rawValue);
            } catch {
              // A frame that cannot be read is just skipped.
            }
            timer = setTimeout(tick, 150);
          };
          void tick();
        } else {
          // iPhone Safari: ZXing, loaded only now that the dialog is open.
          const { BrowserMultiFormatReader } = await import("@zxing/browser");
          if (cancelled) return;
          const controls = await new BrowserMultiFormatReader().decodeFromStream(media, video, (result) => {
            if (result) finish(result.getText());
          });
          stopZxing = () => controls.stop();
          if (cancelled) cleanup();
        }
      } catch {
        if (!cancelled) setError(CAMERA_ERROR);
      }
    }

    void start();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  return (
    <div className={styles.camera}>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : (
        <>
          <video ref={videoRef} className={styles.video} playsInline muted />
          <p className={styles.hint}>Rikta kameran mot streckkoden eller QR-koden.</p>
        </>
      )}
    </div>
  );
}
