/**
 * 測試用的假 OIDC 伺服器（只給 *.spec.ts）：127.0.0.1 隨機埠，提供 discovery、JWKS（RS256 金鑰）、
 * authorize（直接 302 回 redirect_uri，不顯示登入頁）與 token endpoint（驗 client_secret_basic、
 * PKCE S256、code 只能用一次），id_token 由這裡簽。
 *
 * 每個測試用 `nextUser` 決定登入的是誰，`idToken` 改 claims、`signWith` 換簽法，
 * 用來測各種該被拒絕的 id_token。所有發出去的 code、id_token、access_token 記在 `issued`，
 * 讓 log 測試確認它們沒進 log。
 */
import { createHash, randomBytes } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import * as jose from 'jose';

export interface FakeIdpUser {
  sub: string;
  email: string;
  email_verified?: unknown;
  name?: string;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  user: FakeIdpUser;
}

export type SignMode = 'rs256' | 'hs256' | 'none' | 'foreign-rs256';

export class FakeIdp {
  readonly clientId = 'oidea-test-client';
  readonly clientSecret = `idp-secret-${randomBytes(12).toString('hex')}`;
  issuer = '';
  redirectUri = '';
  nextUser: FakeIdpUser = { sub: 'sub-default', email: 'default@corp.com', email_verified: true, name: 'Default' };
  /** 蓋掉 id_token 的 claims（undefined 的值會刪掉該 claim）。 */
  idToken: Record<string, unknown> = {};
  signWith: SignMode = 'rs256';
  /** discovery 回 500 */
  failDiscovery = false;
  /** discovery 宣告的 id_token 簽法（Authentik 沒選簽章金鑰時會宣告 HS256）。 */
  advertisedAlgs: string[] = ['RS256'];
  /** authorize 改回傳 ?error=access_denied */
  denyAuthorize = false;
  /** 所有發出去的秘密值（code、id_token、access_token、refresh_token）以及 client secret。 */
  readonly issued: string[] = [this.clientSecret];
  readonly tokenRequests: URLSearchParams[] = [];
  discoveryHits = 0;

  private server!: Server;
  private codes = new Map<string, PendingCode>();
  private privateKey!: CryptoKey;
  private publicJwk!: jose.JWK;
  private foreignKey!: CryptoKey;
  private readonly kid = 'fake-idp-key-1';

  async start(): Promise<void> {
    const pair = await jose.generateKeyPair('RS256', { extractable: true });
    this.privateKey = pair.privateKey;
    this.publicJwk = { ...(await jose.exportJWK(pair.publicKey)), kid: this.kid, alg: 'RS256', use: 'sig' };
    this.foreignKey = (await jose.generateKeyPair('RS256')).privateKey;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    // 跟 Authentik 一樣：issuer 有路徑、結尾有斜線
    this.issuer = `http://127.0.0.1:${port}/application/o/oidea/`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get endSessionEndpoint(): string {
    return `${this.issuer}end-session/`;
  }

  private remember(value: string): string {
    this.issued.push(value);
    return value;
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.issuer);
    const base = new URL(this.issuer).pathname;
    const path = url.pathname;

    if (path === `${base}.well-known/openid-configuration`) {
      this.discoveryHits++;
      if (this.failDiscovery) return this.json(res, 500, { error: 'boom' });
      return this.json(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}authorize/`,
        token_endpoint: `${this.issuer}token/`,
        jwks_uri: `${this.issuer}jwks/`,
        end_session_endpoint: this.endSessionEndpoint,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: this.advertisedAlgs,
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
    }

    if (path === `${base}jwks/`) return this.json(res, 200, { keys: [this.publicJwk] });

    if (path === `${base}authorize/`) {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') ?? '';
      if (q.get('client_id') !== this.clientId || redirectUri !== this.redirectUri) {
        return this.json(res, 400, { error: 'invalid_request' });
      }
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        return this.json(res, 400, { error: 'invalid_request' });
      }
      const scopes = (q.get('scope') ?? '').split(' ');
      if (!scopes.includes('openid') || !scopes.includes('email')) return this.json(res, 400, { error: 'invalid_scope' });
      const back = new URL(redirectUri);
      back.searchParams.set('state', q.get('state') ?? '');
      if (this.denyAuthorize) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = this.remember(randomBytes(24).toString('base64url'));
        this.codes.set(code, {
          clientId: this.clientId,
          redirectUri,
          codeChallenge: q.get('code_challenge')!,
          nonce: q.get('nonce') ?? '',
          user: { ...this.nextUser },
        });
        back.searchParams.set('code', code);
      }
      res.statusCode = 302;
      res.setHeader('location', back.toString());
      return res.end();
    }

    if (path === `${base}token/` && req.method === 'POST') {
      const form = new URLSearchParams(await this.readBody(req));
      this.tokenRequests.push(form);
      const auth = req.headers.authorization ?? '';
      const [scheme, encoded] = auth.split(' ');
      const [id, secret] =
        scheme === 'Basic' && encoded
          ? Buffer.from(encoded, 'base64').toString('utf8').split(':').map((s) => decodeURIComponent(s))
          : [form.get('client_id'), form.get('client_secret')];
      if (id !== this.clientId || secret !== this.clientSecret) return this.json(res, 401, { error: 'invalid_client' });
      const code = form.get('code') ?? '';
      const pending = this.codes.get(code);
      this.codes.delete(code);
      if (!pending || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== pending.redirectUri) {
        return this.json(res, 400, { error: 'invalid_grant' });
      }
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== pending.codeChallenge) {
        return this.json(res, 400, { error: 'invalid_grant' });
      }
      const idToken = this.remember(await this.signIdToken(pending));
      return this.json(res, 200, {
        access_token: this.remember(`idp-at-${randomBytes(16).toString('hex')}`),
        token_type: 'Bearer',
        expires_in: 300,
        refresh_token: this.remember(`idp-rt-${randomBytes(16).toString('hex')}`),
        id_token: idToken,
        scope: 'openid email profile',
      });
    }

    return this.json(res, 404, { error: 'not_found' });
  }

  private async signIdToken(pending: PendingCode): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.issuer,
      sub: pending.user.sub,
      aud: pending.clientId,
      exp: now + 300,
      iat: now,
      auth_time: now,
      nonce: pending.nonce,
      email: pending.user.email,
      email_verified: pending.user.email_verified === undefined ? true : pending.user.email_verified,
      name: pending.user.name ?? pending.user.email,
      ...this.idToken,
    };
    for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];

    if (this.signWith === 'none') {
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims)}.`;
    }
    if (this.signWith === 'hs256') {
      // Authentik 沒選簽章金鑰時的行為：用 client secret 以 HS256 簽
      return new jose.SignJWT(claims as jose.JWTPayload)
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .sign(new TextEncoder().encode(this.clientSecret));
    }
    const key = this.signWith === 'foreign-rs256' ? this.foreignKey : this.privateKey;
    return new jose.SignJWT(claims as jose.JWTPayload)
      .setProtectedHeader({ alg: 'RS256', kid: this.kid, typ: 'JWT' })
      .sign(key);
  }
}
