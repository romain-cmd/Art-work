import db from "../db.server.js";
import {
  mobileSession,
  PRIVATE_HEADERS,
} from "../lib/delivery-access.server.js";
import { deliveryDocument } from "../lib/delivery-notes.server.js";
import { DeliveryError } from "../lib/delivery-core.server.js";
export async function loader({ request }) {
  const session = await mobileSession(db, request);
  if (!session)
    return new Response("Sign in to access this document.", {
      status: 401,
      headers: PRIVATE_HEADERS,
    });
  try {
    const document = await deliveryDocument(
      db,
      session.representative.shop,
      new URL(request.url).searchParams.get("note") || "",
      session.representativeId,
    );
    return new Response(document.pdf, {
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${document.filename}"`,
      },
    });
  } catch (error) {
    return new Response(
      error instanceof DeliveryError ? error.message : "Document unavailable.",
      {
        status: error instanceof DeliveryError ? error.status : 500,
        headers: PRIVATE_HEADERS,
      },
    );
  }
}
