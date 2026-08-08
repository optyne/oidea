-- CreateTable
CREATE TABLE "whiteboard_pages" (
    "id" TEXT NOT NULL,
    "whiteboardId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "drawing" BYTEA,
    "thumbnailId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "whiteboard_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whiteboard_pages_whiteboardId_deletedAt_idx" ON "whiteboard_pages"("whiteboardId", "deletedAt");

-- AddForeignKey
ALTER TABLE "whiteboard_pages" ADD CONSTRAINT "whiteboard_pages_whiteboardId_fkey" FOREIGN KEY ("whiteboardId") REFERENCES "whiteboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
