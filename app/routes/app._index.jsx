import { useEffect } from "react";
import { useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

// La page d'accueil de l'app (générée par le template Shopify au départ)
// n'a pas d'usage ici : on redirige vers Personnalisation. La redirection se
// fait côté client (après un rendu normal de la page) plutôt que côté
// serveur, car un throw redirect() dans le loader contourne le rendu HTML
// habituel (entry.server.jsx) et casse l'affichage dans l'iframe Shopify.
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate("/app/personnalisation", { replace: true });
  }, [navigate]);

  return null;
}
