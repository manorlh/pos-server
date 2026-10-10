'use client';

/**
 * The browser kiosk's camera scan — only where the browser has a barcode reader of its own
 * (`BarcodeDetector`: Chrome / Edge on Android, ChromeOS, macOS; not Safari, not Firefox, not
 * Chrome on Windows): a voucher's QR or Code 128 read off the device's camera. Anywhere else the
 * button is not shown and the customer types the code (or a HID scanner reads it).
 */

import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { cardStyle, type PreviewModel } from '@/kiosk-shared';

interface DetectedCode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedCode[]>;
}

type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

function detectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!ctor || !navigator.mediaDevices?.getUserMedia) return null;
  return ctor;
}

/** Can this browser read a barcode off its camera. */
export function cameraScanAvailable(): boolean {
  return detectorCtor() !== null;
}

export function CameraScanButton({ m, label, onClick }: { m: PreviewModel; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-2 px-4 py-3 kt-15 font-semibold transition-transform duration-150 active:scale-[0.98]"
      style={{ border: `1.5px dashed ${m.c.border}`, color: m.c.text, borderRadius: m.btnRadius }}
    >
      <Camera className="h-5 w-5" style={{ color: m.c.primary }} />
      {label}
    </button>
  );
}

export function CameraScanner({ m, title, hint, denied, onCode, onClose }: { m: PreviewModel; title: string; hint: string; denied: string; onCode: (raw: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const onCodeRef = useRef(onCode);
  useEffect(() => {
    onCodeRef.current = onCode;
  });

  useEffect(() => {
    const Ctor = detectorCtor();
    if (!Ctor) return;
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let stopped = false;
    const detector = new Ctor({ formats: ['qr_code', 'code_128', 'data_matrix', 'code_39', 'ean_13'] });
    const stop = () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    const loop = async () => {
      if (stopped || !video.current) return;
      try {
        if (video.current.readyState >= 2) {
          const found = await detector.detect(video.current);
          const hit = found.find((c) => c.rawValue && c.rawValue.trim());
          if (hit && !done.current) {
            done.current = true;
            stop();
            onCodeRef.current(hit.rawValue);
            return;
          }
        }
      } catch {
        /* a frame it could not read */
      }
      timer = window.setTimeout(() => void loop(), 250);
    };
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play().catch(() => undefined);
        }
        void loop();
      })
      .catch(() => setError(denied));
    return stop;
  }, [denied]);

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/60 p-5">
      <div className="w-full max-w-[460px] space-y-3 p-4 text-center shadow-2xl" style={{ ...cardStyle(m), background: m.c.surface, color: m.c.text }}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-lg font-extrabold">{title}</span>
          <button type="button" aria-label="close" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: `${m.c.button}1A`, color: m.c.button }}>
            <X className="h-5 w-5" />
          </button>
        </div>
        {error ? (
          <p className="p-3 kt-13 font-semibold" style={{ background: '#FEE2E2', color: '#B91C1C', borderRadius: 12 }}>
            {error}
          </p>
        ) : (
          <>
            <video ref={video} playsInline muted className="aspect-[4/3] w-full bg-black object-cover" style={{ borderRadius: Math.min(m.radius, 14) }} />
            <p className="kt-13" style={{ color: m.c.mutedText }}>
              {hint}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
