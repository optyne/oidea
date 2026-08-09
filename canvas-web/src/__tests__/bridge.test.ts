// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initBridge, emit } from '../bridge';

describe('bridge（iframe postMessage 傳輸）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as any).OideaBridge;
  });

  it('送出 ready；收到 init 後回呼一次（重複 init 忽略）', () => {
    const parentPost = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    const onInit = vi.fn();
    initBridge(onInit);
    expect(parentPost).toHaveBeenCalledWith(JSON.stringify({ type: 'ready' }), '*');

    const init = { type: 'init', token: 't', boardId: 'b', pageId: 'p', apiBase: '/api' };
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(init) }));
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(init) }));
    expect(onInit).toHaveBeenCalledTimes(1);
    expect(onInit).toHaveBeenCalledWith({ token: 't', boardId: 'b', pageId: 'p', apiBase: '/api' });
  });

  it('emit 走 parent postMessage；有 OideaBridge 時也走 JS channel', () => {
    const parentPost = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    const channel = { postMessage: vi.fn() };
    (window as any).OideaBridge = channel;
    emit('saved');
    expect(parentPost).toHaveBeenCalledWith(JSON.stringify({ type: 'saved' }), '*');
    expect(channel.postMessage).toHaveBeenCalledWith(JSON.stringify({ type: 'saved' }));
  });
});
