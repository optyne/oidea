-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "broadcastId" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "recurrence" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "recurrenceInterval" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "recurringSourceId" TEXT,
ADD COLUMN     "sourceMessageId" TEXT;

-- CreateTable
CREATE TABLE "databases" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "databases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_columns" (
    "id" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" JSONB,
    "position" INTEGER NOT NULL DEFAULT 0,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_rows" (
    "id" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "database_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_cells" (
    "id" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "columnId" TEXT NOT NULL,
    "value" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_cells_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_snippets" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "shortcut" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'personal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "message_snippets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "triggerConfig" JSONB,
    "action" TEXT NOT NULL,
    "actionConfig" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_messages" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "channelIds" TEXT[],
    "content" TEXT,
    "type" TEXT NOT NULL DEFAULT 'text',
    "metadata" JSONB,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sentAt" TIMESTAMP(3),
    "sentBroadcastId" TEXT,
    "failedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "scheduled_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "triggerAt" TIMESTAMP(3) NOT NULL,
    "recurrence" TEXT NOT NULL DEFAULT 'none',
    "recurrenceInterval" INTEGER NOT NULL DEFAULT 1,
    "nextFireAt" TIMESTAMP(3) NOT NULL,
    "lastFiredAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "databases_workspaceId_deletedAt_idx" ON "databases"("workspaceId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "database_columns_databaseId_name_key" ON "database_columns"("databaseId", "name");

-- CreateIndex
CREATE INDEX "database_rows_databaseId_deletedAt_position_idx" ON "database_rows"("databaseId", "deletedAt", "position");

-- CreateIndex
CREATE UNIQUE INDEX "database_cells_rowId_columnId_key" ON "database_cells"("rowId", "columnId");

-- CreateIndex
CREATE INDEX "message_snippets_workspaceId_deletedAt_visibility_idx" ON "message_snippets"("workspaceId", "deletedAt", "visibility");

-- CreateIndex
CREATE INDEX "message_snippets_createdBy_deletedAt_idx" ON "message_snippets"("createdBy", "deletedAt");

-- CreateIndex
CREATE INDEX "automation_rules_scope_scopeId_trigger_enabled_deletedAt_idx" ON "automation_rules"("scope", "scopeId", "trigger", "enabled", "deletedAt");

-- CreateIndex
CREATE INDEX "automation_rules_workspaceId_deletedAt_idx" ON "automation_rules"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "scheduled_messages_sendAt_status_deletedAt_idx" ON "scheduled_messages"("sendAt", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "scheduled_messages_workspaceId_deletedAt_idx" ON "scheduled_messages"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "reminders_nextFireAt_status_deletedAt_idx" ON "reminders"("nextFireAt", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "reminders_workspaceId_deletedAt_idx" ON "reminders"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "messages_broadcastId_idx" ON "messages"("broadcastId");

-- CreateIndex
CREATE INDEX "tasks_sourceMessageId_idx" ON "tasks"("sourceMessageId");

-- CreateIndex
CREATE INDEX "tasks_recurringSourceId_idx" ON "tasks"("recurringSourceId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_recurringSourceId_fkey" FOREIGN KEY ("recurringSourceId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_columns" ADD CONSTRAINT "database_columns_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "databases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "databases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_cells" ADD CONSTRAINT "database_cells_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "database_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_cells" ADD CONSTRAINT "database_cells_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "database_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_snippets" ADD CONSTRAINT "message_snippets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_snippets" ADD CONSTRAINT "message_snippets_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

