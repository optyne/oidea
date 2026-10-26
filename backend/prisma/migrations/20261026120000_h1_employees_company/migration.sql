-- AlterTable
ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "isCompany" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pendingOwnerEmail" TEXT;

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "managerProfileId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "employeeNo" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "departmentId" TEXT,
    "jobTitle" TEXT NOT NULL DEFAULT '',
    "managerProfileId" TEXT,
    "employmentType" TEXT NOT NULL DEFAULT 'full_time',
    "employmentStatus" TEXT NOT NULL DEFAULT 'active',
    "hireDate" DATE NOT NULL,
    "terminationDate" DATE,
    "phone" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departments_workspaceId_parentId_idx" ON "departments"("workspaceId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_userId_key" ON "employee_profiles"("userId");

-- CreateIndex
CREATE INDEX "employee_profiles_workspaceId_departmentId_idx" ON "employee_profiles"("workspaceId", "departmentId");

-- CreateIndex
CREATE INDEX "employee_profiles_managerProfileId_idx" ON "employee_profiles"("managerProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_workspaceId_employeeNo_key" ON "employee_profiles"("workspaceId", "employeeNo");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_workspaceId_email_key" ON "employee_profiles"("workspaceId", "email");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_managerProfileId_fkey" FOREIGN KEY ("managerProfileId") REFERENCES "employee_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_managerProfileId_fkey" FOREIGN KEY ("managerProfileId") REFERENCES "employee_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 手寫的 partial unique index（spec §4.2）
--
-- Prisma 的 schema 語言表達不了 partial index 與運算式索引，所以以下三個索引只存在於這份
-- migration，schema.prisma 不宣告（各 model 旁有註解說明）。
--
-- 之後跑 `prisma migrate dev` / `prisma migrate diff --from-migrations ...` 不會產生 DROP：
-- Prisma 6（實測 6.19.2）的 Postgres schema describer 讀 pg_index 時以
-- `indpred IS NULL -- filter out partial indexes` 排除所有 partial index，
-- 所以 diff 的兩邊都看不到它們，也不會被當成 drift。
-- 注意：
--   * 若把它們改成「非 partial」的索引（拿掉 WHERE），Prisma 就會看到並嘗試 drop。
--   * `prisma db pull` 同樣看不到它們；不要依賴 introspection 重建 schema。
--   * `prisma migrate reset` 會照常重跑這份 SQL 建回來。
--   * 升級 Prisma 大版本時要重新確認（例如加了 partial index 支援之後，行為可能改變）。
-- ============================================================

-- 全庫最多一個公司工作空間
CREATE UNIQUE INDEX "workspaces_single_company_key" ON "workspaces" (("isCompany")) WHERE "isCompany";

-- 同一個工作空間裡，根部門不能同名（不分大小寫）。Postgres 把 NULL 視為互不相等，
-- 所以 @@unique([workspaceId, parentId, name]) 擋不住 parentId 為 NULL 的重名。
CREATE UNIQUE INDEX "departments_root_name_key" ON "departments" ("workspaceId", lower("name")) WHERE "parentId" IS NULL;

-- 同一個上層部門底下，子部門不能同名（不分大小寫）
CREATE UNIQUE INDEX "departments_child_name_key" ON "departments" ("workspaceId", "parentId", lower("name")) WHERE "parentId" IS NOT NULL;

