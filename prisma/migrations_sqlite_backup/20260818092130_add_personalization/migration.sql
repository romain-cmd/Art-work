-- CreateTable
CREATE TABLE "Personalization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "draftOrderId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "size" TEXT,
    "color" TEXT,
    "location" TEXT,
    "customText" TEXT,
    "logoUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
