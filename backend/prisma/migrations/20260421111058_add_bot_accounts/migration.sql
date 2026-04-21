-- CreateTable
CREATE TABLE "bot_accounts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "bot_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_accounts_userId_key" ON "bot_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "bot_accounts_tokenPrefix_key" ON "bot_accounts"("tokenPrefix");

-- CreateIndex
CREATE INDEX "bot_accounts_workspaceId_revokedAt_idx" ON "bot_accounts"("workspaceId", "revokedAt");

-- AddForeignKey
ALTER TABLE "bot_accounts" ADD CONSTRAINT "bot_accounts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_accounts" ADD CONSTRAINT "bot_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_accounts" ADD CONSTRAINT "bot_accounts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

