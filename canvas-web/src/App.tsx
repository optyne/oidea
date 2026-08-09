import React, { useEffect, useRef, useState } from 'react';
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { initBridge, emit, type BridgeInit } from './bridge';
import { getPage, savePage } from './api';
import { SaveLoop } from './save_loop';

// scene JSON（v1 不含 files/嵌圖）
const serializeScene = (api: any): string =>
  JSON.stringify({ type: 'excalidraw', version: 2, elements: api.getSceneElements() });

const toBase64 = (s: string): string => btoa(unescape(encodeURIComponent(s)));
const fromBase64 = (b: string): string => decodeURIComponent(escape(atob(b)));

export default function App() {
  const apiRef = useRef<any>(null);
  const initRef = useRef<BridgeInit | null>(null);
  const loopRef = useRef<SaveLoop | null>(null);
  const lastThumbAtRef = useRef(0);
  const [phase, setPhase] = useState<'waiting' | 'loading' | 'ready' | 'loadFailed'>('waiting');
  const [initialData, setInitialData] = useState<any>(null);
  const [stylusOnly, setStylusOnly] = useState(false);
  const stylusOnlyRef = useRef(false);
  const [sync, setSync] = useState<'saved' | 'dirty' | 'error'>('saved');

  const load = async (init: BridgeInit) => {
    setPhase('loading');
    try {
      const page = await getPage(init);
      let scene: any = { elements: [] };
      if (page.drawing) scene = JSON.parse(fromBase64(page.drawing));
      setInitialData({ elements: scene.elements ?? [] });
      setPhase('ready');
    } catch {
      // 載入失敗絕不進編輯 —— 空白場景 + 自動存檔會覆寫伺服器內容
      setPhase('loadFailed');
    }
  };

  useEffect(() => {
    initBridge((init) => {
      initRef.current = init;
      loopRef.current = new SaveLoop({
        save: async () => {
          const api = apiRef.current;
          const at = initRef.current;
          if (!api || !at) return false;
          try {
            const drawing = toBase64(serializeScene(api));
            let thumbnail: string | undefined;
            if (Date.now() - lastThumbAtRef.current > 30000) {
              const blob = await exportToBlob({
                elements: api.getSceneElements(),
                // SPIKE.md：整包 api.getAppState() 的 exportScale 預設跟隨 devicePixelRatio，
                // 高 DPR 裝置會讓輸出遠超過 maxWidthOrHeight 的直覺上限（實測 DPR=2 產出
                // 680x200 而非 ≤512）。強制 exportScale: 1 讓 maxWidthOrHeight 真正生效。
                appState: { ...api.getAppState(), exportScale: 1 },
                files: api.getFiles(),
                mimeType: 'image/png',
                maxWidthOrHeight: 512,
              });
              const buf = new Uint8Array(await blob.arrayBuffer());
              let bin = '';
              buf.forEach((b) => (bin += String.fromCharCode(b)));
              thumbnail = btoa(bin);
            }
            await savePage(at, drawing, thumbnail);
            if (thumbnail) lastThumbAtRef.current = Date.now();
            return true;
          } catch {
            return false;
          }
        },
      });
      loopRef.current.onState = (s) => {
        if (s === 'saved') { setSync('saved'); emit('saved'); }
        else if (s === 'error') { setSync('error'); emit('error'); }
        else if (s === 'dirty') { setSync('dirty'); emit('dirty'); }
      };
      void load(init);
    });

    const forceSave = () => void loopRef.current?.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') forceSave();
    };
    window.addEventListener('pagehide', forceSave);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', forceSave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // stylusOnly：capture 阶段擋掉非 pen 的「落墨」——手指仍可平移/縮放（Excalidraw 多指手勢不經此路徑）
  useEffect(() => {
    stylusOnlyRef.current = stylusOnly;
  }, [stylusOnly]);
  useEffect(() => {
    const guard = (e: PointerEvent) => {
      if (!stylusOnlyRef.current) return;
      if (e.pointerType === 'touch' && e.isPrimary) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const root = document.getElementById('root')!;
    root.addEventListener('pointerdown', guard, { capture: true });
    return () => root.removeEventListener('pointerdown', guard, { capture: true });
  }, []);

  if (phase === 'waiting' || phase === 'loading') {
    return <p style={{ padding: 16 }}>載入中…</p>;
  }
  if (phase === 'loadFailed') {
    return (
      <div style={{ padding: 16 }}>
        <p>頁面載入失敗</p>
        <button onClick={() => initRef.current && load(initRef.current)}>重試</button>
      </div>
    );
  }
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 8, padding: 4, fontSize: 12, alignItems: 'center' }}>
        <label>
          <input type="checkbox" checked={stylusOnly} onChange={(e) => setStylusOnly(e.target.checked)} />
          僅觸控筆（防手掌）
        </label>
        <span>{sync === 'saved' ? '已儲存' : sync === 'dirty' ? '編輯中…' : '⚠️ 未同步，重試中'}</span>
      </div>
      <div style={{ flex: 1 }}>
        <Excalidraw
          excalidrawAPI={(api) => (apiRef.current = api)}
          initialData={initialData}
          onChange={() => loopRef.current?.markDirty()}
        />
      </div>
    </div>
  );
}
