// [deskpet] Dropped recordings: hand their paths to the pet's server.
// From the main process, because the server takes them only without an Origin header, which no page can do.
import { BrowserWindow, ipcMain } from 'electron';
import { request } from 'http';

const PORT = 12393;

type Reply = { ok: boolean; message: string };

function post(paths: string[]): Promise<Reply> {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ paths }), 'utf-8');
    const fail = () => resolve({ ok: false, message: '没连上小克，重开一下再拖。' });
    const req = request({
      host: '127.0.0.1',
      port: PORT,
      path: '/deskpet/audio',
      method: 'POST',
      timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'X-Deskpet-Drop': '1' },
    }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (part: Buffer) => parts.push(part));
      res.on('error', fail);
      res.on('end', () => {
        try {
          const reply = JSON.parse(Buffer.concat(parts).toString('utf-8'));
          if (typeof reply.message === 'string') resolve({ ok: reply.ok === true, message: reply.message });
          else fail();
        } catch {
          fail();
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', fail);
    req.on('close', fail); // no effect once resolved
    req.end(body);
  });
}

export function setupAudioDrop(window: BrowserWindow): void {
  const contents = window.webContents;
  // a file or link dropped where nothing takes it would replace the pet's page, with her preload attached
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault();
  });
  ipcMain.handle('deskpet-drop-audio', (event, paths: unknown): Promise<Reply> | Reply => {
    if (event.senderFrame !== contents.mainFrame || !Array.isArray(paths)) {
      return { ok: false, message: '没收到文件。' };
    }
    const files = paths.filter((p): p is string => typeof p === 'string' && p !== '');
    if (!files.length) return { ok: false, message: '这个拿不到文件位置，先存到电脑上再拖给我。' };
    return post(files);
  });
}
