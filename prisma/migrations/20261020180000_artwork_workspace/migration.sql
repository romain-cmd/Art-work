ALTER TABLE "ArtworkCase" ADD COLUMN "responsibleName" TEXT;
CREATE TABLE "ArtworkTemplate" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "specs" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ArtworkTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ArtworkTemplate_shop_name_idx" ON "ArtworkTemplate"("shop", "name");
