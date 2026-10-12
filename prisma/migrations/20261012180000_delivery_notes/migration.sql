-- Additive migration. Existing artwork and production tables are untouched.
CREATE TABLE "DeliveryRepresentative" (
  "id" TEXT PRIMARY KEY, "shop" TEXT NOT NULL, "name" TEXT NOT NULL, "email" TEXT,
  "accessHash" TEXT NOT NULL UNIQUE, "pinHash" TEXT NOT NULL, "isActive" BOOLEAN NOT NULL DEFAULT true,
  "failedAttempts" INTEGER NOT NULL DEFAULT 0, "lockedUntil" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DeliveryRepresentative_shop_isActive_idx" ON "DeliveryRepresentative"("shop", "isActive");
CREATE TABLE "DeliverySession" (
  "id" TEXT PRIMARY KEY, "representativeId" TEXT NOT NULL REFERENCES "DeliveryRepresentative"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "tokenHash" TEXT NOT NULL UNIQUE, "csrf" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DeliverySession_representativeId_expiresAt_idx" ON "DeliverySession"("representativeId", "expiresAt");
CREATE TABLE "DeliveryNote" (
  "id" TEXT PRIMARY KEY, "number" SERIAL NOT NULL UNIQUE, "shop" TEXT NOT NULL, "orderId" TEXT NOT NULL, "orderName" TEXT NOT NULL,
  "representativeId" TEXT NOT NULL REFERENCES "DeliveryRepresentative"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'READY' CHECK ("status" IN ('READY', 'SIGNED', 'VOID')),
  "revision" INTEGER NOT NULL DEFAULT 1, "sourceHash" TEXT NOT NULL, "searchText" TEXT NOT NULL DEFAULT '', "snapshot" JSONB NOT NULL,
  "createKey" TEXT NOT NULL, "createHash" TEXT NOT NULL, "signatureKey" TEXT, "receipt" JSONB,
  "signedAt" TIMESTAMP(3), "proofHash" TEXT, "emailTo" TEXT, "emailFrom" TEXT,
  "emailState" TEXT NOT NULL DEFAULT 'NOT_REQUESTED', "emailFirstAttemptAt" TIMESTAMP(3), "emailLockAt" TIMESTAMP(3),
  "emailSentAt" TIMESTAMP(3), "emailId" TEXT, "emailError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeliveryNote_shop_createKey_key" UNIQUE ("shop", "createKey")
);
CREATE INDEX "DeliveryNote_shop_orderId_status_idx" ON "DeliveryNote"("shop", "orderId", "status");
CREATE INDEX "DeliveryNote_representativeId_status_createdAt_idx" ON "DeliveryNote"("representativeId", "status", "createdAt");
CREATE TABLE "DeliveryDocument" (
  "noteId" TEXT PRIMARY KEY REFERENCES "DeliveryNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "pdf" BYTEA NOT NULL, "sha256" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "DeliveryEvent" (
  "id" TEXT PRIMARY KEY, "noteId" TEXT NOT NULL REFERENCES "DeliveryNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actor" TEXT NOT NULL, "kind" TEXT NOT NULL, "details" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DeliveryEvent_noteId_createdAt_idx" ON "DeliveryEvent"("noteId", "createdAt");
CREATE FUNCTION protect_signed_delivery() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'SIGNED' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Signed delivery notes cannot be deleted'; END IF;
    IF (to_jsonb(OLD) - ARRAY['emailState','emailFirstAttemptAt','emailLockAt','emailSentAt','emailId','emailError','updatedAt'])
       IS DISTINCT FROM
       (to_jsonb(NEW) - ARRAY['emailState','emailFirstAttemptAt','emailLockAt','emailSentAt','emailId','emailError','updatedAt'])
    THEN RAISE EXCEPTION 'Signed delivery notes are immutable'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "DeliveryNote_immutable" BEFORE UPDATE OR DELETE ON "DeliveryNote" FOR EACH ROW EXECUTE FUNCTION protect_signed_delivery();
CREATE FUNCTION protect_delivery_evidence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Delivery evidence is append-only'; END; $$;
CREATE TRIGGER "DeliveryDocument_immutable" BEFORE UPDATE OR DELETE ON "DeliveryDocument" FOR EACH ROW EXECUTE FUNCTION protect_delivery_evidence();
CREATE TRIGGER "DeliveryEvent_immutable" BEFORE UPDATE OR DELETE ON "DeliveryEvent" FOR EACH ROW EXECUTE FUNCTION protect_delivery_evidence();
