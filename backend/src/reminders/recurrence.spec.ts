import { addRecurrence } from './recurrence';

describe('addRecurrence (D-07 時間推進)', () => {
  const iso = (s: string) => new Date(s);

  it('TC-D07-R01: none → 回傳原日', () => {
    const d = iso('2026-04-20T09:00:00Z');
    const out = addRecurrence(d, 'none', 1);
    expect(out.toISOString()).toBe(d.toISOString());
  });

  it('TC-D07-R02: daily + 1 → 隔日同時刻', () => {
    const out = addRecurrence(iso('2026-04-20T09:00:00Z'), 'daily', 1);
    expect(out.toISOString()).toBe('2026-04-21T09:00:00.000Z');
  });

  it('TC-D07-R03: weekly + 2 → 14 天後', () => {
    const out = addRecurrence(iso('2026-04-20T09:00:00Z'), 'weekly', 2);
    expect(out.toISOString()).toBe('2026-05-04T09:00:00.000Z');
  });

  it('TC-D07-R04: monthly + 1 正常 → 下月同日', () => {
    const out = addRecurrence(iso('2026-04-20T09:00:00Z'), 'monthly', 1);
    expect(out.toISOString()).toBe('2026-05-20T09:00:00.000Z');
  });

  it('TC-D07-R05: monthly 1/31 + 1 → clamp 到 2/28 (平年)', () => {
    const out = addRecurrence(iso('2026-01-31T09:00:00Z'), 'monthly', 1);
    expect(out.toISOString()).toBe('2026-02-28T09:00:00.000Z');
  });

  it('TC-D07-R06: monthly 1/31 + 1 於閏年 → 2/29', () => {
    const out = addRecurrence(iso('2028-01-31T09:00:00Z'), 'monthly', 1);
    expect(out.toISOString()).toBe('2028-02-29T09:00:00.000Z');
  });

  it('TC-D07-R07: monthly + 13 跨年 (12 + 1)', () => {
    const out = addRecurrence(iso('2026-03-15T09:00:00Z'), 'monthly', 13);
    expect(out.toISOString()).toBe('2027-04-15T09:00:00.000Z');
  });

  it('TC-D07-R08: yearly + 1 → 明年同日', () => {
    const out = addRecurrence(iso('2026-04-20T09:00:00Z'), 'yearly', 1);
    expect(out.toISOString()).toBe('2027-04-20T09:00:00.000Z');
  });

  it('TC-D07-R09: yearly 2/29 閏年 + 1 → 2/28 平年', () => {
    const out = addRecurrence(iso('2028-02-29T09:00:00Z'), 'yearly', 1);
    expect(out.toISOString()).toBe('2029-02-28T09:00:00.000Z');
  });

  it('TC-D07-R10: yearly 2/29 + 4 → 仍為 2/29', () => {
    const out = addRecurrence(iso('2028-02-29T09:00:00Z'), 'yearly', 4);
    expect(out.toISOString()).toBe('2032-02-29T09:00:00.000Z');
  });

  it('TC-D07-R11: interval < 1 → throw', () => {
    expect(() =>
      addRecurrence(iso('2026-04-20T09:00:00Z'), 'daily', 0),
    ).toThrow();
  });
});
