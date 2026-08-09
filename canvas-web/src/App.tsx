import React, { useRef, useState } from 'react';
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

// ── Spike 探針版：驗證 (a) 橋握手+存讀 (b) exportToBlob (c) pointer 事件（筆壓/pointerType）──
// 正式版在 Task 4 重寫；此檔僅供 SPIKE.md 取證。

type InitMsg = { type: 'init'; token: string; boardId: string; pageId: string; apiBase: string };

export default function App() {
  const apiRef = useRef<any>(null);
  const initRef = useRef<InitMsg | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const say = (s: string) => setLog((l) => [...l.slice(-8), s]);

  React.useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (d?.type !== 'init') return;
      initRef.current = d;
      say(`init 收到 boardId=${d.boardId}`);
      const res = await fetch(`${d.apiBase}/whiteboard/${d.boardId}/pages/${d.pageId}`, {
        headers: { Authorization: `Bearer ${d.token}` },
      });
      say(`載入頁 HTTP ${res.status}`);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage(JSON.stringify({ type: 'ready' }), '*');
    (window as any).OideaBridge?.postMessage(JSON.stringify({ type: 'ready' }));
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // 探針 (c)：記錄 pointerType 與 pressure —— Android 實機看這裡
  React.useEffect(() => {
    const probe = (e: PointerEvent) =>
      say(`pointer ${e.pointerType} p=${e.pressure.toFixed(2)}`);
    window.addEventListener('pointerdown', probe, { capture: true });
    return () => window.removeEventListener('pointerdown', probe, { capture: true });
  }, []);

  const saveProbe = async () => {
    const d = initRef.current;
    const api = apiRef.current;
    if (!d || !api) return say('尚未 init');
    const elements = api.getSceneElements();
    const scene = JSON.stringify({ type: 'excalidraw', version: 2, elements });
    const drawing = btoa(unescape(encodeURIComponent(scene)));
    const blob = await exportToBlob({
      elements,
      appState: api.getAppState(),
      files: api.getFiles(),
      mimeType: 'image/png',
      maxWidthOrHeight: 512,
    });
    const thumb = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
    const res = await fetch(`${d.apiBase}/whiteboard/${d.boardId}/pages/${d.pageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.token}` },
      body: JSON.stringify({ drawing, thumbnail: thumb }),
    });
    say(`存檔+縮圖 HTTP ${res.status}`);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 4, fontSize: 12, background: '#eee' }}>
        <button onClick={saveProbe}>探針：存檔+縮圖</button> {log.join(' | ')}
      </div>
      <div style={{ flex: 1 }}>
        <Excalidraw excalidrawAPI={(api) => (apiRef.current = api)} />
      </div>
    </div>
  );
}
