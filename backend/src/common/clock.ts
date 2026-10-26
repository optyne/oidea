/**
 * 可注入的時鐘（spec §6.4）：所有「現在」都從這裡取，測試注入假時鐘。
 *
 * 用法：constructor(private clock: Clock) {} → this.clock.now()
 * 測試：{ provide: Clock, useValue: new FakeClock(new Date('2026-01-01T00:00:00Z')) }
 */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** 測試用：時間只在呼叫 advance / set 時前進。 */
export class FakeClock extends Clock {
  private current: number;

  constructor(start: Date | number = Date.UTC(2026, 0, 1)) {
    super();
    this.current = typeof start === 'number' ? start : start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(at: Date | number): void {
    this.current = typeof at === 'number' ? at : at.getTime();
  }
}
