ALTER TABLE "Personalization"
ADD COLUMN "variantId" TEXT,
ADD COLUMN "sourceQuantity" INTEGER,
ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
