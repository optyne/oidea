/**
 * H2 後台的端到端測試組裝（只給 *.spec.ts）：在 SsoHarness（真的 Nest HTTP、真的 SSO 登入、JwtStrategy、
 * attendance/today）上，再掛真的後台 controller／service、審計端點、bot 端點與 messages gateway（真的 socket.io）。
 * Prisma 用 FakeAdminPrisma（記憶體版，含部門與 partial unique index），Redis 用記憶體版。
 */
import { Provider, Type } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { SsoHarness, COMPANY_WS } from '../../auth/oidc/testing/sso-harness';
import { FakeIdp } from '../../auth/oidc/testing/fake-idp';
import { WsAuthService } from '../../auth/ws-auth';
import { MessagesGateway } from '../../messages/messages.gateway';
import { MessagesService } from '../../messages/messages.service';
import { WorkspacesService } from '../../workspaces/workspaces.service';
import { BotSelfController, WorkspaceBotsController } from '../../bots/bots.controller';
import { BotsService } from '../../bots/bots.service';
import { BotAuthGuard } from '../../bots/bot-auth.guard';
import { AuditController } from '../../audit/audit.controller';
import { PermissionsGuard } from '../../common/permissions.guard';
import { CompanyPermissionGuard } from '../../company/company-permission.guard';
import { AdminDepartmentsController, AdminEmployeesController } from '../admin.controllers';
import { CompanyMeController, CompanyMeService } from '../company-me.controller';
import { EmployeeAdminService } from '../employee-admin.service';
import { EmployeesService } from '../employees.service';
import { DepartmentsService } from '../departments.service';
import { ManagerResolver } from '../manager-resolver';
import { FakeAdminPrisma } from './admin-fakes';

export { COMPANY_WS };

export interface ApiResponse {
  status: number;
  body: any;
}

export class AdminHarness extends SsoHarness {
  override readonly prisma: FakeAdminPrisma = new FakeAdminPrisma(this.clock);

  constructor(idp: FakeIdp, env: Record<string, string | undefined> = {}) {
    super(idp, env);
  }

  protected override extraControllers(): Type<unknown>[] {
    return [
      AdminEmployeesController,
      AdminDepartmentsController,
      CompanyMeController,
      AuditController,
      BotSelfController,
      WorkspaceBotsController,
    ];
  }

  protected override extraProviders(): Provider[] {
    return [
      EmployeesService,
      EmployeeAdminService,
      DepartmentsService,
      ManagerResolver,
      CompanyMeService,
      CompanyPermissionGuard,
      PermissionsGuard,
      BotsService,
      BotAuthGuard,
      MessagesGateway,
      WsAuthService,
      // 離職跟移交 owner 的併發測試直接呼叫（H2 review S3）
      WorkspacesService,
      { provide: MessagesService, useValue: {} },
    ];
  }

  /** 直接簽一張 access token（跟 AuthService 同一個 secret、同樣的 claim）。 */
  token(userId: string, tokenVersion = 0): string {
    const u = this.prisma.users.find((x) => x.id === userId);
    const t = this.app
      .get(JwtService)
      .sign({ sub: userId, email: u?.email ?? `${userId}@corp.com`, typ: 'access', tv: tokenVersion });
    this.secrets.push(t);
    return t;
  }

  /** 建一位已綁定 User 的員工，加入公司工作空間（指定角色）。 */
  addEmployee(p: { id: string; role?: string | null; employeeNo?: string; email?: string; fullName?: string; [k: string]: any }) {
    const email = p.email ?? `${p.id}@corp.com`;
    const { id, role, employeeNo, fullName, email: _e, ...rest } = p;
    const user = this.prisma.addUser({ id, email, username: id, displayName: fullName ?? id });
    const profile = this.prisma.addProfile({
      workspaceId: COMPANY_WS,
      email,
      employeeNo: employeeNo ?? `E-${id}`,
      fullName: fullName ?? id,
      userId: id,
      ...rest,
    });
    if (role !== null) this.prisma.addMember(COMPANY_WS, id, role ?? 'member');
    return { user, profile };
  }

  /** 一個由 createdById 建立的 bot（真的 bcrypt hash），回傳 token。 */
  async addBot(p: { id: string; createdById: string; workspaceId: string }): Promise<string> {
    const prefix = `bot_${p.id.replace(/[^a-z0-9]/gi, '').slice(0, 6).padEnd(6, 'x')}`;
    const secret = `secret-${p.id}`;
    const botUserId = `u-${p.id}`;
    this.prisma.addUser({ id: botUserId, email: `bot+${p.id}@oidea.system`, username: `bot_${p.id}` });
    this.prisma.bots.push({
      id: p.id,
      workspaceId: p.workspaceId,
      userId: botUserId,
      tokenPrefix: prefix,
      tokenHash: await bcrypt.hash(secret, 4),
      createdById: p.createdById,
      revokedAt: null,
      name: p.id,
      description: null,
      lastUsedAt: null,
      createdAt: this.clock.now(),
    } as any);
    this.prisma.addMember(p.workspaceId, botUserId, 'member');
    const token = `${prefix}.${secret}`;
    this.secrets.push(token);
    return token;
  }

  async call(method: string, path: string, token?: string, body?: unknown): Promise<ApiResponse> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  port(): number {
    return this.app.getHttpServer().address().port;
  }
}

/**
 * 用 Node 22 內建 WebSocket 直接講 socket.io v5 協定連 messages gateway（namespace `/`）。
 * 回傳連線結果與一個「伺服器斷線」的 promise。
 */
export async function connectSocket(port: number, token: string) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => (closedResolve = r));
  const packets: string[] = [];
  const connected = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket timeout')), 5000);
    sock.onmessage = (ev) => {
      const msg = String(ev.data);
      packets.push(msg);
      if (msg === '2') sock.send('3'); // engine.io ping → pong
      if (msg.startsWith('0{')) sock.send(`40${JSON.stringify({ token })}`);
      else if (msg.startsWith('40') || msg.startsWith('44')) {
        clearTimeout(timer);
        resolve(msg);
      }
    };
    sock.onerror = () => reject(new Error('ws error'));
  });
  sock.onclose = () => closedResolve();
  return { sock, connected, closed, packets };
}
