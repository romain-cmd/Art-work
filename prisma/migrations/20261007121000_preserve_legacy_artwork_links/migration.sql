-- Legacy approval links must work before the first admin-side Shopify sync.
-- Seed only lines already carrying active personalizations. Explicit new choices remain untouched.
INSERT INTO "ArtworkItem" ("id", "shop", "draftOrderId", "lineItemId", "variantId", "title", "quantity", "requirement", "isActive")
SELECT 'legacy_item_' || md5("shop" || ':' || "draftOrderId" || ':' || "lineItemId"),
       "shop", "draftOrderId", "lineItemId", MIN("variantId"), MIN("productTitle"),
       COALESCE(MAX("sourceQuantity"), MAX("quantity")), 'required', true
FROM "Personalization"
WHERE "isActive" = true
GROUP BY "shop", "draftOrderId", "lineItemId"
ON CONFLICT ("shop", "draftOrderId", "lineItemId") DO NOTHING;
