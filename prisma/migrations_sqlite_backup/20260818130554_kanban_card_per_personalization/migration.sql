/*
  Warnings:

  - Added the required column `personalizationId` to the `KanbanCard` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_KanbanCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "draftOrderId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "personalizationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'a_faire',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_KanbanCard" ("createdAt", "draftOrderId", "id", "orderId", "orderName", "shop", "status", "updatedAt") SELECT "createdAt", "draftOrderId", "id", "orderId", "orderName", "shop", "status", "updatedAt" FROM "KanbanCard";
DROP TABLE "KanbanCard";
ALTER TABLE "new_KanbanCard" RENAME TO "KanbanCard";
CREATE UNIQUE INDEX "KanbanCard_personalizationId_key" ON "KanbanCard"("personalizationId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
