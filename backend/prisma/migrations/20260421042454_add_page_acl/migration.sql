-- AlterTable
ALTER TABLE "knowledge_pages" ADD COLUMN     "inheritParentAcl" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'workspace';

-- CreateTable
CREATE TABLE "page_permissions" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "userId" TEXT,
    "role" TEXT,
    "access" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "page_permissions_userId_idx" ON "page_permissions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "page_permissions_pageId_userId_key" ON "page_permissions"("pageId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "page_permissions_pageId_role_key" ON "page_permissions"("pageId", "role");

-- AddForeignKey
ALTER TABLE "page_permissions" ADD CONSTRAINT "page_permissions_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "knowledge_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_permissions" ADD CONSTRAINT "page_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

