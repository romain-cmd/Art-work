import db from "../db.server";
import { summaryResponse } from "../lib/artwork-summary-pdf.server";

export const loader = async ({ request }) => summaryResponse(db, { token: new URL(request.url).searchParams.get("token") });
