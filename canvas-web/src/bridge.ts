/**
 * 與宿主的橋。兩種傳輸同時支援：
 * - iframe（Flutter web）：window.parent.postMessage / window 'message' 事件
 * - WebView（Android/iPad）：window.OideaBridge JS channel（webview_flutter 注入）
 * token 只在 init 訊息內傳遞，不進 URL。
 */
export type BridgeInit = { token: string; boardId: string; pageId: string; apiBase: string };
export type BridgeEvent = 'dirty' | 'saved' | 'error';

declare global {
  interface Window {
    OideaBridge?: { postMessage(msg: string): void };
  }
}

export function initBridge(onInit: (init: BridgeInit) => void): void {
  let received = false;
  window.addEventListener('message', (e: MessageEvent) => {
    // 只接受同源宿主（iframe 生產情境）或 WebView 合成事件（origin 為空字串）
    if (e.origin !== '' && e.origin !== window.location.origin) return;
    let d: any;
    try {
      d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch {
      return;
    }
    if (d?.type !== 'init' || received) return;
    received = true;
    onInit({ token: d.token, boardId: d.boardId, pageId: d.pageId, apiBase: d.apiBase });
  });
  const ready = JSON.stringify({ type: 'ready' });
  window.parent.postMessage(ready, '*');
  window.OideaBridge?.postMessage(ready);
}

export function emit(event: BridgeEvent): void {
  const msg = JSON.stringify({ type: event });
  window.parent.postMessage(msg, '*');
  window.OideaBridge?.postMessage(msg);
}
