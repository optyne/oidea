/**
 * 存檔閉環純邏輯 —— 鏡射 Flutter pencil 頁的語意：
 * debounce、單飛（in-flight 期間 markDirty 完成後自動補存）、
 * 失敗指數退避 5→60s、dirty 直到「觸發時的世代」成功寫入才清。
 * 不碰 DOM/fetch：save callback 由呼叫端注入，vitest 可完整驗證。
 */
export type SaveState = 'dirty' | 'saving' | 'saved' | 'error';

export class SaveLoop {
  private generation = 0;
  private savedGeneration = 0;
  private inFlight: Promise<boolean> | null = null;
  private debounceId: ReturnType<typeof setTimeout> | null = null;
  private retryId: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 5000;
  private disposed = false;
  private lastAttemptFailed = false;

  onState?: (s: SaveState) => void;

  constructor(
    private readonly opts: {
      save: () => Promise<boolean>;
      debounceMs?: number;
      setTimer?: typeof setTimeout;
      clearTimer?: typeof clearTimeout;
    },
  ) {}

  get dirty(): boolean {
    return this.generation !== this.savedGeneration;
  }

  markDirty(): void {
    if (this.disposed) return;
    this.generation++;
    this.onState?.('dirty');
    if (this.debounceId) (this.opts.clearTimer || clearTimeout)(this.debounceId);
    this.debounceId = (this.opts.setTimer || setTimeout)(() => void this.run(), this.opts.debounceMs ?? 2000);
  }

  /** 立即存（關頁用）；回傳最終是否乾淨。 */
  flush(): Promise<boolean> {
    if (this.debounceId) (this.opts.clearTimer || clearTimeout)(this.debounceId);
    if (!this.dirty && !this.inFlight) return Promise.resolve(true);
    return this.run();
  }

  private run(): Promise<boolean> {
    const existing = this.inFlight;
    if (existing) {
      return existing.then((ok) => {
        if (this.lastAttemptFailed) return ok; // failed, retry timer pending
        return this.dirty && !this.disposed ? this.run() : ok;
      });
    }
    const attempt = this.doSave().finally(() => (this.inFlight = null));
    this.inFlight = attempt;
    return attempt.then((ok) => {
      if (this.lastAttemptFailed) return ok; // failed, retry timer pending
      return this.dirty && !this.disposed ? this.run() : ok;
    });
  }

  private async doSave(): Promise<boolean> {
    if (!this.dirty) return true;
    const gen = this.generation;
    this.onState?.('saving');
    let ok = false;
    try {
      ok = await this.opts.save();
    } catch {
      ok = false;
    }
    if (this.disposed) return ok;
    if (ok) {
      this.savedGeneration = gen;
      this.retryMs = 5000;
      this.lastAttemptFailed = false;
      if (this.retryId) (this.opts.clearTimer || clearTimeout)(this.retryId);
      this.retryId = null;
      this.onState?.(this.dirty ? 'dirty' : 'saved');
      return !this.dirty;
    }
    this.onState?.('error');
    this.lastAttemptFailed = true;
    if (this.retryId) (this.opts.clearTimer || clearTimeout)(this.retryId);
    this.retryId = (this.opts.setTimer || setTimeout)(() => void this.run(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 60000);
    return false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceId) (this.opts.clearTimer || clearTimeout)(this.debounceId);
    this.debounceId = null;
    if (this.retryId) (this.opts.clearTimer || clearTimeout)(this.retryId);
    this.retryId = null;
  }
}
