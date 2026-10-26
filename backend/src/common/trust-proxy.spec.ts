import { parseTrustProxy } from './trust-proxy';

describe('parseTrustProxy (TRUST_PROXY env)', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['  ', undefined],
    ['0', 0],
    ['1', 1],
    [' 2 ', 2],
    ['true', true],
    ['FALSE', false],
    ['loopback', 'loopback'],
    ['10.0.0.0/8,172.16.0.0/12', '10.0.0.0/8,172.16.0.0/12'],
  ])('%p → %p', (raw, expected) => {
    expect(parseTrustProxy(raw as any)).toBe(expected);
  });
});
