import { describe, it, expect, vi } from 'vitest';
import { SaveLoop } from '../save_loop';

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

describe('SaveLoop（存檔閉環：debounce、單飛、世代、退避）', () => {
  it('markDirty 後 debounce 到期觸發一次 save', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(true);
    const loop = new SaveLoop({ save, debounceMs: 2000 });
    loop.markDirty();
    loop.markDirty(); // 連續筆畫只排一次
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(loop.dirty).toBe(false);
    vi.useRealTimers();
  });

  it('存檔進行中又 markDirty → 完成後自動補存（不遺失）', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (v: boolean) => void;
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((r) => (resolveFirst = r)))
      .mockResolvedValue(true);
    const loop = new SaveLoop({ save, debounceMs: 10 });
    loop.markDirty();
    await vi.advanceTimersByTimeAsync(10); // save #1 進行中
    loop.markDirty();                      // 存檔中落筆
    resolveFirst(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledTimes(2); // 自動補存
    expect(loop.dirty).toBe(false);
    vi.useRealTimers();
  });

  it('save 失敗 → dirty 保留、退避重試 5→10→20s、成功後歸零', async () => {
    vi.useFakeTimers();
    const save = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const states: string[] = [];
    const loop = new SaveLoop({ save, debounceMs: 10 });
    loop.onState = (s) => states.push(s);
    loop.markDirty();
    await vi.advanceTimersByTimeAsync(10);     // 失敗 #1 → 排 5s
    expect(loop.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);   // 失敗 #2 → 排 10s
    await vi.advanceTimersByTimeAsync(10000);  // 成功
    expect(save).toHaveBeenCalledTimes(3);
    expect(loop.dirty).toBe(false);
    expect(states).toContain('error');
    expect(states[states.length - 1]).toBe('saved');
    vi.useRealTimers();
  });

  it('flush：進行中等真結果；乾淨時回 true 不呼叫 save', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const loop = new SaveLoop({ save, debounceMs: 999999 });
    expect(await loop.flush()).toBe(true);
    expect(save).not.toHaveBeenCalled();
    loop.markDirty();
    expect(await loop.flush()).toBe(true); // flush 直接觸發，不等 debounce
    expect(save).toHaveBeenCalledTimes(1);
  });
});
