/**
 * H3 請假的端到端測試組裝（只給 *.spec.ts）：H2 的 AdminHarness（真的 Nest HTTP、JwtStrategy、公司工作空間、
 * 記憶體版 Prisma 含請假單、假日、特休調整）再掛上 H3 的後台 controller，通知改成記錄呼叫的假物件。
 */
import { Provider, Type } from '@nestjs/common';
import { FakeIdp } from '../../auth/oidc/testing/fake-idp';
import { NotificationsService } from '../../notifications/notifications.service';
import { AdminHarness, COMPANY_WS } from '../../employees/testing/admin-harness';
import { AdminHolidaysController, AdminLeaveBalanceController } from '../leave-admin.controllers';

export { COMPANY_WS };

export class LeaveHarness extends AdminHarness {
  readonly notifications = { create: jest.fn(async () => undefined) };

  constructor(idp: FakeIdp, env: Record<string, string | undefined> = {}) {
    super(idp, env);
  }

  protected override extraControllers(): Type<unknown>[] {
    return [...super.extraControllers(), AdminHolidaysController, AdminLeaveBalanceController];
  }

  protected override extraProviders(): Provider[] {
    // 放在最後：覆蓋 SsoHarness 的 `{}`（同一個 token 以最後一個為準）
    return [...super.extraProviders(), { provide: NotificationsService, useValue: this.notifications }];
  }
}
