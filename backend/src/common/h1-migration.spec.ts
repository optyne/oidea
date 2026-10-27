import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * H1 migration 的手寫部分（Prisma 產生不出來的）：釘住，避免重產 SQL 時被弄掉。
 * schema 的部分由 `prisma migrate diff`（h0 schema → 現在的 schema）產生，比對方式見 DEPLOY_DOKPLOY.md。
 */
describe('migration 20261026120000_h1_employees_company（手寫部分）', () => {
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20261026120000_h1_employees_company/migration.sql'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const REVOKE_REFRESH = 'UPDATE "refresh_tokens" SET "revokedAt" = (NOW() AT TIME ZONE \'UTC\') WHERE "revokedAt" IS NULL;';
  const REVOKE_BOTS = 'UPDATE "bot_accounts" SET "revokedAt" = (NOW() AT TIME ZONE \'UTC\') WHERE "revokedAt" IS NULL;';

  it('partial unique index：最多一個公司工作空間、根部門與子部門不分大小寫不重名', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "workspaces_single_company_key" ON "workspaces" (("isCompany")) WHERE "isCompany";');
    expect(sql).toContain('"departments_root_name_key" ON "departments" ("workspaceId", lower("name")) WHERE "parentId" IS NULL;');
    expect(sql).toContain(
      '"departments_child_name_key" ON "departments" ("workspaceId", "parentId", lower("name")) WHERE "parentId" IS NOT NULL;',
    );
  });

  it('review R1：users.tokenVersion 與 refresh_tokens.tokenVersion（NOT NULL DEFAULT 0）；不再有 sessionsValidAfter', () => {
    expect(sql).toMatch(/ALTER TABLE "users" ADD COLUMN\s+"tokenVersion" INTEGER NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/ALTER TABLE "refresh_tokens" ADD COLUMN\s+"tokenVersion" INTEGER NOT NULL DEFAULT 0/);
    expect(sql).not.toContain('sessionsValidAfter');
  });

  it('review S1：H1 上線時撤銷全部還有效的 refresh token（所有人重新走 SSO），而且是最後一步', () => {
    expect(sql).toContain(REVOKE_REFRESH);
    expect(sql.trimEnd().endsWith(REVOKE_REFRESH)).toBe(true);
  });

  it('review R3：H1 上線時撤銷全部既有的 bot token（跟綁定流程一樣設 revokedAt），在建表／加欄位之後', () => {
    expect(sql).toContain(REVOKE_BOTS);
    expect(sql.indexOf(REVOKE_BOTS)).toBeGreaterThan(sql.indexOf('CREATE UNIQUE INDEX "workspaces_single_company_key"'));
    // 撤銷只出現一次，而且不是整表刪除（bot 的訊息、檔案等歷史要留著）
    expect(sql.split(REVOKE_BOTS)).toHaveLength(2);
    expect(sql).not.toMatch(/DELETE FROM "bot_accounts"/);
  });
});
