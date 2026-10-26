import { corsOriginFromEnv, parseCorsOrigin } from './cors-origin';

describe('CORS origin（gateway 與 main.ts 同一套規則）', () => {
  const original = process.env.CORS_ORIGIN;
  afterEach(() => {
    if (original === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = original;
  });

  it('沒設 → true（同 main.ts 的開發預設）', () => {
    expect(parseCorsOrigin(undefined)).toBe(true);
    expect(parseCorsOrigin('')).toBe(true);
  });

  it('逗號分隔白名單、去空白', () => {
    expect(parseCorsOrigin('https://a.example.com, https://b.example.com')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('每次握手才讀 process.env（不受 import 順序影響）', () => {
    const cb = jest.fn();
    process.env.CORS_ORIGIN = 'https://app.example.com';
    corsOriginFromEnv('https://evil.example.com', cb);
    expect(cb).toHaveBeenLastCalledWith(null, ['https://app.example.com']);
    delete process.env.CORS_ORIGIN;
    corsOriginFromEnv(undefined, cb);
    expect(cb).toHaveBeenLastCalledWith(null, true);
  });
});
