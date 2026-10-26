import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { RefreshTokenService } from './refresh-token.service';
import { AuthConfig } from '../common/auth-config';
import { CompanyService } from '../company/company.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn(async (pw: string) => `hashed:${pw}`),
  compare: jest.fn(async (pw: string, hash: string) => hash === `hashed:${pw}`),
}));

/**
 * 特徵測試：固定 register / login 的正常路徑與錯誤路徑（H0 改造前後都要通過）。
 */
describe('AuthService — characterization (register / login)', () => {
  let service: AuthService;
  let users: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let jwt: JwtService;
  let refreshTokens: { issueNewFamily: jest.Mock };

  const USER = {
    id: 'u-1',
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'hashed:correct-horse',
  };

  beforeEach(async () => {
    users = {
      findByEmail: jest.fn().mockResolvedValue(null),
      findByUsername: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue(USER),
      create: jest.fn().mockResolvedValue(USER),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '15m' } });
    refreshTokens = { issueNewFamily: jest.fn().mockResolvedValue('opaque-refresh-token') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: users },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: { get: (_k: string, d?: unknown) => d } },
        { provide: AuditService, useValue: audit },
        // H0：refresh token 改成不透明字串（由 RefreshTokenService 發），這裡只固定「是字串」
        { provide: RefreshTokenService, useValue: refreshTokens },
        // H1：帳密登入開關（ConfigService 沒設 → 非 production 預設開啟）；緊急登入另有 password-login-gate.spec
        AuthConfig,
        { provide: CompanyService, useValue: {} },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  describe('register', () => {
    it('email 已存在 → Conflict', async () => {
      users.findByEmail.mockResolvedValue(USER);
      await expect(
        service.register({ email: USER.email, username: 'x', displayName: 'X', password: 'password1' }),
      ).rejects.toThrow(ConflictException);
      expect(users.create).not.toHaveBeenCalled();
    });

    it('username 已存在 → Conflict', async () => {
      users.findByUsername.mockResolvedValue(USER);
      await expect(
        service.register({ email: 'new@example.com', username: 'alice', displayName: 'X', password: 'password1' }),
      ).rejects.toThrow(ConflictException);
      expect(users.create).not.toHaveBeenCalled();
    });

    it('成功 → 以 bcrypt hash 建立 user，回 {accessToken, refreshToken, user:{id,email}}', async () => {
      const res = await service.register({
        email: USER.email,
        username: USER.username,
        displayName: USER.displayName,
        password: 'correct-horse',
      });
      expect(bcrypt.hash).toHaveBeenCalledWith('correct-horse', 12);
      expect(users.create).toHaveBeenCalledWith({
        email: USER.email,
        username: USER.username,
        displayName: USER.displayName,
        passwordHash: 'hashed:correct-horse',
      });
      expect(Object.keys(res).sort()).toEqual(['accessToken', 'refreshToken', 'user']);
      expect(res.user).toEqual({ id: USER.id, email: USER.email });
      expect(typeof res.accessToken).toBe('string');
      expect(typeof res.refreshToken).toBe('string');
      const decoded: any = jwt.verify(res.accessToken);
      expect(decoded.sub).toBe(USER.id);
      expect(decoded.email).toBe(USER.email);
      // H0：access token 帶 typ=access（刻意的行為變更）
      expect(decoded.typ).toBe('access');
    });
  });

  describe('login', () => {
    it('信箱不存在 → 401 並寫 auth.login_failed(user_not_found)', async () => {
      await expect(service.login({ email: 'nobody@example.com', password: 'x' })).rejects.toThrow(
        UnauthorizedException,
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.login_failed',
          metadata: { email: 'nobody@example.com', reason: 'user_not_found' },
        }),
      );
    });

    it('密碼錯誤 → 401 並寫 auth.login_failed(bad_password) 帶 actorId', async () => {
      users.findByEmail.mockResolvedValue(USER);
      await expect(service.login({ email: USER.email, password: 'wrong' })).rejects.toThrow(
        UnauthorizedException,
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: USER.id,
          action: 'auth.login_failed',
          metadata: { email: USER.email, reason: 'bad_password' },
        }),
      );
    });

    it.each([
      ['disabled', { disabledAt: new Date('2026-10-01') }],
      ['deleted', { deletedAt: new Date('2026-10-01') }],
    ])(
      'S5：密碼正確但帳號 %s → 401（訊息同密碼錯誤）、寫 auth.login_failed、不發 refresh token',
      async (reason, flags) => {
        users.findByEmail.mockResolvedValue({ ...USER, ...flags });
        const err = await service.login({ email: USER.email, password: 'correct-horse' }).catch((e) => e);
        expect(err).toBeInstanceOf(UnauthorizedException);
        expect(err.message).toBe('信箱或密碼錯誤');
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            actorId: USER.id,
            action: 'auth.login_failed',
            metadata: { email: USER.email, reason },
          }),
        );
        expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login' }));
        expect(refreshTokens.issueNewFamily).not.toHaveBeenCalled();
      },
    );

    it('成功 → 寫 auth.login，回 {accessToken, refreshToken, user:{id,email}}', async () => {
      users.findByEmail.mockResolvedValue(USER);
      const req = { ip: '1.2.3.4', headers: {} };
      const res = await service.login({ email: USER.email, password: 'correct-horse' }, req);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: USER.id, action: 'auth.login', req }),
      );
      expect(Object.keys(res).sort()).toEqual(['accessToken', 'refreshToken', 'user']);
      expect(res.user).toEqual({ id: USER.id, email: USER.email });
      const decoded: any = jwt.verify(res.accessToken);
      expect(decoded.sub).toBe(USER.id);
    });
  });
});
