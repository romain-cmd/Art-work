import prisma from "../db.server";
import { ARTWORK_TAG, snapshotPersonalization } from "./artwork-status";
import { fetchDraftLineItems, syncDraftPersonalizations } from "./draft-order-sync.server";

export const DRAFT_FIELDS = `id name email createdAt updatedAt status tags shippingAddress { company firstName lastName } billingAddress { firstName lastName } order { id name }`;
export const DRAFT_METADATA_QUERY = `#graphql
 query artworkDraft($id: ID!) { draftOrder(id: $id) { ${DRAFT_FIELDS} } }
`;
export const DRAFT_SEARCH_QUERY = `#graphql
 query artworkDrafts($query: String!, $after: String, $first: Int!) {
  draftOrders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
   nodes { ${DRAFT_FIELDS} } pageInfo { hasNextPage endCursor }
  }
 }
`;
export const ADD_TAG_QUERY = `#graphql
 mutation addArtworkTag($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }
`;
export const REMOVE_TAG_QUERY = `#graphql
 mutation removeArtworkTag($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }
`;
async function graphql(admin, query, variables) {
  const json = await (await admin.graphql(query, { variables })).json();
  if (json.errors?.length || !json.data) throw new Error("Shopify ne répond pas. Réessaie dans quelques instants.");
  return json.data;
}
export async function event(caseId, message, actor = "Équipe", db = prisma) {
  return db.artworkEvent.create({ data: { caseId, message, actor } });
}
export async function metadata(admin, id) {
  return (await graphql(admin, DRAFT_METADATA_QUERY, { id })).draftOrder;
}
export async function searchDrafts(admin, query, after = null, first = 20) {
  return (await graphql(admin, DRAFT_SEARCH_QUERY, { query, after, first })).draftOrders;
}
export async function setArtworkTag(admin, id, enabled) {
  const data = await graphql(admin, enabled ? ADD_TAG_QUERY : REMOVE_TAG_QUERY, { id, tags: [ARTWORK_TAG] });
  const result = enabled ? data.tagsAdd : data.tagsRemove;
  if (!result || result.userErrors?.length) throw new Error(result?.userErrors?.[0]?.message || "Impossible de modifier le tag du devis.");
}
export async function upsertCase(shop, draft, { activate = false } = {}) {
  const data = { name: draft.name, email: draft.email, customerName: [draft.shippingAddress?.firstName || draft.billingAddress?.firstName, draft.shippingAddress?.lastName || draft.billingAddress?.lastName].filter(Boolean).join(" ") || null,
    shopifyStatus: draft.status, orderId: draft.order?.id ?? null, orderName: draft.order?.name ?? null,
    shopifyCreatedAt: new Date(draft.createdAt), shopifyUpdatedAt: new Date(draft.updatedAt), syncedAt: new Date() };
  return prisma.artworkCase.upsert({ where: { shop_draftOrderId: { shop, draftOrderId: draft.id } },
    create: { shop, draftOrderId: draft.id, yachtName: draft.shippingAddress?.company || null, ...data },
    update: { ...data, ...(activate ? { archivedAt: null } : {}) } });
}
// The index caches metadata only. Full line-item reconciliation happens when a dossier is opened or a webhook arrives.
export async function indexCases(admin, shop, force = false) {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  if (!force && settings?.artworkIndexedAt && Date.now() - settings.artworkIndexedAt.getTime() < 45000) return;
  let after = null;
  do {
    const page = await searchDrafts(admin, `tag:${ARTWORK_TAG}`, after, 50);
    for (const draft of page.nodes) await upsertCase(shop, draft);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  const legacy = await prisma.artworkCase.findMany({ where: { shop, syncedAt: null } });
  for (const row of legacy) {
    const draft = await metadata(admin, row.draftOrderId);
    if (draft) await reconcileCase(admin, shop, draft);
    else await prisma.artworkCase.update({ where: { id: row.id }, data: { archivedAt: new Date(), syncedAt: new Date() } });
  }
  await prisma.shopSettings.upsert({ where: { shop }, create: { shop, artworkIndexedAt: new Date() }, update: { artworkIndexedAt: new Date() } });
}
export async function invalidateProofs(db, personalization, caseId, reason) {
  const oldProofs = await db.proof.findMany({ where: { personalizationId: personalization.id, isCurrent: true } });
  for (const old of oldProofs) {
    const retired = await db.proof.updateMany({ where: { id: old.id, isCurrent: true }, data: { isCurrent: false } });
    if (!retired.count) continue;
    await db.proof.create({ data: { personalizationId: personalization.id, imageUrl: old.imageUrl, mimeType: old.mimeType,
      fileName: old.fileName, version: old.version + 1, supersedesId: old.id, snapshot: snapshotPersonalization(personalization) } });
  }
  if (oldProofs.length) await event(caseId, reason + " Nouvelle validation requise.", "Équipe", db);
}
export async function reconcileCase(admin, shop, draft) {
  const dossier = await upsertCase(shop, draft);
  const items = (await fetchDraftLineItems(admin, draft.id, undefined, { includeCustom: true })).map(({ node }) => node);
  const before = await prisma.personalization.findMany({ where: { shop, draftOrderId: draft.id, isActive: true } });
  const previousItems = await prisma.artworkItem.findMany({ where: { shop, draftOrderId: draft.id, isActive: true } });
  await syncDraftPersonalizations(prisma, shop, draft.id, items);
  await prisma.$transaction(async (tx) => {
    await tx.artworkItem.updateMany({ where: { shop, draftOrderId: draft.id }, data: { isActive: false } });
    const ps = await tx.personalization.findMany({ where: { shop, draftOrderId: draft.id, isActive: true } });
    for (const item of items) {
      const same = previousItems.filter((i) => i.variantId && i.variantId === item.variant?.id);
      const newSame = items.filter((i) => i.variant?.id && i.variant.id === item.variant?.id);
      const old = previousItems.find((i) => i.lineItemId === item.id) || (same.length === 1 && newSame.length === 1 ? same[0] : null);
      const hasPersonalization = ps.some((p) => p.lineItemId === item.id);
      const data = { title: item.title, variantId: item.variant?.id ?? null, variantTitle: item.variant?.title ?? null,
        sku: item.variant?.sku ?? null, quantity: item.quantity, isActive: true };
      await tx.artworkItem.upsert({ where: { shop_draftOrderId_lineItemId: { shop, draftOrderId: draft.id, lineItemId: item.id } },
        create: { shop, draftOrderId: draft.id, lineItemId: item.id, ...data, requirement: hasPersonalization ? "required" : old?.requirement || "pending" }, update: data });
    }
    for (const old of before) {
      if (!ps.some((p) => p.id === old.id)) await event(dossier.id, `Article retiré ou correspondance Shopify ambiguë : ${old.productTitle}. BAT conservés dans l’historique.`, "Shopify", tx);
    }
    for (const p of ps) {
      const prev = before.find((old) => old.id === p.id);
      if (prev && (prev.quantity !== p.quantity || prev.productTitle !== p.productTitle)) {
        await invalidateProofs(tx, p, dossier.id, `Article Shopify modifié : ${p.productTitle}.`);
      }
    }
  });
  await ensureProductionCards(shop, draft.id);
  return dossier;
}
export async function ensureProductionCards(shop, draftOrderId) {
  const dossier = await prisma.artworkCase.findUnique({ where: { shop_draftOrderId: { shop, draftOrderId } } });
  if (!dossier?.orderId || dossier.archivedAt) return;
  const required = await prisma.artworkItem.findMany({ where: { shop, draftOrderId, isActive: true, requirement: "required" } });
  const ps = await prisma.personalization.findMany({ where: { shop, draftOrderId, isActive: true, lineItemId: { in: required.map((i) => i.lineItemId) } } });
  for (const p of ps) await prisma.kanbanCard.upsert({ where: { personalizationId: p.id },
    create: { shop, draftOrderId, orderId: dossier.orderId, orderName: dossier.orderName || dossier.name, personalizationId: p.id }, update: {} });
}
export async function readDossier(id, shop) {
  const dossier = await prisma.artworkCase.findFirst({ where: { id, shop }, include: { events: { orderBy: { createdAt: "desc" } } } });
  if (!dossier) return null;
  const [items, personalizations] = await Promise.all([
    prisma.artworkItem.findMany({ where: { shop, draftOrderId: dossier.draftOrderId, isActive: true }, orderBy: { id: "asc" } }),
    prisma.personalization.findMany({ where: { shop, draftOrderId: dossier.draftOrderId, isActive: true }, include: { proofs: { orderBy: [{ version: "desc" }, { createdAt: "desc" }] } }, orderBy: { createdAt: "asc" } }),
  ]);
  const removedPersonalizations = await prisma.personalization.findMany({ where: { shop, draftOrderId: dossier.draftOrderId, isActive: false }, include: { proofs: { orderBy: { createdAt: "desc" } } } });
  return { ...dossier, items, personalizations, removedPersonalizations };
}
