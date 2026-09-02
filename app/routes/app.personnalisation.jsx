/* eslint-disable react/prop-types -- no PropTypes package in this project */
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { uploadFileToShopify } from "../lib/shopify-files.server";
import { sendProofValidationEmail } from "../lib/send-proof-email.server";
import { ORDER_STATUS_COLORS } from "../lib/design-tokens";

const STATUS_BADGE = {
  en_attente: { label: "En attente", tone: "info" },
  approuve: { label: "Approuvé", tone: "success" },
  modification_demandee: { label: "Modification demandée", tone: "critical" },
};

const PROOF_ACCENT = {
  en_attente: "#D97706",
  approuve: "#059669",
  modification_demandee: "#DC2626",
};

// Styles injectés localement : les composants Polaris (s-box, s-section)
// rendent dans un Shadow DOM inaccessible depuis l'extérieur, donc les
// cartes ci-dessous sont des divs classiques pour permettre les accents
// de couleur par statut (comme les étiquettes Trello).
const PAGE_STYLES = `
  .pz-filter-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }
  .pz-filter-pill {
    appearance: none;
    cursor: pointer;
    border: 1px solid #cbd5e1;
    background: #ffffff;
    color: #1a2233;
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 600;
    transition: border-color 0.15s ease, background-color 0.15s ease, color 0.15s ease;
  }
  .pz-filter-pill:hover {
    border-color: #0b2545;
  }
  .pz-filter-pill--active {
    background: #0b2545;
    border-color: #0b2545;
    color: #ffffff;
  }
  .pz-order-card {
    background: #ffffff;
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
    border-left: 5px solid var(--pz-accent, #cbd5e1);
  }
  .pz-order-date {
    font-size: 12px;
    color: #94a3b8;
    margin: 2px 0 8px;
  }
  .pz-proof-card {
    background: #ffffff;
    border: 1px solid #e4e7ec;
    border-left: 4px solid var(--pz-proof-accent, #cbd5e1);
    border-radius: 8px;
    padding: 10px;
    width: 160px;
  }
  .pz-link-btn {
    appearance: none;
    background: none;
    border: none;
    padding: 0;
    font-size: 12px;
    color: #0b2545;
    text-decoration: underline;
    cursor: pointer;
  }
`;

// Ordre d'affichage des proofs dans une carte : les modifications
// demandées remontent en premier pour sauter aux yeux.
const STATUS_ORDER = {
  modification_demandee: 0,
  en_attente: 1,
  approuve: 2,
};

function sortProofsByStatus(proofs) {
  return [...proofs].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 1) - (STATUS_ORDER[b.status] ?? 1)
  );
}

// Statut global d'une commande, pour le filtre de la page : classe la
// commande dans la catégorie la plus urgente parmi ses personnalisations,
// pour qu'une tâche pressante ne se cache jamais dans un onglet "calme".
const STATUS_FILTERS = [
  { key: "a_personnaliser", label: "À personnaliser" },
  { key: "a_envoyer", label: "À envoyer" },
  { key: "en_attente_reponse", label: "En attente de réponse" },
  { key: "a_corriger", label: "À corriger" },
  { key: "valide", label: "Validé" },
];

function getOrderStatus(orderPersonalizations) {
  if (orderPersonalizations.length === 0) return "a_personnaliser";

  const allProofs = orderPersonalizations.flatMap((p) => p.proofs);

  if (allProofs.some((p) => p.status === "modification_demandee")) {
    return "a_corriger";
  }
  if (allProofs.length === 0 || allProofs.some((p) => p.status === "en_attente" && !p.envoyeLe)) {
    return "a_envoyer";
  }
  if (allProofs.some((p) => p.status === "en_attente" && p.envoyeLe)) {
    return "en_attente_reponse";
  }
  return "valide";
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query getDraftOrders {
        draftOrders(first: 50, query: "status:open OR status:completed") {
          edges {
            node {
              id
              name
              createdAt
              lineItems(first: 20) {
                edges {
                  node {
                    id
                    title
                    quantity
                  }
                }
              }
            }
          }
        }
      }`
  );

  const data = await response.json();
  const draftOrders = data.data.draftOrders.edges.map((edge) => edge.node);
  const draftOrderIds = draftOrders.map((order) => order.id);

  const personalizations = await prisma.personalization.findMany({
    where: { shop: session.shop, draftOrderId: { in: draftOrderIds } },
    include: { proofs: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "asc" },
  });

  return { draftOrders, personalizations };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // --- Ajouter une ou plusieurs images de proof à une personnalisation ---
  if (intent === "add-proofs") {
    const personalizationId = formData.get("personalizationId");

    const personalization = await prisma.personalization.findUnique({
      where: { id: personalizationId },
    });
    if (!personalization || personalization.shop !== session.shop) {
      return { success: false, error: "Personnalisation introuvable." };
    }

    const files = formData
      .getAll("proofImages")
      .filter((file) => file && file.size > 0);

    if (files.length === 0) {
      return { success: false, error: "Choisis au moins une image." };
    }

    try {
      for (const file of files) {
        const imageUrl = await uploadFileToShopify(admin, file);
        await prisma.proof.create({
          data: { personalizationId, imageUrl, mimeType: file.type || null },
        });
      }
    } catch (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  // --- Remplacer le logo d'une personnalisation (erreur ou changement client) ---
  if (intent === "update-logo") {
    const personalizationId = formData.get("personalizationId");
    const newLogo = formData.get("newLogo");

    const personalization = await prisma.personalization.findUnique({
      where: { id: personalizationId },
    });
    if (!personalization || personalization.shop !== session.shop) {
      return { success: false, error: "Personnalisation introuvable." };
    }
    if (!newLogo || newLogo.size === 0) {
      return { success: false, error: "Choisis un fichier." };
    }

    let logoUrl;
    try {
      logoUrl = await uploadFileToShopify(admin, newLogo);
    } catch (error) {
      return { success: false, error: error.message };
    }

    await prisma.personalization.update({
      where: { id: personalizationId },
      data: { logoUrl },
    });

    return { success: true };
  }

  // --- Approuver manuellement une proof (client validé par un autre canal) ---
  if (intent === "manual-approve") {
    const proofId = formData.get("proofId");

    const proof = await prisma.proof.findUnique({
      where: { id: proofId },
      include: { personalization: true },
    });
    if (!proof || proof.personalization.shop !== session.shop) {
      return { success: false, error: "Proof introuvable." };
    }

    await prisma.proof.update({
      where: { id: proofId },
      data: { status: "approuve", commentaireClient: null, reponduLe: new Date() },
    });

    return { success: true };
  }

  // --- Uploader une nouvelle version pour une proof "modification demandée" ---
  if (intent === "revise-proof") {
    const proofId = formData.get("proofId");
    const newImage = formData.get("newImage");

    const proof = await prisma.proof.findUnique({
      where: { id: proofId },
      include: { personalization: true },
    });
    if (!proof || proof.personalization.shop !== session.shop) {
      return { success: false, error: "Proof introuvable." };
    }
    if (!newImage || newImage.size === 0) {
      return { success: false, error: "Choisis une image." };
    }

    let imageUrl;
    try {
      imageUrl = await uploadFileToShopify(admin, newImage);
    } catch (error) {
      return { success: false, error: error.message };
    }

    await prisma.proof.update({
      where: { id: proofId },
      data: {
        imageUrl,
        mimeType: newImage.type || null,
        status: "en_attente",
        commentaireClient: null,
        envoyeLe: null,
        reponduLe: null,
      },
    });

    return { success: true };
  }

  // --- Envoyer un email groupé au client pour tous les proofs en attente d'une commande ---
  if (intent === "send-for-validation") {
    const draftOrderId = formData.get("draftOrderId");

    const pendingProofs = await prisma.proof.findMany({
      where: {
        status: "en_attente",
        personalization: { draftOrderId, shop: session.shop },
      },
      include: { personalization: true },
    });

    if (pendingProofs.length === 0) {
      return {
        success: false,
        error: "Aucun proof en attente pour cette commande.",
      };
    }

    const orderResponse = await admin.graphql(
      `#graphql
        query getDraftOrder($id: ID!) {
          draftOrder(id: $id) {
            name
            email
          }
        }`,
      { variables: { id: draftOrderId } }
    );
    const orderJson = await orderResponse.json();
    const draftOrder = orderJson.data.draftOrder;
    const customerEmail = draftOrder?.email;

    if (!customerEmail) {
      return {
        success: false,
        error: "Aucun email client trouvé sur ce devis.",
      };
    }

    const tokens = pendingProofs.map((proof) => proof.token);
    // eslint-disable-next-line no-undef
    const reviewUrl = `${process.env.SHOPIFY_APP_URL}/proof-review?tokens=${tokens.join(",")}`;

    try {
      await sendProofValidationEmail({
        to: customerEmail,
        orderName: draftOrder.name,
        items: pendingProofs.map((proof) => proof.personalization.productTitle),
        reviewUrl,
      });
    } catch (error) {
      return { success: false, error: error.message };
    }

    await prisma.proof.updateMany({
      where: { id: { in: pendingProofs.map((proof) => proof.id) } },
      data: { envoyeLe: new Date() },
    });

    return { success: true, sentCount: pendingProofs.length };
  }

  // --- Créer une personnalisation (comportement par défaut) ---
  const draftOrderId = formData.get("draftOrderId");
  const lineItemId = formData.get("lineItemId");
  const productTitle = formData.get("productTitle");
  const type = formData.get("type");
  const quantity = Number(formData.get("quantity"));
  const size = formData.get("size") || null;
  const color = formData.get("color") || null;
  const location = formData.get("location") || null;
  const customText = formData.get("customText") || null;
  const logoFile = formData.get("logo");

  let logoUrl = null;
  try {
    if (logoFile && logoFile.size > 0) {
      logoUrl = await uploadFileToShopify(admin, logoFile);
    }
  } catch (error) {
    return { success: false, error: error.message };
  }

  await prisma.personalization.create({
    data: {
      shop: session.shop,
      draftOrderId,
      lineItemId,
      productTitle,
      type,
      quantity,
      size,
      color,
      location,
      customText,
      logoUrl,
    },
  });

  return { success: true, logoUrl };
};

function PersonalizationForm({ item, onClose }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Personnalisation enregistrée");
      onClose();
    } else if (fetcher.data?.error) {
      shopify.toast.show(`Erreur : ${fetcher.data.error}`, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const handleSave = () => {
    const formData = new FormData(formRef.current);
    fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
  };

  return (
    <s-box
      padding="base"
      background="subdued"
      borderWidth="base"
      borderRadius="base"
    >
      <form ref={formRef}>
        <input type="hidden" name="intent" value="create-personalization" />
        <input type="hidden" name="draftOrderId" value={item.draftOrderId} />
        <input type="hidden" name="lineItemId" value={item.lineItemId} />
        <input type="hidden" name="productTitle" value={item.productTitle} />

        <s-stack direction="block" gap="base">
          <s-heading>Personnaliser : {item.productTitle}</s-heading>

          <s-select name="type" label="Type" required>
            <s-option value="Broderie">Broderie</s-option>
            <s-option value="Impression">Impression</s-option>
            <s-option value="Gravure">Gravure</s-option>
            <s-option value="Sérigraphie">Sérigraphie</s-option>
          </s-select>

          <s-number-field
            name="quantity"
            label="Quantité"
            min="1"
            value={String(item.quantity)}
            required
          ></s-number-field>

          <s-text-field name="size" label="Taille"></s-text-field>

          <s-text-field name="color" label="Couleur"></s-text-field>

          <s-select name="location" label="Emplacement">
            <s-option value="Poitrine gauche">Poitrine gauche</s-option>
            <s-option value="Poitrine droite">Poitrine droite</s-option>
            <s-option value="Manche">Manche</s-option>
            <s-option value="Dos">Dos</s-option>
            <s-option value="Autre">Autre</s-option>
          </s-select>

          <s-text-area name="customText" label="Texte personnalisé" rows="2"></s-text-area>

          <s-stack direction="block" gap="small-200">
            <s-text>Logo (image, PDF, AI ou EPS)</s-text>
            <input type="file" name="logo" accept="image/*,.pdf,.ai,.eps" />
          </s-stack>

          <s-stack direction="inline" gap="base">
            <s-button variant="primary" loading={isSubmitting} onClick={handleSave}>
              Enregistrer
            </s-button>
            <s-button variant="secondary" disabled={isSubmitting} onClick={onClose}>
              Annuler
            </s-button>
          </s-stack>
        </s-stack>
      </form>
    </s-box>
  );
}

function AddProofForm({ personalizationId }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Proof ajouté");
      formRef.current?.reset();
    } else if (fetcher.data?.error) {
      shopify.toast.show(`Erreur : ${fetcher.data.error}`, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const handleSend = () => {
    const formData = new FormData(formRef.current);
    fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
  };

  return (
    <form ref={formRef}>
      <input type="hidden" name="intent" value="add-proofs" />
      <input type="hidden" name="personalizationId" value={personalizationId} />
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <input type="file" name="proofImages" accept="image/*,.pdf,.ai,.eps" multiple />
        <s-button variant="secondary" loading={isSubmitting} onClick={handleSend}>
          Ajouter proof(s)
        </s-button>
      </s-stack>
    </form>
  );
}

function SendForValidationButton({ draftOrderId, pendingCount }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(`Email envoyé (${fetcher.data.sentCount} proof(s))`);
    } else if (fetcher.data?.error) {
      shopify.toast.show(`Erreur : ${fetcher.data.error}`, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  if (pendingCount === 0) return null;

  const handleSend = () => {
    const formData = new FormData();
    formData.set("intent", "send-for-validation");
    formData.set("draftOrderId", draftOrderId);
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <s-button variant="primary" loading={isSubmitting} onClick={handleSend}>
      Envoyer pour validation ({pendingCount})
    </s-button>
  );
}

function ManualApproveButton({ proofId }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Proof approuvée manuellement");
    } else if (fetcher.data?.error) {
      shopify.toast.show(`Erreur : ${fetcher.data.error}`, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const handleClick = () => {
    const formData = new FormData();
    formData.set("intent", "manual-approve");
    formData.set("proofId", proofId);
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <s-button variant="tertiary" loading={isSubmitting} onClick={handleClick}>
      Marquer comme approuvé
    </s-button>
  );
}

function ReviseProofForm({ proofId, startOpen = false }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);
  const [isOpen, setIsOpen] = useState(startOpen);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Nouvelle version envoyée");
      formRef.current?.reset();
      if (!startOpen) setIsOpen(false);
    } else if (fetcher.data?.error) {
      shopify.toast.show(`Erreur : ${fetcher.data.error}`, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const handleSend = () => {
    const formData = new FormData(formRef.current);
    fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
  };

  if (!isOpen) {
    return (
      <button type="button" className="pz-link-btn" onClick={() => setIsOpen(true)}>
        Modifier cette proof
      </button>
    );
  }

  return (
    <form ref={formRef}>
      <input type="hidden" name="intent" value="revise-proof" />
      <input type="hidden" name="proofId" value={proofId} />
      <s-stack direction="block" gap="small-200">
        <input type="file" name="newImage" accept="image/*,.pdf,.ai,.eps" required />
        <s-stack direction="inline" gap="small-200">
          <s-button variant="primary" loading={isSubmitting} onClick={handleSend}>
            Uploader une nouvelle version
          </s-button>
          {!startOpen && (
            <s-button variant="tertiary" disabled={isSubmitting} onClick={() => setIsOpen(false)}>
              Annuler
            </s-button>
          )}
        </s-stack>
      </s-stack>
    </form>
  );
}

function ProofThumbnail({ proof }) {
  const badge = STATUS_BADGE[proof.status] ?? STATUS_BADGE.en_attente;
  const needsAttention = proof.status === "modification_demandee";
  const isPdf = proof.mimeType === "application/pdf";
  const accent = PROOF_ACCENT[proof.status] ?? PROOF_ACCENT.en_attente;
  return (
    <div
      id={`proof-${proof.id}`}
      className="pz-proof-card"
      style={{ "--pz-proof-accent": accent }}
    >
      <s-stack direction="block" gap="small-200">
        {isPdf ? (
          <s-link href={proof.imageUrl} target="_blank">
            📄 Voir le PDF
          </s-link>
        ) : (
          <s-thumbnail src={proof.imageUrl} alt="Proof" size="large"></s-thumbnail>
        )}
        <s-badge tone={badge.tone}>{badge.label}</s-badge>
        {proof.commentaireClient && (
          <s-text>« {proof.commentaireClient} »</s-text>
        )}
        {proof.status === "en_attente" && <ManualApproveButton proofId={proof.id} />}
        <ReviseProofForm proofId={proof.id} startOpen={needsAttention} />
      </s-stack>
    </div>
  );
}

function EditLogoForm({ personalizationId, hasLogo }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Logo mis à jour");
      setIsOpen(false);
    } else if (fetcher.data?.error) {
      shopify.toast.show(`Erreur : ${fetcher.data.error}`, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const handleSave = () => {
    const formData = new FormData(formRef.current);
    fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
  };

  if (!isOpen) {
    return (
      <button type="button" className="pz-link-btn" onClick={() => setIsOpen(true)}>
        {hasLogo ? "Modifier le logo" : "Ajouter un logo"}
      </button>
    );
  }

  return (
    <form ref={formRef}>
      <input type="hidden" name="intent" value="update-logo" />
      <input type="hidden" name="personalizationId" value={personalizationId} />
      <s-stack direction="block" gap="small-200">
        <input type="file" name="newLogo" accept="image/*,.pdf,.ai,.eps" required />
        <s-stack direction="inline" gap="small-200">
          <s-button variant="primary" loading={isSubmitting} onClick={handleSave}>
            Enregistrer
          </s-button>
          <s-button variant="tertiary" disabled={isSubmitting} onClick={() => setIsOpen(false)}>
            Annuler
          </s-button>
        </s-stack>
      </s-stack>
    </form>
  );
}

function PersonalizationCard({ personalization }) {
  return (
    <s-box padding="base small-200" borderWidth="small" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text>
          {personalization.type} — quantité {personalization.quantity}
          {personalization.size ? ` — taille ${personalization.size}` : ""}
          {personalization.color ? ` — couleur ${personalization.color}` : ""}
          {personalization.location ? ` — ${personalization.location}` : ""}
        </s-text>

        {personalization.logoUrl && (
          <s-thumbnail src={personalization.logoUrl} alt="Logo" size="small"></s-thumbnail>
        )}
        <EditLogoForm
          personalizationId={personalization.id}
          hasLogo={Boolean(personalization.logoUrl)}
        />

        <s-stack direction="inline" gap="small-200">
          {sortProofsByStatus(personalization.proofs).map((proof) => (
            <ProofThumbnail key={proof.id} proof={proof} />
          ))}
        </s-stack>

        <AddProofForm personalizationId={personalization.id} />
      </s-stack>
    </s-box>
  );
}

function OrderProofSummary({ proofs }) {
  if (proofs.length === 0) return null;

  const toSend = proofs.filter((p) => p.status === "en_attente" && !p.envoyeLe).length;
  const awaitingResponse = proofs.filter(
    (p) => p.status === "en_attente" && p.envoyeLe
  ).length;
  const approved = proofs.filter((p) => p.status === "approuve").length;
  const changesRequested = proofs.filter(
    (p) => p.status === "modification_demandee"
  ).length;

  const badges = [
    toSend > 0 && { key: "toSend", label: `${toSend} à envoyer`, tone: "info" },
    awaitingResponse > 0 && {
      key: "awaitingResponse",
      label: `${awaitingResponse} en attente de réponse`,
      tone: "neutral",
    },
    approved > 0 && {
      key: "approved",
      label: `${approved} validée${approved > 1 ? "s" : ""}`,
      tone: "success",
    },
    changesRequested > 0 && {
      key: "changesRequested",
      label: `${changesRequested} à corriger`,
      tone: "critical",
    },
  ].filter(Boolean);

  if (badges.length === 0) return null;

  return (
    <s-stack direction="inline" gap="small-200">
      {badges.map((badge) => (
        <s-badge key={badge.key} tone={badge.tone}>
          {badge.label}
        </s-badge>
      ))}
    </s-stack>
  );
}

function AttentionBanner({ proofs }) {
  if (proofs.length === 0) return null;

  return (
    <s-banner
      heading={`${proofs.length} modification${proofs.length > 1 ? "s" : ""} demandée${proofs.length > 1 ? "s" : ""} à traiter`}
      tone="warning"
    >
      <s-stack direction="inline" gap="base">
        {proofs.map((proof) => (
          <div
            key={proof.id}
            className="pz-proof-card"
            style={{ "--pz-proof-accent": PROOF_ACCENT.modification_demandee }}
          >
            <a href={`#proof-${proof.id}`} style={{ textDecoration: "none", color: "inherit" }}>
              <s-stack direction="block" gap="small-200">
                <s-thumbnail src={proof.imageUrl} alt="Proof" size="base"></s-thumbnail>
                <s-text>
                  {proof.orderName} — {proof.productTitle}
                </s-text>
                {proof.commentaireClient && <s-text>« {proof.commentaireClient} »</s-text>}
              </s-stack>
            </a>
            <ReviseProofForm proofId={proof.id} startOpen />
          </div>
        ))}
      </s-stack>
    </s-banner>
  );
}

export default function Personnalisation() {
  const { draftOrders, personalizations } = useLoaderData();
  const [selectedItem, setSelectedItem] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");

  const orderNameById = Object.fromEntries(
    draftOrders.map((order) => [order.id, order.name])
  );
  const proofsNeedingAttention = personalizations.flatMap((p) =>
    p.proofs
      .filter((proof) => proof.status === "modification_demandee")
      .map((proof) => ({
        ...proof,
        productTitle: p.productTitle,
        orderName: orderNameById[p.draftOrderId] ?? "",
      }))
  );

  const ordersWithMeta = draftOrders.map((order) => {
    const orderPersonalizations = personalizations.filter(
      (p) => p.draftOrderId === order.id
    );
    const allOrderProofs = orderPersonalizations.flatMap((p) => p.proofs);
    const pendingCount = allOrderProofs.filter(
      (proof) => proof.status === "en_attente"
    ).length;
    const status = getOrderStatus(orderPersonalizations);

    return { order, orderPersonalizations, allOrderProofs, pendingCount, status };
  });

  const visibleOrders =
    statusFilter === "all"
      ? ordersWithMeta
      : ordersWithMeta.filter((o) => o.status === statusFilter);

  return (
    <s-page heading="Personnalisation">
      <style>{PAGE_STYLES}</style>

      <AttentionBanner proofs={proofsNeedingAttention} />

      {draftOrders.length === 0 && (
        <s-paragraph>Aucun devis brouillon pour le moment.</s-paragraph>
      )}

      {draftOrders.length > 0 && (
        <div className="pz-filter-row">
          <button
            type="button"
            className={`pz-filter-pill${statusFilter === "all" ? " pz-filter-pill--active" : ""}`}
            onClick={() => setStatusFilter("all")}
          >
            Tous ({ordersWithMeta.length})
          </button>
          {STATUS_FILTERS.map((filter) => {
            const count = ordersWithMeta.filter((o) => o.status === filter.key).length;
            return (
              <button
                key={filter.key}
                type="button"
                className={`pz-filter-pill${statusFilter === filter.key ? " pz-filter-pill--active" : ""}`}
                onClick={() => setStatusFilter(filter.key)}
              >
                {filter.label} ({count})
              </button>
            );
          })}
        </div>
      )}

      <s-stack direction="block" gap="base">
        {visibleOrders.map(({ order, orderPersonalizations, allOrderProofs, pendingCount, status }) => {
          const accent = ORDER_STATUS_COLORS[status] ?? "#cbd5e1";
          return (
            <div key={order.id} className="pz-order-card" style={{ "--pz-accent": accent }}>
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                  <s-stack direction="block" gap="small-200">
                    <s-heading>{order.name}</s-heading>
                    <p className="pz-order-date">
                      Créé le {new Date(order.createdAt).toLocaleDateString("fr-FR")}
                    </p>
                    <OrderProofSummary proofs={allOrderProofs} />
                  </s-stack>
                  <SendForValidationButton
                    draftOrderId={order.id}
                    pendingCount={pendingCount}
                  />
                </s-stack>

                <s-stack direction="block" gap="base">
                  {order.lineItems.edges.map(({ node: item }) => {
                    const itemPersonalizations = orderPersonalizations.filter(
                      (p) => p.lineItemId === item.id
                    );

                    return (
                      <s-stack key={item.id} direction="block" gap="small-200">
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                          <s-text>
                            {item.title} — quantité : {item.quantity}
                          </s-text>
                          <s-button
                            variant="secondary"
                            onClick={() =>
                              setSelectedItem({
                                draftOrderId: order.id,
                                lineItemId: item.id,
                                productTitle: item.title,
                                quantity: item.quantity,
                              })
                            }
                          >
                            Personnaliser
                          </s-button>
                        </s-stack>
                        {itemPersonalizations.map((p) => (
                          <PersonalizationCard key={p.id} personalization={p} />
                        ))}
                      </s-stack>
                    );
                  })}
                </s-stack>

                {selectedItem?.draftOrderId === order.id && (
                  <PersonalizationForm
                    item={selectedItem}
                    onClose={() => setSelectedItem(null)}
                  />
                )}
              </s-stack>
            </div>
          );
        })}
      </s-stack>
    </s-page>
  );
}
