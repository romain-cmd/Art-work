// Shopify can replace draft line IDs when a draft is saved. Keep BATs attached
// to the same variant, but never guess between duplicate product lines.
export function planPersonalizationSync(personalizations, items) {
  const groups = new Map();
  for (const p of personalizations) {
    if (!groups.has(p.lineItemId)) groups.set(p.lineItemId, []);
    groups.get(p.lineItemId).push(p);
  }
  const claimed = new Set();
  const matches = new Map();
  for (const [oldId, group] of groups) {
    const item = items.find((i) => i.id === oldId &&
      (!group[0].variantId || i.variant?.id === group[0].variantId));
    if (item) {
      matches.set(oldId, item);
      claimed.add(item.id);
    }
  }
  // Only remap a unique old line to a unique new line of the same variant.
  // For legacy records without variant IDs, a unique title is the fallback.
  for (const [oldId, group] of groups) {
    if (matches.has(oldId) || !group.some((p) => p.isActive)) continue;
    const p = group[0];
    const sameProduct = (i) => p.variantId
      ? i.variant?.id === p.variantId
      : i.title === p.productTitle;
    const candidates = items.filter((i) => !claimed.has(i.id) && sameProduct(i));
    const oldCandidates = [...groups.entries()].filter(([id, rows]) =>
      !matches.has(id) && rows.some((row) => row.isActive) &&
      (p.variantId ? rows[0].variantId === p.variantId
        : !rows[0].variantId && rows[0].productTitle === p.productTitle));
    if (candidates.length === 1 && oldCandidates.length === 1) {
      matches.set(oldId, candidates[0]);
      claimed.add(candidates[0].id);
    }
  }
  return personalizations.flatMap((p) => {
    const item = matches.get(p.lineItemId);
    const data = item ? {
      lineItemId: item.id,
      variantId: item.variant?.id ?? null,
      productTitle: item.title,
      sourceQuantity: item.quantity,
      // Preserve manually chosen personalization quantities until Shopify's
      // quantity actually changes (legacy records are initialized on first sync).
      quantity: p.sourceQuantity !== item.quantity ? item.quantity : p.quantity,
      isActive: true,
    } : { isActive: false };
    return Object.entries(data).some(([key, value]) => p[key] !== value)
      ? [{ id: p.id, data }] : [];
  });
}

export const DRAFT_LINE_ITEMS_QUERY = `#graphql
  query getDraftLineItems($id: ID!, $after: String) {
    draftOrder(id: $id) {
      id
      lineItems(first: 250, after: $after) {
        edges { node { id title quantity custom variant { id title sku } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

export async function fetchDraftLineItems(admin, draftOrderId, connection, { includeCustom = false } = {}) {
  const edges = connection ? [...connection.edges] : [];
  let pageInfo = connection?.pageInfo ?? { hasNextPage: true, endCursor: null };
  while (pageInfo.hasNextPage) {
    const response = await admin.graphql(DRAFT_LINE_ITEMS_QUERY, {
      variables: { id: draftOrderId, after: pageInfo.endCursor },
    });
    const json = await response.json();
    if (json.errors?.length || !json.data?.draftOrder) {
      throw new Error("Impossible de récupérer les articles du devis Shopify.");
    }
    const next = json.data.draftOrder.lineItems;
    edges.push(...next.edges);
    pageInfo = next.pageInfo;
  }
  return includeCustom ? edges : edges.filter(({ node }) => !node.custom);
}

export async function syncDraftPersonalizations(db, shop, draftOrderId, items) {
  return db.$transaction(async (tx) => {
    const personalizations = await tx.personalization.findMany({
      where: { shop, draftOrderId },
    });
    for (const { id, data } of planPersonalizationSync(personalizations, items)) {
      await tx.personalization.update({ where: { id }, data });
    }
  });
}
