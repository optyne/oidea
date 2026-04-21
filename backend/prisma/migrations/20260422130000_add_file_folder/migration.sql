-- AlterTable
ALTER TABLE "files" ADD COLUMN "folderPath" TEXT;

-- CreateIndex
CREATE INDEX "files_workspaceId_folderPath_deletedAt_idx" ON "files"("workspaceId", "folderPath", "deletedAt");
