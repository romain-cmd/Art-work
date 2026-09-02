/* eslint-disable react/prop-types -- no PropTypes package in this project */
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { sendKanbanCardEmail } from "../lib/send-kanban-card-email.server";
import { colorForType } from "../lib/design-tokens";

const COLUMNS = [
  { key: "a_faire", label: "À faire", tint: "#f1f2f4" },
  { key: "en_cours", label: "En cours", tint: "#eff6ff" },
  { key: "termine", label: "Terminé", tint: "#ecfdf5" },
];

const TYPES = ["Broderie", "Impression", "Gravure", "Sérigraphie"];

// Styles injectés localement : les composants Polaris (s-box, s-section)
// rendent dans un Shadow DOM qu'on ne peut pas re-styler depuis
// l'extérieur, donc les éléments "board"/"carte" ci-dessous sont des
// divs classiques pour permettre couleurs, ombres et survols.
const KANBAN_STYLES = `
  .kb-board {
    display: flex;
    gap: 20px;
    align-items: flex-start;
    overflow-x: auto;
    padding-bottom: 8px;
  }
  .kb-column {
    border-radius: 12px;
    padding: 12px;
    min-width: 280px;
    flex: 1;
  }
  .kb-column-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 4px 12px;
  }
  .kb-column-title {
    font-weight: 700;
    font-size: 14px;
    color: #1a2233;
  }
  .kb-column-count {
    background: #ffffff;
    border-radius: 999px;
    padding: 2px 9px;
    font-size: 12px;
    font-weight: 600;
    color: #64748b;
  }
  .kb-column-empty {
    font-size: 13px;
    color: #94a3b8;
    padding: 4px;
  }
  .kb-card {
    background: #ffffff;
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 10px;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
    border-left: 4px solid var(--kb-accent, #cbd5e1);
    transition: box-shadow 0.15s ease, transform 0.15s ease;
  }
  .kb-card:hover {
    box-shadow: 0 6px 16px rgba(16, 24, 40, 0.12);
    transform: translateY(-1px);
  }
  .kb-chip {
    display: inline-block;
    font-size: 11px;
    font-weight: 700;
    padding: 2px 9px;
    border-radius: 999px;
    color: #ffffff;
    margin-bottom: 8px;
  }
  .kb-card-title {
    font-size: 14px;
    font-weight: 700;
    color: #1a2233;
    margin: 0 0 2px;
  }
  .kb-card-order {
    font-size: 12px;
    color: #94a3b8;
    margin: 0 0 10px;
  }
  .kb-filter-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }
  .kb-filter-pill {
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
  .kb-filter-pill:hover {
    border-color: #0b2545;
  }
  .kb-filter-pill--active {
    background: #0b2545;
    border-color: #0b2545;
    color: #ffffff;
  }
  .kb-card[draggable="true"] {
    cursor: grab;
  }
  .kb-card--dragging {
    opacity: 0.4;
  }
  .kb-column--drag-over {
    outline: 2px dashed #0b2545;
    outline-offset: -4px;
  }
  .kb-dates {
    font-size: 12px;
    color: #64748b;
    margin: 0 0 10px;
  }
  .kb-dates--overdue {
    color: #dc2626;
    font-weight: 600;
  }
  .kb-date-inputs {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .kb-date-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .kb-date-field label {
    font-size: 11px;
    color: #64748b;
  }
  .kb-date-field input {
    font-size: 13px;
    padding: 5px 8px;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    font-family: inherit;
  }
  .kb-link-btn {
    appearance: none;
    background: none;
    border: none;
    padding: 0;
    font-size: 12px;
    color: #0b2545;
    text-decoration: underline;
    cursor: pointer;
    margin-bottom: 10px;
  }
`;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const cards = await prisma.kanbanCard.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "asc" },
  });

  const personalizationIds = cards.map((card) => card.personalizationId);
  const personalizations = await prisma.personalization.findMany({
    where: { id: { in: personalizationIds } },
    include: { proofs: true },
  });

  const partnerEmails = await prisma.partnerEmail.findMany({
    where: { shop: session.shop },
  });
  const partnerEmailsByType = Object.fromEntries(
    partnerEmails.map((p) => [p.type, p.email])
  );

  return { cards, personalizations, partnerEmailsByType };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // --- Envoyer les détails d'une personnalisation à un partenaire externe ---
  if (intent === "email-card") {
    const cardId = formData.get("cardId");
    const partnerEmail = formData.get("partnerEmail");

    const card = await prisma.kanbanCard.findUnique({ where: { id: cardId } });
    if (!card || card.shop !== session.shop) {
      return { success: false, error: "Carte introuvable." };
    }
    if (!partnerEmail) {
      return { success: false, error: "Indique un email." };
    }

    const item = await prisma.personalization.findUnique({
      where: { id: card.personalizationId },
      include: { proofs: true },
    });
    if (!item) {
      return { success: false, error: "Personnalisation introuvable." };
    }

    try {
      await sendKanbanCardEmail({ to: partnerEmail, orderName: card.orderName, item });
    } catch (error) {
      return { success: false, error: error.message };
    }

    // Mémorise cet email comme email habituel pour ce type de
    // personnalisation, pour le pré-remplir automatiquement la prochaine fois.
    await prisma.partnerEmail.upsert({
      where: { shop_type: { shop: session.shop, type: item.type } },
      update: { email: partnerEmail },
      create: { shop: session.shop, type: item.type, email: partnerEmail },
    });

    return { success: true };
  }

  // --- Enregistrer les dates de début / fin prévues d'une carte ---
  if (intent === "set-dates") {
    const cardId = formData.get("cardId");
    const startDateRaw = formData.get("startDate");
    const endDateRaw = formData.get("endDate");

    const card = await prisma.kanbanCard.findUnique({ where: { id: cardId } });
    if (!card || card.shop !== session.shop) {
      return { success: false, error: "Carte introuvable." };
    }

    await prisma.kanbanCard.update({
      where: { id: cardId },
      data: {
        startDate: startDateRaw ? new Date(startDateRaw) : null,
        endDate: endDateRaw ? new Date(endDateRaw) : null,
      },
    });

    return { success: true };
  }

  // --- Déplacer une carte d'une colonne à l'autre (comportement par défaut, ---
  // --- déclenché par les boutons ← / → ou par un glisser-déposer) ---
  const cardId = formData.get("cardId");
  const status = formData.get("status");

  const card = await prisma.kanbanCard.findUnique({ where: { id: cardId } });
  if (!card || card.shop !== session.shop) {
    return { success: false, error: "Carte introuvable." };
  }

  await prisma.kanbanCard.update({ where: { id: cardId }, data: { status } });

  return { success: true };
};

function nextStatus(status) {
  const index = COLUMNS.findIndex((c) => c.key === status);
  return COLUMNS[index + 1]?.key;
}

function previousStatus(status) {
  const index = COLUMNS.findIndex((c) => c.key === status);
  return COLUMNS[index - 1]?.key;
}

function downloadHref(url, filename) {
  return `/app/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
}

function ItemDetails({ item }) {
  const approvedProof = item.proofs.find((proof) => proof.status === "approuve");

  return (
    <s-stack direction="block" gap="small-200">
      <s-text>
        Qté {item.quantity}
        {item.size ? `, ${item.size}` : ""}
        {item.color ? `, ${item.color}` : ""}
        {item.location ? `, ${item.location}` : ""}
      </s-text>
      {item.customText && <s-text>« {item.customText} »</s-text>}
      <s-stack direction="inline" gap="base">
        {item.logoUrl && (
          <s-stack direction="block" gap="small-200">
            <s-text>Logo</s-text>
            <s-thumbnail src={item.logoUrl} alt="Logo" size="base"></s-thumbnail>
            <s-link href={downloadHref(item.logoUrl, `logo-${item.productTitle}`)} target="_blank">
              Télécharger
            </s-link>
          </s-stack>
        )}
        {approvedProof ? (
          <s-stack direction="block" gap="small-200">
            <s-text>Proof approuvée</s-text>
            {approvedProof.mimeType === "application/pdf" ? (
              <s-link href={approvedProof.imageUrl} target="_blank">
                📄 Voir le PDF
              </s-link>
            ) : (
              <s-thumbnail src={approvedProof.imageUrl} alt="Proof approuvée" size="base"></s-thumbnail>
            )}
            <s-link
              href={downloadHref(approvedProof.imageUrl, `proof-${item.productTitle}`)}
              target="_blank"
            >
              Télécharger
            </s-link>
          </s-stack>
        ) : (
          <s-badge tone="critical">Aucune proof approuvée</s-badge>
        )}
      </s-stack>
    </s-stack>
  );
}

function SendCardEmailButton({ cardId, defaultEmail }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Email envoyé au partenaire");
      setIsOpen(false);
    } else if (fetcher.data?.error) {
      shopify.toast.show(`Erreur : ${fetcher.data.error}`, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const handleSend = () => {
    const formData = new FormData(formRef.current);
    formData.set("intent", "email-card");
    formData.set("cardId", cardId);
    fetcher.submit(formData, { method: "post" });
  };

  if (!isOpen) {
    return (
      <s-button variant="secondary" onClick={() => setIsOpen(true)}>
        Envoyer par email à un partenaire
      </s-button>
    );
  }

  return (
    <form ref={formRef}>
      <s-stack direction="block" gap="small-200">
        <s-email-field
          name="partnerEmail"
          label="Email du partenaire"
          defaultValue={defaultEmail || ""}
          placeholder="email@partenaire.com"
        ></s-email-field>
        <s-stack direction="inline" gap="small-200">
          <s-button variant="primary" loading={isSubmitting} onClick={handleSend}>
            Envoyer
          </s-button>
          <s-button variant="tertiary" disabled={isSubmitting} onClick={() => setIsOpen(false)}>
            Annuler
          </s-button>
        </s-stack>
      </s-stack>
    </form>
  );
}

function formatDate(value) {
  if (!value) return null;
  return new Date(value).toLocaleDateString("fr-FR");
}

function toDateInputValue(value) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function isOverdue(card) {
  if (!card.endDate || card.status === "termine") return false;
  return new Date(card.endDate) < new Date(new Date().toDateString());
}

function CardDatesForm({ card }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Dates enregistrées");
      setIsOpen(false);
    } else if (fetcher.data?.error) {
      shopify.toast.show(`Erreur : ${fetcher.data.error}`, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const handleSave = () => {
    const formData = new FormData(formRef.current);
    formData.set("intent", "set-dates");
    formData.set("cardId", card.id);
    fetcher.submit(formData, { method: "post" });
  };

  const overdue = isOverdue(card);

  if (!isOpen) {
    return (
      <>
        {card.startDate || card.endDate ? (
          <p className={`kb-dates${overdue ? " kb-dates--overdue" : ""}`}>
            {overdue ? "⚠ En retard — " : ""}
            {formatDate(card.startDate) || "?"} → {formatDate(card.endDate) || "?"}
          </p>
        ) : (
          <p className="kb-dates">Aucune échéance définie</p>
        )}
        <button type="button" className="kb-link-btn" onClick={() => setIsOpen(true)}>
          {card.startDate || card.endDate ? "Modifier les dates" : "Ajouter des dates"}
        </button>
      </>
    );
  }

  return (
    <form ref={formRef}>
      <div className="kb-date-inputs">
        <div className="kb-date-field">
          <label htmlFor={`start-${card.id}`}>Début</label>
          <input
            id={`start-${card.id}`}
            type="date"
            name="startDate"
            defaultValue={toDateInputValue(card.startDate)}
          />
        </div>
        <div className="kb-date-field">
          <label htmlFor={`end-${card.id}`}>Fin</label>
          <input
            id={`end-${card.id}`}
            type="date"
            name="endDate"
            defaultValue={toDateInputValue(card.endDate)}
          />
        </div>
      </div>
      <s-stack direction="inline" gap="small-200">
        <s-button variant="primary" loading={isSubmitting} onClick={handleSave}>
          Enregistrer
        </s-button>
        <s-button variant="tertiary" disabled={isSubmitting} onClick={() => setIsOpen(false)}>
          Annuler
        </s-button>
      </s-stack>
    </form>
  );
}

function KanbanCardView({ card, item, defaultPartnerEmail, onDragStart, onDragEnd, isDragging }) {
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";
  const prev = previousStatus(card.status);
  const next = nextStatus(card.status);
  const accent = colorForType(item.type);

  const moveCard = (status) => {
    const formData = new FormData();
    formData.set("cardId", card.id);
    formData.set("status", status);
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <div
      className={`kb-card${isDragging ? " kb-card--dragging" : ""}`}
      style={{ "--kb-accent": accent }}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", card.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart(card.id);
      }}
      onDragEnd={onDragEnd}
    >
      <span className="kb-chip" style={{ background: accent }}>
        {item.type}
      </span>
      <p className="kb-card-title">{item.productTitle}</p>
      <p className="kb-card-order">{card.orderName}</p>

      <CardDatesForm card={card} />

      <ItemDetails item={item} />

      <s-stack direction="inline" gap="small-200">
        {prev && (
          <s-button variant="tertiary" disabled={isSubmitting} onClick={() => moveCard(prev)}>
            ← {COLUMNS.find((c) => c.key === prev).label}
          </s-button>
        )}
        {next && (
          <s-button variant="tertiary" disabled={isSubmitting} onClick={() => moveCard(next)}>
            {COLUMNS.find((c) => c.key === next).label} →
          </s-button>
        )}
      </s-stack>

      <div style={{ marginTop: "8px" }}>
        <SendCardEmailButton cardId={card.id} defaultEmail={defaultPartnerEmail} />
      </div>
    </div>
  );
}

export default function Kanban() {
  const { cards, personalizations, partnerEmailsByType } = useLoaderData();
  const [typeFilter, setTypeFilter] = useState("all");
  const [draggingCardId, setDraggingCardId] = useState(null);
  const [dragOverColumn, setDragOverColumn] = useState(null);
  const moveFetcher = useFetcher();

  const cardsWithItems = cards
    .map((card) => ({
      card,
      item: personalizations.find((p) => p.id === card.personalizationId),
    }))
    .filter(({ item }) => item);

  const visibleCards =
    typeFilter === "all"
      ? cardsWithItems
      : cardsWithItems.filter(({ item }) => item.type === typeFilter);

  const dropCardOnColumn = (columnKey) => {
    if (draggingCardId) {
      const formData = new FormData();
      formData.set("cardId", draggingCardId);
      formData.set("status", columnKey);
      moveFetcher.submit(formData, { method: "post" });
    }
    setDraggingCardId(null);
    setDragOverColumn(null);
  };

  return (
    <s-page heading="Suivi de production">
      <style>{KANBAN_STYLES}</style>

      {cards.length === 0 && (
        <s-paragraph>
          Aucune carte pour le moment. Une carte est créée automatiquement, par
          produit personnalisé, quand un devis brouillon est complété en
          commande.
        </s-paragraph>
      )}

      {cards.length > 0 && (
        <div className="kb-filter-row">
          {["all", ...TYPES].map((type) => (
            <button
              key={type}
              type="button"
              className={`kb-filter-pill${typeFilter === type ? " kb-filter-pill--active" : ""}`}
              onClick={() => setTypeFilter(type)}
            >
              {type === "all" ? "Tous" : type}
            </button>
          ))}
        </div>
      )}

      <div className="kb-board">
        {COLUMNS.map((column) => {
          const columnCards = visibleCards.filter(({ card }) => card.status === column.key);
          return (
            <div
              key={column.key}
              className={`kb-column${dragOverColumn === column.key ? " kb-column--drag-over" : ""}`}
              style={{ background: column.tint }}
              onDragOver={(event) => {
                event.preventDefault();
                if (dragOverColumn !== column.key) setDragOverColumn(column.key);
              }}
              onDragLeave={() => setDragOverColumn(null)}
              onDrop={(event) => {
                event.preventDefault();
                dropCardOnColumn(column.key);
              }}
            >
              <div className="kb-column-header">
                <span className="kb-column-title">{column.label}</span>
                <span className="kb-column-count">{columnCards.length}</span>
              </div>
              {columnCards.length === 0 && (
                <p className="kb-column-empty">Aucune carte</p>
              )}
              {columnCards.map(({ card, item }) => (
                <KanbanCardView
                  key={card.id}
                  card={card}
                  item={item}
                  defaultPartnerEmail={partnerEmailsByType[item.type]}
                  isDragging={draggingCardId === card.id}
                  onDragStart={setDraggingCardId}
                  onDragEnd={() => setDraggingCardId(null)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </s-page>
  );
}
