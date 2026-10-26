import { findUserCandidatesByEmail, pickEmailMatch, resolveUserIdByEmail } from './email-lookup';
import { fakeEmailQueryRaw, sqlText } from './testing/fake-email-raw';

describe('email-lookup（review S8：不用 ILIKE 比對 email）', () => {
  const rows = [
    { id: 'u-dot', email: 'tom.lee@corp.com', deletedAt: null },
    { id: 'u-foo', email: 'Foo@corp.com', deletedAt: null },
    { id: 'u-twin-a', email: 'Twin@corp.com', deletedAt: null },
    { id: 'u-twin-b', email: 'twin@CORP.com', deletedAt: null },
    { id: 'u-gone', email: 'gone@corp.com', deletedAt: new Date() },
  ];

  it('送出參數化的 lower("email") = lower($1)：email 是參數、不拼進 SQL，不用 ILIKE／LIKE', async () => {
    const db = { $queryRaw: fakeEmailQueryRaw(() => rows) };
    await findUserCandidatesByEmail(db as any, ' Tom_Lee@corp.com ');
    const [strings, ...values] = db.$queryRaw.mock.calls[0];
    const sql = sqlText(strings as TemplateStringsArray);
    expect(sql).toContain('lower("email") = lower($?)');
    expect(sql).toContain('"deletedAt" IS NULL');
    expect(sql).not.toMatch(/LIKE/i);
    expect(sql).not.toContain('Tom_Lee');
    expect(values).toEqual(['Tom_Lee@corp.com']);
  });

  it('includeDeleted：不加 deletedAt 條件', async () => {
    const db = { $queryRaw: fakeEmailQueryRaw(() => rows) };
    expect(await findUserCandidatesByEmail(db as any, 'gone@corp.com', { includeDeleted: true })).toEqual([
      { id: 'u-gone', email: 'gone@corp.com' },
    ]);
    expect(sqlText(db.$queryRaw.mock.calls[0][0] as TemplateStringsArray)).not.toContain('deletedAt');
    expect(await findUserCandidatesByEmail(db as any, 'gone@corp.com')).toEqual([]);
  });

  it('`_` 不是萬用字元：tom_lee@ 對不到 tom.lee@', async () => {
    const db = { $queryRaw: fakeEmailQueryRaw(() => rows) };
    expect(await resolveUserIdByEmail(db as any, 'tom_lee@corp.com')).toBeNull();
    expect(await resolveUserIdByEmail(db as any, 'TOM.LEE@corp.com')).toBe('u-dot');
  });

  it('空字串不查 DB', async () => {
    const db = { $queryRaw: fakeEmailQueryRaw(() => rows) };
    expect(await findUserCandidatesByEmail(db as any, '   ')).toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  describe('pickEmailMatch：0／1／多筆', () => {
    const a = { id: 'a', email: 'Ceo@corp.com' };
    const b = { id: 'b', email: 'ceo@corp.com' };
    const c = { id: 'c', email: 'CEO@corp.com' };
    it('0 筆 → null', () => expect(pickEmailMatch([], 'ceo@corp.com')).toBeNull());
    it('1 筆（只差大小寫）→ 那一筆', () => expect(pickEmailMatch([a], 'ceo@corp.com')).toBe(a));
    it('多筆、其中一筆完全相同 → 完全相同的那筆', () => expect(pickEmailMatch([a, b, c], 'ceo@corp.com')).toBe(b));
    it('多筆、沒有完全相同 → ambiguous', () => expect(pickEmailMatch([a, c], 'ceo@corp.com')).toBe('ambiguous'));
  });
});
