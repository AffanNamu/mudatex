import { useRef, useState } from 'react';
import { uploadPicture } from '../lib/api';
import { shrinkPicture } from '../lib/imageResize';
import { ErrorBanner } from './ui';

/**
 * Pictures for a product or department: choose from the phone's camera or files (each is shrunk on the device, then uploaded),
 * or paste a link. The first picture is the main one. `max` limits how many.
 */
export function PictureUploader({ value, onChange, max = 12, label = 'Pictures' }: { value: string[]; onChange(next: string[]): void; max?: number; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [link, setLink] = useState('');

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setError(null);
    const added: string[] = [];
    try {
      for (const f of Array.from(files).slice(0, max - value.length)) added.push((await uploadPicture(await shrinkPicture(f))).url);
    } catch (e) { setError(e); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
    if (added.length) onChange([...value, ...added]);
  };
  const move = (i: number, by: number) => { const next = [...value]; const [x] = next.splice(i, 1); next.splice(i + by, 0, x!); onChange(next); };

  return (
    <fieldset className="pictures">
      <legend>{label}</legend>
      <ul className="plain picture-grid">
        {value.map((src, i) => (
          <li key={src}>
            <img src={src} alt={`${label}: picture ${i + 1}${i === 0 ? ' (main)' : ''}`} width={96} height={96} />
            <div className="row">
              {i > 0 ? <button type="button" className="btn btn-ghost" onClick={() => move(i, -1)} aria-label={`Move picture ${i + 1} earlier`}>←</button> : <span className="chip">Main</span>}
              {i < value.length - 1 && <button type="button" className="btn btn-ghost" onClick={() => move(i, 1)} aria-label={`Move picture ${i + 1} later`}>→</button>}
              <button type="button" className="btn btn-ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove picture ${i + 1}`}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
      {value.length < max && (
        <div className="row">
          <label className="btn">
            {busy ? 'Uploading…' : value.length ? 'Add pictures' : 'Choose pictures'}
            <input ref={input} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={(e) => void add(e.target.files)} aria-label={`${label}: choose files`} />
          </label>
          <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="or paste a picture link (https://…)" aria-label="Picture link" />
          <button type="button" className="btn" disabled={!/^https:\/\//.test(link)} onClick={() => { onChange([...value, link.trim()]); setLink(''); }}>Add link</button>
        </div>
      )}
      <ErrorBanner error={error} />
    </fieldset>
  );
}
