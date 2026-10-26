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

  it('partial unique index：最多一個公司工作空間、根部門與子部門不分大小寫不重名', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "workspaces_single_company_key" ON "workspaces" (("isCompany")) WHERE "isCompany";');
    expect(sql).toContain('"departments_root_name_key" ON "departments" ("workspaceId", lower("name")) WHERE "parentId" IS NULL;');
    expect(sql).toContain(
      '"departments_child_name_key" ON "departments" ("workspaceId", "parentId", lower("name")) WHERE "parentId" IS NOT NULL;',
    );
  });

  it('review S2：users.sessionsValidAfter 欄位', () => {
    expect(sql).toMatch(/ALTER TABLE "users" ADD COLUMN\s+"sessionsValidAfter" TIMESTAMP\(3\)/);
  });

  it('review S1：H1 上線時撤銷全部還有效的 refresh token（所有人重新走 SSO），而且是最後一步', () => {
    const revoke = 'UPDATE "refresh_tokens" SET "revokedAt" = (NOW() AT TIME ZONE \'UTC\') WHERE "revokedAt" IS NULL;';
    expect(sql).toContain(revoke);
    expect(sql.trimEnd().endsWith(revoke)).toBe(true);
  });
});
