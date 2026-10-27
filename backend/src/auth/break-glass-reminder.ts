import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AuthConfig, getCompanyTimezone } from '../common/auth-config';

/**
 * 緊急登入仍開啟的提醒（spec §4.3）：只要設了 BREAK_GLASS_OWNER_EMAILS，啟動時印一次 warning，
 * 之後每天早上 9 點（COMPANY_TIMEZONE）再印一次，直到拿掉這個變數並重新部署。
 * 目前沒有「每日摘要」機制，所以先用 log；之後有摘要時改接到摘要裡。
 * log 只寫帳號數量，不寫 email。
 */
@Injectable()
export class BreakGlassReminder implements OnApplicationBootstrap {
  private readonly logger = new Logger(BreakGlassReminder.name);

  constructor(private authConfig: AuthConfig) {}

  onApplicationBootstrap(): void {
    this.remind();
  }

  @Cron('0 0 9 * * *', { name: 'break-glass-reminder', timeZone: getCompanyTimezone() })
  daily(): void {
    this.remind();
  }

  /** 有設名單就印 warning，回傳是否有印（測試用）。 */
  remind(): boolean {
    const count = this.authConfig.breakGlassOwnerEmails().length;
    if (count === 0) return false;
    this.logger.warn(
      `緊急登入仍開啟：BREAK_GLASS_OWNER_EMAILS 設了 ${count} 個帳號，這些公司 owner 可以用帳密登入。` +
        '緊急狀況解除後請拿掉這個環境變數並重新部署。',
    );
    return true;
  }
}
