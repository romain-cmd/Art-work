-- Keep the legacy owner and every proof/token/approval unchanged.
ALTER TABLE "Proof" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE TABLE "_ProofMarkings" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,
  CONSTRAINT "_ProofMarkings_AB_pkey" PRIMARY KEY ("A", "B")
);
CREATE INDEX "_ProofMarkings_B_index" ON "_ProofMarkings"("B");
ALTER TABLE "_ProofMarkings" ADD CONSTRAINT "_ProofMarkings_A_fkey" FOREIGN KEY ("A") REFERENCES "Personalization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_ProofMarkings" ADD CONSTRAINT "_ProofMarkings_B_fkey" FOREIGN KEY ("B") REFERENCES "Proof"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Preserve files imported by the previous app during a rolling deployment.
CREATE FUNCTION link_artwork_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "_ProofMarkings" ("A", "B") VALUES (NEW."personalizationId", NEW."id") ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER proof_owner_link AFTER INSERT ON "Proof" FOR EACH ROW EXECUTE FUNCTION link_artwork_owner();
INSERT INTO "_ProofMarkings" ("A", "B") SELECT "personalizationId", "id" FROM "Proof";

-- Group variants by actual Shopify product, retaining their size/color separately.
ALTER TABLE "ArtworkItem" ADD COLUMN "productId" TEXT;
ALTER TABLE "ArtworkItem" ADD COLUMN "sizeLabel" TEXT;
ALTER TABLE "ArtworkItem" ADD COLUMN "colorLabel" TEXT;
