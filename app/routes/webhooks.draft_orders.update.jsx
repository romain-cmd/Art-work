import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fetchDraftLineItems, syncDraftPersonalizations } from "../lib/draft-order-sync.server";

// Se déclenche à chaque changement d'un devis brouillon Shopify.
// On crée une carte Kanban PAR PERSONNALISATION (pas par commande) quand
// le devis vient d'être complété en commande, car les différents produits
// d'une même commande peuvent partir chez des partenaires différents.
export const action = async ({ request }) => {
  const { payload, session, topic, shop, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!session || !admin) {
    return new Response();
  }

  const draftOrderId = payload.admin_graphql_api_id;
  const status = payload.status;
  const orderRestId = payload.order_id;

  // Read current Shopify data rather than an event snapshot: webhooks can be
  // delayed or delivered out of order. Every save reconciles existing BATs.
  const edges = await fetchDraftLineItems(admin, draftOrderId);
  await syncDraftPersonalizations(prisma, shop, draftOrderId, edges.map(({ node }) => node));

  if (status !== "completed" || !orderRestId) {
    return new Response();
  }

  const personalizations = await prisma.personalization.findMany({
    where: { shop, draftOrderId, isActive: true },
  });
  if (personalizations.length === 0) {
    return new Response();
  }

  const existingCards = await prisma.kanbanCard.findMany({
    where: { personalizationId: { in: personalizations.map((p) => p.id) } },
  });
  const alreadyHasCard = new Set(existingCards.map((c) => c.personalizationId));
  const toCreate = personalizations.filter((p) => !alreadyHasCard.has(p.id));

  if (toCreate.length === 0) {
    return new Response();
  }

  const orderId = `gid://shopify/Order/${orderRestId}`;
  const orderResponse = await admin.graphql(
    `#graphql
      query getOrder($id: ID!) {
        order(id: $id) {
          name
        }
      }`,
    { variables: { id: orderId } }
  );
  const orderJson = await orderResponse.json();
  const orderName = orderJson.data?.order?.name ?? payload.name;

  await prisma.kanbanCard.createMany({
    skipDuplicates: true,
    data: toCreate.map((personalization) => ({
      shop,
      draftOrderId,
      orderId,
      orderName,
      personalizationId: personalization.id,
      status: "a_faire",
    })),
  });

  return new Response();
};
