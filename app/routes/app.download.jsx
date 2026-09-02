import { authenticate } from "../shopify.server";

// Proxy de téléchargement : force le navigateur à télécharger le fichier
// (plutôt que de simplement l'ouvrir) via l'en-tête Content-Disposition.
// Restreint aux domaines Shopify pour éviter d'en faire un proxy ouvert.
const ALLOWED_HOSTS = ["cdn.shopify.com", "cdn.shopifycdn.net"];

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const fileUrl = url.searchParams.get("url");
  const filename = url.searchParams.get("filename") || "fichier";

  if (!fileUrl) {
    throw new Response("Missing url parameter", { status: 400 });
  }

  let parsed;
  try {
    parsed = new URL(fileUrl);
  } catch {
    throw new Response("Invalid url", { status: 400 });
  }
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new Response("Host not allowed", { status: 400 });
  }

  const fileResponse = await fetch(fileUrl);
  if (!fileResponse.ok || !fileResponse.body) {
    throw new Response("Failed to fetch file", { status: 502 });
  }

  const headers = new Headers();
  headers.set(
    "Content-Type",
    fileResponse.headers.get("Content-Type") || "application/octet-stream"
  );
  headers.set("Content-Disposition", `attachment; filename="${filename}"`);

  return new Response(fileResponse.body, { headers });
};
