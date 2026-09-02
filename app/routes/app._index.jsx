import { redirect } from "react-router";
import { authenticate } from "../shopify.server";

// La page d'accueil de l'app (générée par le template Shopify au départ)
// n'a pas d'usage ici : on redirige directement vers Personnalisation.
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  throw redirect("/app/personnalisation");
};
