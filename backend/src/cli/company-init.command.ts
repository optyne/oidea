import { parseArgs } from 'util';
import { CompanyInitError, CompanyInitOptions, CompanyInitResult } from '../company/company-init.service';
import { CliIo } from './run-cli';

export interface CompanyInitDeps extends CliIo {
  init: (opts: CompanyInitOptions) => Promise<CompanyInitResult>;
}

export const COMPANY_INIT_USAGE = [
  '用法：',
  '  npm run company:init -- --workspace <id> --owner-email <email> [owner 員工資料]',
  '  npm run company:init -- --create <name> --owner-email <email> [--slug <slug>] [--executor-email <email>] [owner 員工資料]',
  'owner 員工資料（owner 還沒有員工資料時必填）：--employee-no <no> --full-name <name> --hire-date <YYYY-MM-DD> [--job-title <title>]',
  '--executor-email：--create 且 owner 還沒有綁定 SSO 的帳號時必填，暫時擔任 owner，owner 第一次 SSO 登入時移交（執行者之後降為 admin）',
  '--allow-existing-members：--workspace 指向的工作空間已有其他成員時，確認沿用他們（他們會變成公司成員，角色變成全公司的後台角色）',
  '注意：owner 的帳號還沒綁定 SSO 時（例如以前用帳密註冊的），不會直接成為 owner，要等他第一次 SSO 登入。',
].join('\n');

/** `npm run company:init`。成功 0，參數或狀態錯誤 1。 */
export async function runCompanyInit(argv: string[], deps: CompanyInitDeps): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        workspace: { type: 'string' },
        create: { type: 'string' },
        slug: { type: 'string' },
        'owner-email': { type: 'string' },
        'employee-no': { type: 'string' },
        'full-name': { type: 'string' },
        'hire-date': { type: 'string' },
        'job-title': { type: 'string' },
        'executor-email': { type: 'string' },
        'allow-existing-members': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    deps.err(`${(err as Error).message}\n${COMPANY_INIT_USAGE}`);
    return 1;
  }
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  if (values.help || !str('owner-email')) {
    deps.err(COMPANY_INIT_USAGE);
    return 1;
  }

  try {
    const res = await deps.init({
      workspaceId: str('workspace'),
      createName: str('create'),
      slug: str('slug'),
      ownerEmail: str('owner-email')!,
      employeeNo: str('employee-no'),
      fullName: str('full-name'),
      hireDate: str('hire-date'),
      jobTitle: str('job-title'),
      executorEmail: str('executor-email'),
      allowExistingMembers: values['allow-existing-members'] === true,
    });
    deps.out(`公司工作空間：${res.workspaceId}${res.workspaceCreated ? '（新建立）' : ''}`);
    deps.out(`owner 員工資料：${res.profile === 'created' ? '已建立' : '已存在'}（${res.profileId}）`);
    if (res.ownerUserId) {
      deps.out(`ownerId 已指向使用者 ${res.ownerUserId}`);
    } else {
      deps.out(
        `owner 還沒有綁定 SSO 的使用者帳號：已記為待移交（${res.pendingOwnerEmail}），他第一次 SSO 登入時會成為 owner`,
      );
    }
    if (res.existingMembers) {
      const c = res.existingMembers;
      deps.err(
        `警告：沿用了工作空間原本的成員（共 ${c.total} 位，其中 ${c.others} 位不是 owner；` +
          `${c.withoutProfile} 位不在員工主檔；${c.privileged} 位的角色是 owner/admin/hr/finance）。` +
          '他們現在都是公司成員，請在 H2 後台確認他們的角色。',
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof CompanyInitError) {
      deps.err(err.message);
      return 1;
    }
    throw err;
  }
}
