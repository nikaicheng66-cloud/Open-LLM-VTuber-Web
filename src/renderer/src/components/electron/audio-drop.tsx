/* eslint-disable no-underscore-dangle */
// [deskpet] Drop a recording on her, or on her chat box; a small bubble shows how far she is.
// Pictures can be dropped the same way: on her she looks at once, on the chat box they wait beside
// the typing box for the user's question (utils/pet-pictures.ts).
//
// In pet mode the window covers the screen and lets the mouse through, except while it is over her or
// the box. A file drag sends no mousemove to the window it is over, so dragover replays one: the hover
// logic then gives the desktop its mouse back as soon as the file is carried past her.
import { useEffect, useRef, useState } from 'react';
import { useMode } from '@/context/mode-context';
import { wsService } from '@/services/websocket-service';
import { useTextInput } from '@/hooks/footer/use-text-input';
import { attachToBubble, isPicture, preparePictures } from '@/utils/pet-pictures';
import { LAppDelegate } from '../../../WebSDK/src/lappdelegate';

const FINAL_MS = 15000;
const HINT_MS = 800; // dragover repeats all the time during a drag: silence = it ended without a dragleave
const WIDTH = 300;

function onHer(x: number, y: number): boolean {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const model = (window as any).getLAppAdapter?.()?.getModel?.();
  const view: any = LAppDelegate.getInstance()?.getView?.();
  if (!canvas || !model || !view) return false;
  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / canvas.clientWidth;
  const mx = view._deviceToScreen.transformX((x - rect.left) * scale);
  const my = view._deviceToScreen.transformY((y - rect.top) * scale);
  return model.anyhitTest(mx, my) !== null || model.isHitOnModel(mx, my);
}

function replayMove(x: number, y: number, target: Element | null): void {
  target?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
}

export function AudioDrop(): JSX.Element | null {
  const { mode } = useMode();
  const isPet = mode === 'pet';
  const [over, setOver] = useState<'' | 'hear' | 'see'>('');
  const [note, setNote] = useState('');
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout>>();
  const hintTimer = useRef<ReturnType<typeof setTimeout>>();
  const { sendText } = useTextInput();
  const send = useRef(sendText); // the listeners below are set up once; this one changes every render
  send.current = sendText;

  const show = (text: string, final: boolean) => {
    clearTimeout(clearTimer.current);
    setNote(text);
    if (final) clearTimer.current = setTimeout(() => setNote(''), FINAL_MS);
  };

  useEffect(() => {
    const subscription = wsService.onMessage((message: any) => {
      if (message.type === 'audio-note') show(String(message.text ?? ''), message.final === true);
    });
    return () => {
      subscription.unsubscribe();
      clearTimeout(clearTimer.current);
    };
  }, []);

  useEffect(() => {
    const api = window.api as any;
    if (!api?.dropAudio) return undefined; // the web page has no file paths

    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    // while it is still being carried only the kinds are known, not the files
    const onlyPictures = (e: DragEvent) => {
      const items = Array.from(e.dataTransfer?.items ?? []).filter((i) => i.kind === 'file');
      return items.length > 0 && items.every((i) => isPicture({ type: i.type }));
    };

    // window mode: anywhere. Pet mode: her or the box; everywhere else is the user's desktop.
    const takes = (e: DragEvent) => {
      if (!isPet) return true;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      return !!under?.closest('[data-audio-drop]') || onHer(e.clientX, e.clientY);
    };

    const onDrag = (e: DragEvent) => {
      if (isPet) replayMove(e.clientX, e.clientY, document.elementFromPoint(e.clientX, e.clientY));
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const ok = takes(e);
      if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? 'copy' : 'none';
      setOver(!ok ? '' : onlyPictures(e) ? 'see' : 'hear');
      clearTimeout(hintTimer.current);
      if (ok) hintTimer.current = setTimeout(() => setOver(''), HINT_MS);
      if (ok) setAt({ x: e.clientX, y: e.clientY });
    };

    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget) return; // only between two elements of this page
      setOver('');
      // left the window or Esc: no mouseleave follows, so release the mouse here
      if (isPet) replayMove(-99999, -99999, document.getElementById('canvas'));
    };

    const onDrop = (e: DragEvent) => {
      setOver('');
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!takes(e)) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      setAt({ x: e.clientX, y: e.clientY });
      if (!files.length) {
        show('这个拿不到文件，先存到电脑上再拖给我。', true);
        return;
      }
      const images = files.filter(isPicture);
      const others = files.filter((f) => !isPicture(f));
      const onBubble = !!document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-pet-bubble]');
      if (images.length && onBubble) {
        attachToBubble(images); // they wait beside the typing box for the user's question
      } else if (images.length) { // on her: she looks at once
        preparePictures(images.map((file) => ({ file, source: 'upload' as const })))
          .then(({ pictures, failed }) => {
            if (failed) show(pictures.length ? `有 ${failed} 张图片没看成（打不开，或一次超过四张）。` : '这张图片我打不开。', true);
            if (pictures.length) send.current('', pictures);
          })
          .catch(() => show('没接住这张图片，再拖一次试试。', true));
      }
      if (!others.length) return;
      api.dropAudio(others)
        // accepted: the server's progress notes take over, and they may already be here
        .then((reply: { ok: boolean; message: string }) => { if (!reply.ok) show(reply.message, true); })
        .catch(() => show('没接住这个文件，再拖一次试试。', true));
    };

    document.addEventListener('dragenter', onDrag, true);
    document.addEventListener('dragover', onDrag, true);
    document.addEventListener('dragleave', onLeave, true);
    document.addEventListener('drop', onDrop, true);
    return () => {
      clearTimeout(hintTimer.current);
      setOver('');
      document.removeEventListener('dragenter', onDrag, true);
      document.removeEventListener('dragover', onDrag, true);
      document.removeEventListener('dragleave', onLeave, true);
      document.removeEventListener('drop', onDrop, true);
    };
  }, [isPet]);

  const text = over === 'see' ? '松手，让我看看' : over === 'hear' ? '松手，让我听听' : note;
  if (!text) return null;

  const x = at?.x ?? window.innerWidth / 2;
  const y = at?.y ?? window.innerHeight / 2;
  return (
    <div
      id="audio-drop-note"
      style={{
        position: 'fixed',
        left: Math.max(8, Math.min(x + 20, window.innerWidth - WIDTH - 8)),
        top: Math.max(8, Math.min(y + 20, window.innerHeight - 180)),
        maxWidth: WIDTH,
        padding: '8px 12px',
        borderRadius: 10,
        background: 'rgba(0, 0, 0, 0.78)',
        color: '#fff',
        fontSize: 13,
        lineHeight: 1.5,
        whiteSpace: 'pre-line',
        overflowWrap: 'anywhere',
        zIndex: 2000,
        pointerEvents: 'none', // never takes the mouse from the desktop
      }}
    >
      {text}
    </div>
  );
}
