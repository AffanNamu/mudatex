import { useEffect, useRef, useState, type FormEvent } from 'react';

interface Detector { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> }
declare global { interface Window { BarcodeDetector?: new (opts?: { formats?: string[] }) => Detector } }

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];
const cameraSupported = () => typeof window !== 'undefined' && !!window.BarcodeDetector && !!navigator.mediaDevices?.getUserMedia;

/**
 * A code box for a barcode scanner (they type the code and press Enter), for typing by hand, and — where the phone's
 * browser can read barcodes — for the camera. The same code in quickly twice is read once.
 */
export function ScanBox({ onCode, label = 'Scan or type a code', disabled = false }: { onCode(code: string): void; label?: string; disabled?: boolean }) {
  const [text, setText] = useState('');
  const [camera, setCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const latest = useRef(onCode);
  latest.current = onCode;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = text.trim();
    if (code) { latest.current(code); setText(''); }
  };

  useEffect(() => {
    if (!camera) return;
    let stop = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stop) { stream.getTracks().forEach((t) => t.stop()); return; }
        const el = video.current;
        if (!el) return;
        el.srcObject = stream;
        await el.play();
        const detector = new window.BarcodeDetector!({ formats: FORMATS });
        let last = '';
        let lastAt = 0;
        timer = setInterval(async () => {
          if (el.readyState < 2) return;
          try {
            const found = await detector.detect(el);
            const code = found[0]?.rawValue;
            if (code && (code !== last || Date.now() - lastAt > 2000)) {
              last = code; lastAt = Date.now();
              navigator.vibrate?.(60);
              latest.current(code);
            }
          } catch { /* a frame that cannot be read is skipped */ }
        }, 250);
      } catch {
        setCameraError('The camera could not be opened. Allow camera access for this site, or type the code instead.');
        setCamera(false);
      }
    })();
    return () => { stop = true; if (timer) clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [camera]);

  return (
    <div className="scanbox">
      <form onSubmit={submit} className="scan-row">
        <label className="field scan-field">
          <span className="field-label">{label}</span>
          <input value={text} onChange={(e) => setText(e.target.value)} inputMode="text" autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={disabled} />
        </label>
        <button className="btn btn-primary" disabled={disabled || !text.trim()}>Find</button>
        {cameraSupported() && <button type="button" className="btn" onClick={() => { setCameraError(null); setCamera((c) => !c); }} aria-pressed={camera}>{camera ? 'Stop camera' : 'Camera'}</button>}
      </form>
      {cameraError && <div role="alert" className="banner banner-error">{cameraError}</div>}
      {camera && <video ref={video} className="scan-video" playsInline muted aria-label="Camera view for scanning a barcode" />}
    </div>
  );
}
