/* eslint-disable react/prop-types -- no PropTypes package in this project */
import { useEffect, useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { colorForType } from "../lib/design-tokens";

const TYPES = ["Broderie", "Impression", "Gravure", "Sérigraphie"];

// Même logique que sur Personnalisation/Kanban : les composants Polaris
// rendent en Shadow DOM, donc les cartes elles-mêmes sont des divs
// classiques pour garder un look cohérent avec le reste de l'app.
const PAGE_STYLES = `
  .rg-card {
    background: #ffffff;
    border: 1px solid #e4e7ec;
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 16px;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
  }
  .rg-card-title {
    font-size: 16px;
    font-weight: 700;
    color: #1a2233;
    margin: 0 0 4px;
  }
  .rg-card-subtitle {
    font-size: 13px;
    color: #64748b;
    margin: 0 0 16px;
  }
  .rg-partner-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .rg-type-dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    flex-shrink: 0;
  }
  .rg-partner-field {
    flex: 1;
  }
`;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const settings = await prisma.shopSettings.findUnique({
    where: { shop: session.shop },
  });
  const partnerEmails = await prisma.partnerEmail.findMany({
    where: { shop: session.shop },
  });

  return {
    notificationEmail: settings?.notificationEmail ?? "",
    partnerEmailsByType: Object.fromEntries(
      partnerEmails.map((p) => [p.type, p.email])
    ),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save-notification-email") {
    const notificationEmail = formData.get("notificationEmail") || null;
    await prisma.shopSettings.upsert({
      where: { shop: session.shop },
      update: { notificationEmail },
      create: { shop: session.shop, notificationEmail },
    });
    return { success: true };
  }

  if (intent === "save-partner-emails") {
    for (const type of TYPES) {
      const email = formData.get(`partnerEmail_${type}`);
      if (email) {
        await prisma.partnerEmail.upsert({
          where: { shop_type: { shop: session.shop, type } },
          update: { email },
          create: { shop: session.shop, type, email },
        });
      }
    }
    return { success: true };
  }

  return { success: false, error: "Action inconnue." };
};

function NotificationEmailForm({ defaultValue }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Email de notification enregistré");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const handleSave = () => {
    const formData = new FormData(formRef.current);
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <div className="rg-card">
      <p className="rg-card-title">🔔 Notification interne</p>
      <p className="rg-card-subtitle">
        Reçoit un email dès qu&apos;un client approuve une maquette ou demande
        une modification.
      </p>
      <form ref={formRef}>
        <input type="hidden" name="intent" value="save-notification-email" />
        <s-stack direction="block" gap="base">
          <s-email-field
            name="notificationEmail"
            label="Email de notification interne"
            defaultValue={defaultValue}
            placeholder="equipe@marinayachtwear.com"
          ></s-email-field>
          <s-button variant="primary" loading={isSubmitting} onClick={handleSave}>
            Enregistrer
          </s-button>
        </s-stack>
      </form>
    </div>
  );
}

function PartnerEmailsForm({ defaultValues }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Emails partenaires enregistrés");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const handleSave = () => {
    const formData = new FormData(formRef.current);
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <div className="rg-card">
      <p className="rg-card-title">🤝 Partenaires par type de personnalisation</p>
      <p className="rg-card-subtitle">
        Pré-rempli automatiquement le champ email sur les cartes de Suivi de
        production de ce type. Mis à jour automatiquement à chaque envoi.
      </p>
      <form ref={formRef}>
        <input type="hidden" name="intent" value="save-partner-emails" />
        <s-stack direction="block" gap="base">
          {TYPES.map((type) => (
            <div key={type} className="rg-partner-row">
              <span className="rg-type-dot" style={{ background: colorForType(type) }} />
              <div className="rg-partner-field">
                <s-email-field
                  name={`partnerEmail_${type}`}
                  label={type}
                  defaultValue={defaultValues[type] || ""}
                  placeholder="partenaire@exemple.com"
                ></s-email-field>
              </div>
            </div>
          ))}
          <s-button variant="primary" loading={isSubmitting} onClick={handleSave}>
            Enregistrer
          </s-button>
        </s-stack>
      </form>
    </div>
  );
}

export default function Reglages() {
  const { notificationEmail, partnerEmailsByType } = useLoaderData();

  return (
    <s-page heading="Réglages">
      <style>{PAGE_STYLES}</style>
      <NotificationEmailForm defaultValue={notificationEmail} />
      <PartnerEmailsForm defaultValues={partnerEmailsByType} />
    </s-page>
  );
}
