ALTER TABLE "Personalization" ADD COLUMN "logoMimeType" TEXT, ADD COLUMN "logoFileName" TEXT, ADD COLUMN "dimensions" TEXT;
ALTER TABLE "Proof" ADD COLUMN "fileName" TEXT, ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1, ADD COLUMN "isCurrent" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "supersedesId" TEXT, ADD COLUMN "snapshot" JSONB, ADD COLUMN "approvedVia" TEXT;
ALTER TABLE "KanbanCard" ADD COLUMN "archivedAt" TIMESTAMP(3), ADD COLUMN "lastSentAt" TIMESTAMP(3), ADD COLUMN "lastSentTo" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN "artworkIndexedAt" TIMESTAMP(3);
CREATE TABLE "ArtworkCase" ("id" TEXT NOT NULL, "shop" TEXT NOT NULL, "draftOrderId" TEXT NOT NULL, "name" TEXT NOT NULL, "email" TEXT, "customerName" TEXT, "yachtName" TEXT, "shopifyStatus" TEXT NOT NULL DEFAULT 'OPEN', "orderId" TEXT, "orderName" TEXT, "shopifyCreatedAt" TIMESTAMP(3), "shopifyUpdatedAt" TIMESTAMP(3), "syncedAt" TIMESTAMP(3), "archivedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ArtworkCase_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "ArtworkCase_shop_draftOrderId_key" ON "ArtworkCase"("shop", "draftOrderId");
CREATE INDEX "ArtworkCase_shop_archivedAt_shopifyUpdatedAt_idx" ON "ArtworkCase"("shop", "archivedAt", "shopifyUpdatedAt");
CREATE TABLE "ArtworkItem" ("id" TEXT NOT NULL, "shop" TEXT NOT NULL, "draftOrderId" TEXT NOT NULL, "lineItemId" TEXT NOT NULL, "variantId" TEXT, "title" TEXT NOT NULL, "variantTitle" TEXT, "sku" TEXT, "quantity" INTEGER NOT NULL, "requirement" TEXT NOT NULL DEFAULT 'pending', "isActive" BOOLEAN NOT NULL DEFAULT true, CONSTRAINT "ArtworkItem_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "ArtworkItem_shop_draftOrderId_lineItemId_key" ON "ArtworkItem"("shop", "draftOrderId", "lineItemId");
CREATE INDEX "ArtworkItem_shop_draftOrderId_isActive_idx" ON "ArtworkItem"("shop", "draftOrderId", "isActive");
CREATE TABLE "ArtworkEvent" ("id" TEXT NOT NULL, "caseId" TEXT NOT NULL, "message" TEXT NOT NULL, "actor" TEXT NOT NULL DEFAULT 'Équipe', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ArtworkEvent_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ArtworkEvent_caseId_createdAt_idx" ON "ArtworkEvent"("caseId", "createdAt");
ALTER TABLE "ArtworkEvent" ADD CONSTRAINT "ArtworkEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ArtworkCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Preserve legacy artwork dossiers without adding tags or changing Shopify.
INSERT INTO "ArtworkCase" ("id", "shop", "draftOrderId", "name", "createdAt") SELECT 'legacy_' || md5("shop" || ':' || "draftOrderId"), "shop", "draftOrderId", 'Devis ' || regexp_replace("draftOrderId", '^.*/', ''), MIN("createdAt") FROM "Personalization" GROUP BY "shop", "draftOrderId";
-- Snapshot the exact specifications attached to legacy proofs before future edits.
UPDATE "Proof" AS pr SET "snapshot" = jsonb_build_object('productTitle', p."productTitle", 'type', p."type", 'quantity', p."quantity", 'size', p."size", 'dimensions', p."dimensions", 'color', p."color", 'location', p."location", 'customText', p."customText", 'logoUrl', p."logoUrl") FROM "Personalization" p WHERE p."id" = pr."personalizationId";
