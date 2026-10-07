import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ARTWORK_TAG } from "../lib/artwork-status";
import { metadata, reconcileCase } from "../lib/artwork-cases.server";

export const action = async ({ request }) => {
  const { payload, session, topic, shop, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  if (!session || !admin) return new Response();
  const id = payload.admin_graphql_api_id;
  if (!id) return new Response();
  const draft = await metadata(admin, id);
  if (!draft) return new Response();
  const existing = await prisma.artworkCase.findUnique({ where: { shop_draftOrderId: { shop, draftOrderId: id } } });
  if (!existing && !draft.tags.includes(ARTWORK_TAG)) return new Response();
  // Existing archived dossiers remain archived. Explicit reactivation happens in the app.
  await reconcileCase(admin, shop, draft);
  return new Response();
};
