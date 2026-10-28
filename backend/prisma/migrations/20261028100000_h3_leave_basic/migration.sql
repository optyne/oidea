-- H3 basic leave rules: half days, stored day count, holidays, annual-leave balance adjustments.

-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "days" DECIMAL(5,1),
ADD COLUMN     "endPart" TEXT NOT NULL DEFAULT 'full',
ADD COLUMN     "startPart" TEXT NOT NULL DEFAULT 'full';

-- Backfill: before H3 there were no holidays and no half days, so an existing request
-- takes the number of Mon-Fri dates in [startDate, endDate] (0 if the range is empty).
UPDATE "leave_requests" SET "days" = (
    SELECT COUNT(*)
    FROM generate_series("leave_requests"."startDate"::timestamp, "leave_requests"."endDate"::timestamp, interval '1 day') AS g(d)
    WHERE EXTRACT(ISODOW FROM g.d) < 6
);

ALTER TABLE "leave_requests" ALTER COLUMN "days" SET NOT NULL;

-- CreateTable
CREATE TABLE "holidays" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balance_adjustments" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "periodIndex" INTEGER NOT NULL,
    "days" DECIMAL(5,1) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_balance_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "holidays_workspaceId_date_key" ON "holidays"("workspaceId", "date");

-- CreateIndex
CREATE INDEX "leave_balance_adjustments_profileId_periodIndex_idx" ON "leave_balance_adjustments"("profileId", "periodIndex");

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance_adjustments" ADD CONSTRAINT "leave_balance_adjustments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance_adjustments" ADD CONSTRAINT "leave_balance_adjustments_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "employee_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance_adjustments" ADD CONSTRAINT "leave_balance_adjustments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
