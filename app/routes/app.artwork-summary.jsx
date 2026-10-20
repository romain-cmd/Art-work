import { authenticate } from "../shopify.server";
import db from "../db.server";
import { summaryResponse } from "../lib/artwork-summary-pdf.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return summaryResponse(db, { shop: session.shop, id: new URL(request.url).searchParams.get("proof") });
};
