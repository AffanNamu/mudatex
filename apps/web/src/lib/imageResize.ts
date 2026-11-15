/** The size a picture should be shrunk to: its longest side at most `max`, never enlarged, aspect ratio kept. */
export function fitWithin(width: number, height: number, max = 1600): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 1, height: 1 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export const MAX_UPLOAD_BYTES = 1_900_000;

/** Shrinks a photo on the device (phone photos are several megabytes) and returns a WebP, or a JPEG where the browser cannot make WebP. */
export async function shrinkPicture(file: File, max = 1600): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) throw new Error('Choose a JPEG, PNG or WebP picture.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('This picture could not be read. Try a JPEG or PNG.'); }
  let { width, height } = fitWithin(bitmap.width, bitmap.height, max);
  const canvas = document.createElement('canvas');
  const draw = (w: number, h: number, opaque: boolean) => {
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d')!;
    if (opaque) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }
    g.drawImage(bitmap, 0, 0, w, h);
  };
  const encode = (type: string, quality: number) => new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, quality));
  for (let attempt = 0; attempt < 4; attempt++) {
    draw(width, height, false);
    let blob = await encode('image/webp', 0.82);
    if (!blob || blob.type !== 'image/webp') { draw(width, height, true); blob = await encode('image/jpeg', 0.85); }
    if (blob && blob.size <= MAX_UPLOAD_BYTES) { bitmap.close(); return blob; }
    ({ width, height } = fitWithin(width, height, Math.round(Math.max(width, height) * 0.75)));
  }
  bitmap.close();
  throw new Error('This picture is too large even after shrinking. Try a smaller one.');
}
