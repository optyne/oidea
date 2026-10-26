import { describeOidcError, idTokenAlg, oidcEnvProblems } from './oidc-client';
import { readOidcEnv } from '../../common/auth-config';

describe('OidcClient helpers', () => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

  it('idTokenAlg 只讀 header', () => {
    expect(idTokenAlg(`${enc({ alg: 'RS256', kid: 'k' })}.${enc({ sub: 'x' })}.sig`)).toBe('RS256');
    expect(idTokenAlg(`${enc({ alg: 'HS256' })}.e30.sig`)).toBe('HS256');
    expect(idTokenAlg(`${enc({ alg: 'none' })}.e30.`)).toBe('none');
    expect(idTokenAlg('not-a-jwt')).toBeNull();
    expect(idTokenAlg(`${enc({ typ: 'JWT' })}.e30.sig`)).toBeNull();
  });

  it('describeOidcError 只留類別、code、claim 名稱與 oauth4webapi 的固定訊息，不留值', () => {
    const secretish = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl';
    const inner = Object.assign(new Error('unexpected ID Token "nonce" claim value'), {
      name: 'OperationProcessingError',
      code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED',
      cause: { claim: 'nonce', expected: 'n-123', claims: { nonce: secretish } },
    });
    const outer = Object.assign(new Error(`wrapped ${secretish}`), { name: 'ClientError', code: 'OAUTH_X', cause: inner });
    const d = describeOidcError(outer);
    expect(d).toContain('ClientError');
    expect(d).toContain('OAUTH_JWT_CLAIM_COMPARISON_FAILED');
    expect(d).toContain('claim=nonce');
    expect(d).toContain('"unexpected ID Token "nonce" claim value"');
    expect(d).not.toContain(secretish);
    expect(d).not.toContain('n-123');
    expect(d).not.toContain('wrapped');
  });

  it('describeOidcError 擋掉含長串 token 狀字元的訊息', () => {
    const err = Object.assign(new Error(`bad ${'A'.repeat(40)}`), { name: 'OperationProcessingError' });
    expect(describeOidcError(err)).toBe('OperationProcessingError');
    expect(describeOidcError('string')).toBe('unknown');
    expect(describeOidcError(null)).toBe('unknown');
  });

  it('oidcEnvProblems 只回變數名稱', () => {
    const env = (o: Record<string, string>) => readOidcEnv((k) => o[k]);
    expect(oidcEnvProblems(env({}))).toEqual([
      'OIDC_ISSUER',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_REDIRECT_URI',
      'APP_WEB_CALLBACK_URL',
    ]);
    const full = {
      OIDC_ISSUER: 'https://auth.example/application/o/oidea/',
      OIDC_CLIENT_ID: 'id',
      OIDC_CLIENT_SECRET: 's3cret',
      OIDC_REDIRECT_URI: 'https://api.example/api/auth/oidc/callback',
      APP_WEB_CALLBACK_URL: 'https://app.example/auth/callback',
    };
    expect(oidcEnvProblems(env(full))).toEqual([]);
    expect(oidcEnvProblems(env({ ...full, APP_MOBILE_CALLBACK_URL: 'not a url' }))).toEqual(['APP_MOBILE_CALLBACK_URL']);
    expect(oidcEnvProblems(env({ ...full, OIDC_REDIRECT_URI: 'ftp://x/' }))).toEqual(['OIDC_REDIRECT_URI']);
    expect(JSON.stringify(oidcEnvProblems(env({ ...full, OIDC_ISSUER: 'nope' })))).not.toContain('s3cret');
  });

  it('review N4：NODE_ENV=production 時 callback 必須是 https、mobile 必須是自訂 scheme', () => {
    const env = (o: Record<string, string>) => readOidcEnv((k) => o[k]);
    const full = {
      OIDC_ISSUER: 'https://auth.example/application/o/oidea/',
      OIDC_CLIENT_ID: 'id',
      OIDC_CLIENT_SECRET: 's3cret',
      OIDC_REDIRECT_URI: 'http://api.example/api/auth/oidc/callback',
      APP_WEB_CALLBACK_URL: 'http://app.example/auth/callback',
      APP_MOBILE_CALLBACK_URL: 'https://app.example/mobile',
    };
    // 開發環境：http 可以（本機測試）
    expect(oidcEnvProblems(env(full))).toEqual([]);
    expect(oidcEnvProblems(env({ ...full, NODE_ENV: 'production' }))).toEqual([
      'OIDC_REDIRECT_URI',
      'APP_WEB_CALLBACK_URL',
      'APP_MOBILE_CALLBACK_URL',
    ]);
    expect(
      oidcEnvProblems(
        env({
          ...full,
          NODE_ENV: 'production',
          OIDC_REDIRECT_URI: 'https://api.example/api/auth/oidc/callback',
          APP_WEB_CALLBACK_URL: 'https://app.example/auth/callback',
          APP_MOBILE_CALLBACK_URL: 'oidea://auth',
        }),
      ),
    ).toEqual([]);
  });
});
