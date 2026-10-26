import { Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { BreakGlassPasswordError, BreakGlassPasswordService } from './break-glass-password.service';
import { CompanyService } from '../company/company.service';
import { FakeCompanyPrisma } from '../company/testing/company-fakes';
import { runSetBreakGlassPassword } from '../cli/set-break-glass-password.command';

const SECRET = 'Correct-Horse-Battery-9';

describe('BreakGlassPasswordService + auth:set-break-glass-password', () => {
  let prisma: FakeCompanyPrisma;
  let audit: { record: jest.Mock };
  let service: BreakGlassPasswordService;
  let logged: string[];
  let written: string[];

  beforeEach(() => {
    prisma = new FakeCompanyPrisma();
    prisma.addUser({ id: 'u-owner', email: 'owner@corp.com', ssoBound: true });
    prisma.addUser({ id: 'u-co', email: 'co@corp.com', ssoBound: true });
    // 公司共同 owner，但還沒綁定 SSO（review R2）
    prisma.addUser({ id: 'u-unbound', email: 'unbound@corp.com' });
    prisma.addUser({ id: 'u-admin', email: 'admin@corp.com' });
    prisma.addUser({ id: 'u-side', email: 'side@corp.com' });
    prisma.addUser({ id: 'u-dis', email: 'dis@corp.com', disabledAt: new Date() });
    prisma.addWorkspace({ id: 'ws-co', ownerId: 'u-owner', isCompany: true });
    prisma.addMember('ws-co', 'u-owner', 'owner');
    prisma.addMember('ws-co', 'u-co', 'owner');
    prisma.addMember('ws-co', 'u-admin', 'admin');
    prisma.addMember('ws-co', 'u-unbound', 'owner');
    prisma.addWorkspace({ id: 'ws-side', ownerId: 'u-side' });
    prisma.addMember('ws-side', 'u-side', 'owner');
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new BreakGlassPasswordService(prisma as any, audit as any, new CompanyService(prisma as any));

    // 收集所有可能的輸出管道：Nest Logger、console、process.stdout/stderr
    logged = [];
    written = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: any[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
    for (const level of ['log', 'warn', 'error', 'info'] as const) {
      jest.spyOn(console, level).mockImplementation((...args: any[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
    jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
      written.push(String(chunk));
      return true;
    }) as any);
    jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
      written.push(String(chunk));
      return true;
    }) as any);
  });

  afterEach(() => jest.restoreAllMocks());

  const run = async (email: string, password: string, opts: { interactive?: boolean; again?: string } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const answers = [password, opts.again ?? password];
    const code = await runSetBreakGlassPassword([email], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      setPassword: (e, p) => service.setPassword(e, p),
      readSecret: async () => answers.shift()!,
      interactive: opts.interactive ?? false,
      isListed: (e) => e.toLowerCase() === 'owner@corp.com',
    });
    return { code, out, err, all: [...out, ...err, ...logged, ...written].join('\n') };
  };

  it('公司 owner：以 bcrypt 存（不是明文）、寫 audit，任何輸出都不含密碼', async () => {
    const res = await run('Owner@Corp.com', SECRET);
    expect(res.code).toBe(0);
    const hash = prisma.users.find((u) => u.id === 'u-owner')!.passwordHash!;
    expect(hash).not.toContain(SECRET);
    expect(await bcrypt.compare(SECRET, hash)).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.break_glass_password_set', targetId: 'u-owner', workspaceId: 'ws-co' }),
    );
    expect(res.all).not.toContain(SECRET);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(SECRET);
  });

  it('共同 owner 也可以；不在 BREAK_GLASS_OWNER_EMAILS 時提醒', async () => {
    const res = await run('co@corp.com', SECRET);
    expect(res.code).toBe(0);
    expect(res.out.join('\n')).toContain('BREAK_GLASS_OWNER_EMAILS');
    expect(res.all).not.toContain(SECRET);
  });

  it.each([
    ['公司 admin（非 owner）', 'admin@corp.com'],
    ['其他工作空間的 owner', 'side@corp.com'],
    ['停用帳號', 'dis@corp.com'],
    ['不存在的帳號', 'ghost@corp.com'],
    ['review R2：還沒綁定 SSO 的公司 owner', 'unbound@corp.com'],
  ])('%s → 拒絕（exit 1），不改密碼', async (_label, email) => {
    const res = await run(email, SECRET);
    expect(res.code).toBe(1);
    expect(prisma.users.every((u) => u.passwordHash === null)).toBe(true);
    expect(audit.record).not.toHaveBeenCalled();
    expect(res.all).not.toContain(SECRET);
  });

  it('密碼太短（< 12）→ 拒絕，錯誤訊息不含密碼', async () => {
    const short = 'Short-pw-11';
    expect(short).toHaveLength(11);
    const res = await run('owner@corp.com', short);
    expect(res.code).toBe(1);
    expect(res.err.join('\n')).toContain('12');
    expect(res.all).not.toContain(short);
    expect(prisma.users.find((u) => u.id === 'u-owner')!.passwordHash).toBeNull();
  });

  it('超過 bcrypt 的 72 bytes → 拒絕', async () => {
    await expect(service.setPassword('owner@corp.com', '密'.repeat(25))).rejects.toBeInstanceOf(BreakGlassPasswordError);
  });

  it('終端機模式兩次輸入不同 → 拒絕', async () => {
    const res = await run('owner@corp.com', SECRET, { interactive: true, again: `${SECRET}x` });
    expect(res.code).toBe(1);
    expect(prisma.users.find((u) => u.id === 'u-owner')!.passwordHash).toBeNull();
    expect(res.all).not.toContain(SECRET);
  });

  it('非預期錯誤（例如 DB 掛了）的訊息若剛好含密碼，會被遮掉', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSetBreakGlassPassword(['owner@corp.com'], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      setPassword: async (_e, p) => {
        throw new Error(`boom ${p}`);
      },
      readSecret: async () => SECRET,
      interactive: false,
      isListed: () => true,
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('boom ***');
    expect([...out, ...err].join('\n')).not.toContain(SECRET);
  });

  it('參數錯誤（沒給 email、多給參數、把密碼當參數）→ exit 1，不讀密碼', async () => {
    const readSecret = jest.fn(async () => SECRET);
    for (const argv of [[], ['a@corp.com', 'b'], ['a@corp.com', '--password=x']]) {
      const code = await runSetBreakGlassPassword(argv, {
        out: () => undefined,
        err: () => undefined,
        setPassword: async () => ({ userId: 'x' }),
        readSecret,
        interactive: false,
        isListed: () => true,
      });
      expect(code).toBe(1);
    }
    expect(readSecret).not.toHaveBeenCalled();
  });
});
