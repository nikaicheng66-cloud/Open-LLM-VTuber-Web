// [deskpet] Pictures the user gives her: pasted into the chat box, dropped on her or the bubble, or
// picked with the picture button. Each is shrunk here in the page and goes out with the user's
// words as part of the ordinary `text-input` message (the `images` field the server already has).
//
// Why shrink: her chat model reads a picture as roughly (width / 28) x (height / 28) tokens and has
// a small context, so all pictures of one message share one budget of pixels. That is why the
// shrinking happens when the message goes out, not when a picture is attached.

export type PictureSource = 'upload' | 'clipboard';

/** A picture waiting beside the typing box. */
export interface WaitingPicture {
  file: Blob;
  source: PictureSource;
  thumb: string; // small one for the bubble
}

/** A picture as it goes out. */
export interface PetPicture {
  source: PictureSource;
  data: string; // data:image/jpeg;base64,...  what she looks at
  mime_type: string;
  thumb: string;
}

export const MAX_PICTURES = 4;
export const PICTURE_ONLY_TEXT = '看看这张图片'; // sent when a picture comes without words
const PIXELS = 1280 * 720; // shared by the pictures of one message (~900 tokens)
const LONGEST = 1568;
const THUMB = 96;
const TYPES = /^image\/(png|jpe?g|webp|gif|bmp)$/i;
const NAMES = /\.(png|jpe?g|jfif|webp|gif|bmp)$/i;

export const isPicture = (f: { type?: string; name?: string }): boolean => (
  f.type ? TYPES.test(f.type) : NAMES.test(f.name ?? '')
);

function draw(bitmap: ImageBitmap, scale: number, quality: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.fillStyle = '#fff'; // JPEG has no transparency: a see-through PNG would turn black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

const thumbOf = (bitmap: ImageBitmap) => draw(bitmap, Math.min(1, THUMB / Math.max(bitmap.width, bitmap.height)), 0.7);

/** Files to keep beside the typing box: the ones that open as pictures, at most `room` of them. */
export async function readPictures(
  files: Blob[],
  source: PictureSource,
  room: number = MAX_PICTURES,
): Promise<{ waiting: WaitingPicture[]; failed: number }> {
  const waiting: WaitingPicture[] = [];
  let failed = 0;
  for (const file of files) {
    let bitmap: ImageBitmap | null = null;
    try {
      if (waiting.length >= room) throw new Error('full');
      bitmap = await createImageBitmap(file);
      waiting.push({ file, source, thumb: thumbOf(bitmap) });
    } catch {
      failed += 1;
    } finally {
      bitmap?.close();
    }
  }
  return { waiting, failed };
}

/** Shrinks the pictures of one message so that together they fit her; `failed` = could not be read. */
export async function preparePictures(
  items: { file: Blob; source: PictureSource }[],
): Promise<{ pictures: PetPicture[]; failed: number }> {
  const taken = items.slice(0, MAX_PICTURES);
  const pictures: PetPicture[] = [];
  let failed = items.length - taken.length;
  const budget = PIXELS / Math.max(1, taken.length);
  for (const { file, source } of taken) {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file);
      const scale = Math.min(
        1,
        Math.sqrt(budget / (bitmap.width * bitmap.height)),
        LONGEST / Math.max(bitmap.width, bitmap.height),
      );
      pictures.push({
        source,
        data: draw(bitmap, scale, 0.9),
        mime_type: 'image/jpeg',
        thumb: thumbOf(bitmap),
      });
    } catch {
      failed += 1;
    } finally {
      bitmap?.close();
    }
  }
  return { pictures, failed };
}

// Dropped on the bubble: the drop handler (audio-drop.tsx) hands the files to the bubble
// (pet-chat.tsx), which keeps them beside the typing box until the user presses Enter.
const ATTACH = 'deskpet-attach-pictures';

export function attachToBubble(files: Blob[]): void {
  window.dispatchEvent(new CustomEvent(ATTACH, { detail: files }));
}

export function onAttachToBubble(take: (files: Blob[]) => void): () => void {
  const handler = (e: Event) => take((e as CustomEvent<Blob[]>).detail ?? []);
  window.addEventListener(ATTACH, handler);
  return () => window.removeEventListener(ATTACH, handler);
}
