/* eslint-disable react/prop-types */
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { Link, useBlocker, useFetcher, useLoaderData, useLocation, useNavigate, useNavigation, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { uploadFileToShopify } from "../lib/shopify-files.server";
import { sendProofValidationEmail } from "../lib/send-proof-email.server";
import { DEFAULT_CLIENT_EMAIL_MESSAGE, DEFAULT_CLIENT_EMAIL_SUBJECT } from "../lib/email-defaults";
import { applyPlaceholders } from "../lib/email-template";
import { ARTWORK_TAG, CASE_STATUSES, acceptsBat, currentProofs, uniqueProofs, artworkMarkings, artworkLabel, isPersonalizationApproved, summarizeCase } from "../lib/artwork-status";
import { ensureProductionCards, event, indexCases, invalidateProofs, metadata, readDossier, reconcileCase, searchDrafts, setArtworkTag, upsertCase } from "../lib/artwork-cases.server";
import { copyPersonalization, personalizationLabel } from "../lib/personalization";
import { noteAddedMarking } from "../lib/artwork-production.server";
import { groupedMarkings } from "../lib/artwork-groups.server";
import { sizeSummary, artworkSummary } from "../lib/artwork-groups";
import { createArtwork, reopenArtworkProduction, invalidateArtworks } from "../lib/shared-artwork.server";
import { WORKSPACE_STYLES } from "../lib/workspace-styles";
import { artworkContext, builderFingerprint, commentPoint, dossierProofs, preparationIssues, waitingSince } from "../lib/artwork-workspace";
import { ArtworkBuilder } from "../components/artwork-builder";
import { ProofReviewContent, REVIEW_STYLES } from "../components/proof-review-content";
import { builderSelection, savePreparedArtwork } from "../lib/artwork-builder.server";
import { correctionFingerprint, correctionGroups } from "../lib/artwork-correction";
import { reviseArtwork } from "../lib/artwork-correction.server";
import { ArtworkCorrectionEditor, ArtworkPartnerForm } from "../components/artwork-followup";
import { sendArtworkPartnerEmail } from "../lib/send-artwork-partner-email.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  let syncError = null;
  try { await indexCases(admin, session.shop, url.searchParams.has("refresh")); } catch (e) { syncError = e.message; }
  const selectedId = url.searchParams.get("case");
  let selected = selectedId ? await readDossier(selectedId, session.shop) : null;
  if (selected && !selected.archivedAt) {
    try {
      const draft = await metadata(admin, selected.draftOrderId);
      if (draft) { await reconcileCase(admin, session.shop, draft); selected = await readDossier(selectedId, session.shop); }
      else syncError = "Ce devis n’existe plus dans Shopify. Les BAT restent conservés.";
    } catch (e) { syncError = e.message; }
  }
  const cases = await prisma.artworkCase.findMany({ where: { shop: session.shop }, orderBy: [{ shopifyUpdatedAt: "desc" }, { id: "desc" }] });
  const draftIds = cases.map((c) => c.draftOrderId);
  const [items, ps, settings, templates, partners] = await Promise.all([
    prisma.artworkItem.findMany({ where: { shop: session.shop, draftOrderId: { in: draftIds }, isActive: true } }),
    prisma.personalization.findMany({ where: { shop: session.shop, draftOrderId: { in: draftIds }, isActive: true }, include: { proofs: { where: { isCurrent: true } } } }),
    prisma.shopSettings.findUnique({ where: { shop: session.shop } }),
    prisma.artworkTemplate.findMany({ where: { shop: session.shop }, orderBy: { name: "asc" } }),
    prisma.partnerEmail.findMany({ where: { shop: session.shop } }),
  ]);
  return { templates, partners: Object.fromEntries(partners.map((p) => [p.type, p.email])), cases: cases.map((c) => ({ ...c, waitingSince: waitingSince(uniqueProofs(ps.filter((p) => p.draftOrderId === c.draftOrderId).flatMap(currentProofs))), summary: summarizeCase(items.filter((i) => i.draftOrderId === c.draftOrderId), ps.filter((p) => p.draftOrderId === c.draftOrderId)), products: items.filter((i) => i.draftOrderId === c.draftOrderId).map((i) => `${i.title} ${i.variantTitle || ""} ${i.sku || ""}`).join(" ") })), selected,
    syncError, shop: session.shop, indexedAt: settings?.artworkIndexedAt,
    emailSubject: settings?.clientEmailSubject || DEFAULT_CLIENT_EMAIL_SUBJECT, emailMessage: settings?.clientEmailMessage || DEFAULT_CLIENT_EMAIL_MESSAGE };
};

const str = (fd, key) => String(fd.get(key) || "").trim();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
async function checkedPersonalization(fd, shop, dossier) {
  const p = await prisma.personalization.findFirst({ where: { id: str(fd, "personalizationId"), shop, draftOrderId: dossier.draftOrderId, isActive: true }, include: { proofs: true } });
  if (!p) throw new Error("Personnalisation introuvable. Actualise le dossier.");
  const item = await prisma.artworkItem.findUnique({ where: { shop_draftOrderId_lineItemId: { shop, draftOrderId: dossier.draftOrderId, lineItemId: p.lineItemId } } });
  if (!item?.isActive || item.requirement !== "required") throw new Error("Cet article ne nécessite pas de BAT. Modifie son suivi pour poursuivre.");
  return p;
}
function specifications(fd) {
  const type = str(fd, "type"); const quantity = Number(fd.get("quantity"));
  if (!["Broderie", "Impression", "Gravure", "Sérigraphie"].includes(type)) throw new Error("Choisis une technique de marquage.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) throw new Error("La quantité doit être un entier supérieur à zéro.");
  return { type, quantity, dimensions: str(fd, "dimensions") || null, color: str(fd, "color") || null, location: str(fd, "location") || null, customText: str(fd, "customText") || null };
}
async function proofFiles(admin, fd) {
  const files = fd.getAll("proofImages").filter((f) => f && f.size > 0);
  if (files.some((f) => !acceptsBat(f))) throw new Error("Pour un BAT, utilise un PNG, JPG, WebP ou PDF de 20 Mo maximum.");
  return Promise.all(files.map(async (file) => ({ imageUrl: await uploadFileToShopify(admin, file), mimeType: file.type, fileName: file.name })));
}
async function logoFile(admin, fd) {
  const file = fd.get("logo");
  if (!file?.size) return {};
  if (file.size > 20 * 1024 * 1024 || !/\.(png|jpe?g|webp|svg|pdf|ai|eps)$/i.test(file.name)) throw new Error("Logo : image, PDF, AI ou EPS, 20 Mo maximum.");
  return { logoUrl: await uploadFileToShopify(admin, file), logoMimeType: file.type, logoFileName: file.name };
}
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const fd = await request.formData(); const intent = str(fd, "intent");
  try {
    if (intent === "refresh-index") { await indexCases(admin, session.shop, true); return { success: true, message: "Index Shopify actualisé" }; }
    if (intent === "search-drafts") {
      const q = str(fd, "query").slice(0, 200);
      const page = await searchDrafts(admin, q, str(fd, "after") || null, 20);
      return { results: page.nodes, pageInfo: page.pageInfo, searchQuery: q };
    }
    if (intent === "add-case") {
      const id = str(fd, "draftOrderId"); const draft = await metadata(admin, id);
      if (!draft) throw new Error("Devis introuvable dans Shopify.");
      await setArtworkTag(admin, id, true);
      await upsertCase(session.shop, draft, { activate: true });
      const dossier = await reconcileCase(admin, session.shop, draft);
      await event(dossier.id, "Devis ajouté au suivi artwork.");
      return { success: true, message: "Devis ajouté au suivi", openCase: dossier.id };
    }
    const dossier = await prisma.artworkCase.findFirst({ where: { id: str(fd, "caseId"), shop: session.shop } });
    if (!dossier) throw new Error("Dossier introuvable.");
    if (intent === "archive-case" || intent === "restore-case") {
      const enabled = intent === "restore-case";
      await setArtworkTag(admin, dossier.draftOrderId, enabled);
      await prisma.artworkCase.update({ where: { id: dossier.id }, data: { archivedAt: enabled ? null : new Date() } });
      await event(dossier.id, enabled ? "Dossier réactivé." : "Dossier retiré du suivi actif. Fichiers et historique conservés.");
      return { success: true, message: enabled ? "Dossier réactivé" : "Dossier archivé" };
    }
    if (dossier.archivedAt) throw new Error("Réactive ce dossier pour le modifier.");
    if (intent === "assign-case") {
      await prisma.artworkCase.update({ where: { id: dossier.id }, data: { responsibleName: str(fd, "responsibleName").slice(0, 100) || null } });
      return { success: true, message: "Responsable enregistré" };
    }
    if (intent === "save-template") {
      const p = await checkedPersonalization(fd, session.shop, dossier);
      const name = str(fd, "templateName").slice(0, 100);
      if (!name) throw new Error("Donne un nom au modèle.");
      const specs = Object.fromEntries(["type", "dimensions", "color", "location", "customText", "logoUrl", "logoMimeType", "logoFileName"].map((k) => [k, p[k] ?? null]));
      await prisma.artworkTemplate.create({ data: { shop: session.shop, name, specs } });
      return { success: true, message: "Modèle disponible dans tous les dossiers de la boutique" };
    }
    if (intent === "delete-template") {
      const template = await prisma.artworkTemplate.findFirst({ where: { id: str(fd, "templateId"), shop: session.shop } });
      if (!template) throw new Error("Modèle introuvable.");
      await prisma.artworkTemplate.delete({ where: { id: template.id } });
      return { success: true, message: "Modèle supprimé. Les marquages existants sont conservés." };
    }
    if (intent === "rename-yacht") {
      await prisma.artworkCase.update({ where: { id: dossier.id }, data: { yachtName: str(fd, "yachtName") || null } });
      return { success: true, message: "Nom du yacht enregistré" };
    }
    // Reconcile against current Shopify data before accepting any specification or send action.
    const draft = await metadata(admin, dossier.draftOrderId);
    if (!draft) throw new Error("Ce devis n’existe plus dans Shopify.");
    await reconcileCase(admin, session.shop, draft);
    if (["correct-artwork", "email-artwork"].includes(intent)) {
      const live = await readDossier(dossier.id, session.shop);
      const proof = dossierProofs(live).find((pr) => pr.id === str(fd, "proofId") && pr.isCurrent && !pr.deletedAt);
      if (!proof) throw new Error("Ce BAT n’est plus actuel. Actualise le dossier.");
      const linked = live.personalizations.filter((p) => p.proofs.some((pr) => pr.id === proof.id));
      if (!linked.length || linked.some((p) => !live.items.some((i) => i.lineItemId === p.lineItemId && i.requirement === "required"))) throw new Error("Les vêtements associés à ce BAT ont changé.");
      const expected = str(fd, "artworkFingerprint");
      if (expected !== correctionFingerprint(live, proof)) throw new Error("Le BAT ou ses caractéristiques ont changé. Rouvre le formulaire pour vérifier la version actuelle.");
      if (intent === "email-artwork") {
        if (proof.status !== "approuve") throw new Error("Valide ce BAT avant la transmission au prestataire.");
        const ids = [...new Set(fd.getAll("targetMarkingId").map(String))];
        const markings = ids.map((id) => linked.find((p) => p.id === id));
        if (!ids.length || markings.some((p) => !p || !isPersonalizationApproved(p))) throw new Error("Choisis uniquement des marquages validés de ce BAT.");
        const email = str(fd, "partnerEmail");
        if (!validEmail(email)) throw new Error("Indique une adresse email valide pour le prestataire.");
        const settings = await prisma.shopSettings.findUnique({ where: { shop: session.shop } });
        await sendArtworkPartnerEmail({ to: email, orderName: `${live.orderName || live.name}${live.yachtName ? ` / ${live.yachtName}` : ""}`, proof, markings, items: live.items, subjectTemplate: settings?.partnerEmailSubject, messageTemplate: settings?.partnerEmailMessage });
        const sentAt = new Date();
        await prisma.$transaction(async (tx) => {
          await tx.proof.update({ where: { id: proof.id }, data: { partnerSentAt: sentAt, partnerSentTo: email } });
          await tx.kanbanCard.updateMany({ where: { shop: session.shop, draftOrderId: dossier.draftOrderId, personalizationId: { in: ids } }, data: { lastSentAt: sentAt, lastSentTo: email } });
          if (fd.get("rememberPartner") === "on") for (const type of new Set(markings.map((p) => p.type))) await tx.partnerEmail.upsert({ where: { shop_type: { shop: session.shop, type } }, create: { shop: session.shop, type, email }, update: { email } });
          await event(dossier.id, `BAT V${proof.version} transmis à ${email} : ${markings.map((p) => { const item = live.items.find((i) => i.lineItemId === p.lineItemId); return `${personalizationLabel(p)} (${item?.variantTitle || "variante"}, ${p.quantity} pièces)`; }).join(" ; ")}.`, "Équipe", tx);
        });
        return { success: true, message: "BAT validé et informations transmis au prestataire" };
      }
      const groups = correctionGroups(live, proof);
      const rows = JSON.parse(str(fd, "corrections") || "[]");
      if (!Array.isArray(rows) || rows.length !== groups.length || new Set(rows.map((r) => r.key)).size !== groups.length) throw new Error("Reprends tous les marquages de ce BAT.");
      const prepared = rows.map((row) => {
        const group = groups.find((g) => g.key === row.key);
        if (!group) throw new Error("Un marquage ne correspond plus à ce BAT.");
        const values = new FormData();
        for (const key of ["type", "dimensions", "color", "location", "customText"]) values.set(key, String(row[key] || "").slice(0, 1000));
        const members = group.members.map((member) => {
          const quantity = Number(row.quantities?.[member.id]);
          if (!Number.isInteger(quantity) || quantity < 1 || quantity > member.max) throw new Error(`Vérifie la quantité de ${member.variant} : entre 1 et ${member.max}.`);
          return { id: member.id, quantity };
        });
        values.set("quantity", String(members[0].quantity));
        const { quantity, ...specs } = specifications(values); void quantity;
        return { key: group.key, specs, members, logo: {} };
      });
      const files = fd.getAll("proofImages").filter((f) => f?.size);
      if (files.length !== 1 || !acceptsBat(files[0])) throw new Error("Ajoute le nouvel artwork PNG, JPG, WebP ou PDF de 20 Mo maximum.");
      for (const row of prepared) {
        const logo = new FormData(); const file = fd.get(`logo-${row.key}`);
        if (file?.size) { logo.set("logo", file); row.logo = await logoFile(admin, logo); }
      }
      const uploads = await proofFiles(admin, fd);
      await reviseArtwork(prisma, { dossier, proof, rows: prepared, file: uploads[0], expected });
      await ensureProductionCards(session.shop, dossier.draftOrderId);
      return { success: true, message: "Personnalisations et nouvel artwork enregistrés. Renvoie le BAT au client pour validation." };
    }
    if (intent === "prepare-artwork") {
      const live = await readDossier(dossier.id, session.shop);
      const selected = builderSelection(live.items, JSON.parse(str(fd, "selectedItems") || "[]"));
      if (str(fd, "preparationFingerprint") !== builderFingerprint(live, selected.map((i) => i.id))) throw new Error("Les vêtements ou marquages ont changé pendant la préparation. Ferme l’assistant, actualise le dossier puis vérifie les nouvelles informations.");
      const selectedColors = new Set(selected.map((i) => i.colorLabel || i.variantTitle || ""));
      if (selectedColors.size > 1 && str(fd, "confirmColors") !== "yes") throw new Error("Confirme que le même artwork convient aux différentes couleurs sélectionnées.");
      const existingIds = JSON.parse(str(fd, "existingIds") || "[]");
      if (!Array.isArray(existingIds) || new Set(existingIds).size !== existingIds.length) throw new Error("Sélection de marquages invalide.");
      const existing = existingIds.map((id) => live.personalizations.find((p) => p.id === id && p.lineItemId === selected[0].lineItemId));
      if (existing.some((p) => !p)) throw new Error("Les marquages ont changé. Actualise le dossier.");
      const rows = JSON.parse(str(fd, "markings") || "[]");
      if (!Array.isArray(rows) || rows.length > 20 || (!rows.length && !existing.length)) throw new Error("Ajoute au moins un marquage (20 nouveaux maximum).");
      // Validate all quantities and references before uploading any files.
      const additions = [];
      for (const row of rows) {
        const values = new FormData();
        for (const key of ["type", "dimensions", "color", "location", "customText"]) values.set(key, String(row[key] || "").slice(0, 1000));
        values.set("quantity", String(row.quantities?.[selected[0].id]));
        const specs = specifications(values);
        const quantities = Object.fromEntries(selected.map((i) => {
          const quantity = Number(row.quantities?.[i.id]);
          if (!Number.isInteger(quantity) || quantity < 1 || quantity > i.quantity) throw new Error(`Vérifie la quantité de ${i.title} · ${i.variantTitle} : entre 1 et ${i.quantity}.`);
          return [i.id, quantity];
        }));
        const template = row.templateId ? await prisma.artworkTemplate.findFirst({ where: { id: row.templateId, shop: session.shop } }) : null;
        if (row.templateId && !template) throw new Error("Ce modèle n’existe plus. Choisis un autre modèle.");
        additions.push({ specs, quantities, logo: template ? Object.fromEntries(["logoUrl", "logoMimeType", "logoFileName"].map((k) => [k, template.specs[k] || null])) : {}, uploadKey: row.key });
      }
      const filesToCheck = fd.getAll("proofImages").filter((f) => f?.size > 0);
      if (!filesToCheck.length || filesToCheck.length > 10 || filesToCheck.some((f) => !acceptsBat(f))) throw new Error("Ajoute de 1 à 10 artworks PNG, JPG, WebP ou PDF de 20 Mo maximum chacun.");
      for (const row of additions) {
        const logoData = new FormData(); const file = fd.get(`logo-${row.uploadKey}`);
        if (file?.size) { logoData.set("logo", file); Object.assign(row.logo, await logoFile(admin, logoData)); }
      }
      const files = await proofFiles(admin, fd);
      await savePreparedArtwork(prisma, { dossier, items: selected, existing, additions, files, expected: str(fd, "preparationFingerprint") });
      await ensureProductionCards(session.shop, dossier.draftOrderId);
      return { success: true, message: "BAT enregistré. Vérifie l’aperçu avant de l’envoyer au client." };
    }
    if (intent === "set-requirement") {
      const item = await prisma.artworkItem.findFirst({ where: { id: str(fd, "itemId"), shop: session.shop, draftOrderId: dossier.draftOrderId, isActive: true } });
      const requirement = str(fd, "requirement");
      if (!item || !["pending", "required", "none"].includes(requirement)) throw new Error("Article ou choix invalide.");
      await prisma.$transaction(async (tx) => {
        await tx.artworkItem.update({ where: { id: item.id }, data: { requirement } });
        if (item.requirement === "required" && requirement !== "required") {
          const excluded = await tx.personalization.findMany({ where: { shop: session.shop, draftOrderId: dossier.draftOrderId, lineItemId: item.lineItemId, isActive: true } });
          await invalidateArtworks(tx, excluded, dossier.id, "Périmètre du BAT modifié.");
        }
        await event(dossier.id, `${item.title} : ${requirement === "required" ? "BAT requis" : requirement === "none" ? "sans BAT requis" : "à qualifier"}.`, "Équipe", tx);
      });
      await ensureProductionCards(session.shop, dossier.draftOrderId);
      return { success: true, message: "Article mis à jour" };
    }
    if (intent === "save-personalization") {
      if (fd.getAll("proofImages").some((file) => file && file.size > 0)) throw new Error("Importe l’artwork dans la section Artworks de cet article, puis sélectionne ses marquages.");
      const specs = specifications(fd);
      const existing = str(fd, "personalizationId") ? await checkedPersonalization(fd, session.shop, dossier) : null;
      const item = await prisma.artworkItem.findFirst({ where: { shop: session.shop, draftOrderId: dossier.draftOrderId, lineItemId: existing?.lineItemId || str(fd, "lineItemId"), isActive: true } });
      if (!item || item.requirement !== "required") throw new Error("Sélectionne d’abord « BAT requis » pour cet article.");
      if (specs.quantity > item.quantity) throw new Error(`La quantité personnalisée ne peut pas dépasser ${item.quantity}, quantité du devis.`);
      const reuseId = str(fd, "reuseId");
      const source = reuseId ? await prisma.personalization.findFirst({ where: { id: reuseId, shop: session.shop, draftOrderId: dossier.draftOrderId, isActive: true } }) : null;
      if (reuseId && !source) throw new Error("La personnalisation source n’est plus disponible. Actualise le dossier.");
      if (str(fd, "duplicateSourceId") && (existing || source?.id !== str(fd, "duplicateSourceId") || source.lineItemId !== item.lineItemId)) throw new Error("La duplication doit rester sur le même article.");
      const logo = await logoFile(admin, fd);
      if (!logo.logoUrl && source) Object.assign(logo, { logoUrl: source.logoUrl, logoMimeType: source.logoMimeType, logoFileName: source.logoFileName });
      await prisma.$transaction(async (tx) => {
        const p = existing ? await tx.personalization.update({ where: { id: existing.id }, data: { ...specs, ...logo } }) : await tx.personalization.create({ data: { shop: session.shop, draftOrderId: dossier.draftOrderId, lineItemId: item.lineItemId, variantId: item.variantId, sourceQuantity: item.quantity, productTitle: item.title, size: source?.size || null, ...specs, ...logo } });
        const changedSpecs = existing && ["type", "quantity", "dimensions", "color", "location", "customText", "logoUrl"].some((k) => p[k] !== existing[k]);
        if (changedSpecs) {
          await invalidateProofs(tx, p, dossier.id, `Caractéristiques modifiées : ${personalizationLabel(p)}.`);
        }
        if (!existing) await noteAddedMarking(tx, p, dossier.id);
        await event(dossier.id, `${existing ? "Personnalisation modifiée" : "Personnalisation préparée"} : ${personalizationLabel(p)}.`, "Équipe", tx);
      });
      await ensureProductionCards(session.shop, dossier.draftOrderId);
      return { success: true, message: "Personnalisation enregistrée. Ajoute ou associe l’artwork de l’article." };
    }
    if (intent === "copy-personalization") {
      const source = await checkedPersonalization(fd, session.shop, dossier);
      const ids = fd.getAll("targetItemId").map(String);
      const targets = await prisma.artworkItem.findMany({ where: { id: { in: ids }, shop: session.shop, draftOrderId: dossier.draftOrderId, isActive: true, requirement: "required", NOT: { lineItemId: source.lineItemId } } });
      if (!targets.length) throw new Error("Choisis au moins un autre article avec BAT requis.");
      await prisma.$transaction(async (tx) => {
        for (const target of targets) {
          const p = await tx.personalization.create({ data: { shop: session.shop, draftOrderId: dossier.draftOrderId, lineItemId: target.lineItemId, variantId: target.variantId, sourceQuantity: target.quantity, productTitle: target.title, ...copyPersonalization(source, target) } });
          await noteAddedMarking(tx, p, dossier.id);
        }
        await event(dossier.id, `Paramètres et logo copiés sur ${targets.length} article(s). Chaque BAT reste à préparer.`, "Équipe", tx);
      });
      await ensureProductionCards(session.shop, dossier.draftOrderId);
      return { success: true, message: "Paramètres copiés. Ajoute les BAT de chaque article." };
    }
    if (["add-article-proofs", "revise-proof", "link-proof", "delete-proof"].includes(intent)) {
      const item = await prisma.artworkItem.findFirst({ where: { id: str(fd, "itemId"), shop: session.shop, draftOrderId: dossier.draftOrderId, isActive: true, requirement: "required" } });
      if (!item) throw new Error("Article actif avec BAT requis introuvable.");
      const available = await prisma.personalization.findMany({ where: { shop: session.shop, draftOrderId: dossier.draftOrderId, lineItemId: item.lineItemId, isActive: true } });
      const old = intent !== "add-article-proofs" ? await prisma.proof.findFirst({ where: { id: str(fd, "proofId"), isCurrent: true, deletedAt: null, personalizations: { some: { shop: session.shop, draftOrderId: dossier.draftOrderId, lineItemId: item.lineItemId } } }, include: { personalizations: true } }) : null;
      if (intent !== "add-article-proofs" && !old) throw new Error("Cet artwork n’est plus actuel. Actualise le dossier.");
      if (intent === "delete-proof") {
        await prisma.$transaction(async (tx) => {
          const removed = await tx.proof.updateMany({ where: { id: old.id, isCurrent: true, deletedAt: null }, data: { isCurrent: false, deletedAt: new Date() } });
          if (!removed.count) throw new Error("Cet artwork a déjà changé.");
          await reopenArtworkProduction(tx, old.personalizations, dossier.id);
          await event(dossier.id, `Artwork supprimé du suivi actif : ${old.fileName || "BAT"}, V${old.version}. Ancien lien désactivé.`, "Équipe", tx);
        });
        return { success: true, message: "Artwork supprimé. Les marquages sans autre BAT restent à préparer." };
      }
      const ids = [...new Set(fd.getAll("markingId").map(String))];
      const markings = available.filter((p) => ids.includes(p.id));
      if (!markings.length || markings.length !== ids.length) throw new Error("Sélectionne des marquages de cet article uniquement.");
      const groupIds = [...new Set([item.id, ...fd.getAll("groupItemId").map(String)])];
      const groupItems = await prisma.artworkItem.findMany({ where: { id: { in: groupIds }, shop: session.shop, draftOrderId: dossier.draftOrderId, isActive: true } });
      if (groupItems.length !== groupIds.length || groupItems.some((i) => i.requirement === "none") || (groupItems.length > 1 && (!item.productId || groupItems.some((i) => i.productId !== item.productId)))) throw new Error("Choisis uniquement des tailles du même produit avec BAT requis ou à préparer.");
      const uploads = intent === "link-proof" ? [old] : await proofFiles(admin, fd);
      if (!uploads.length || (old && uploads.length !== 1)) throw new Error("Choisis un fichier pour cet artwork.");
      await prisma.$transaction(async (tx) => {
        const grouped = await groupedMarkings(tx, markings, groupItems, dossier.id);
        const affected = new Map([...(old?.personalizations || []), ...grouped].map((p) => [p.id, p]));
        await reopenArtworkProduction(tx, [...affected.values()], dossier.id);
        for (const file of uploads) await createArtwork(tx, grouped, file, old);
        await event(dossier.id, `Artwork ${old ? "révisé" : "importé"} : ${item.title}, ${groupItems.length} variante(s), ${grouped.length} marquage(s), ${uploads.length} fichier(s). Nouvelle validation requise.`, "Équipe", tx);
      });
      await ensureProductionCards(session.shop, dossier.draftOrderId);
      return { success: true, message: "Artwork commun et récapitulatif enregistrés. Il reste à les faire valider." };
    }
    if (intent === "manual-approve") {
      const p = await checkedPersonalization(fd, session.shop, dossier); const proof = p.proofs.find((x) => x.id === str(fd, "proofId") && x.isCurrent && x.status === "en_attente");
      const via = str(fd, "approvedVia");
      if (!proof || !["Email", "WhatsApp", "Téléphone"].includes(via)) throw new Error("Choisis le canal de validation du BAT actuel.");
      await prisma.$transaction(async (tx) => {
        const approved = await tx.proof.updateMany({ where: { id: proof.id, isCurrent: true, status: "en_attente" }, data: { status: "approuve", reponduLe: new Date(), approvedVia: via } });
        if (!approved.count) throw new Error("Ce BAT a changé. Actualise le dossier avant de le valider.");
        await event(dossier.id, `BAT V${proof.version} validé par ${via} : ${personalizationLabel(p)}.`, "Équipe", tx);
      });
      return { success: true, message: "Validation enregistrée" };
    }
    if (intent === "send-for-validation") {
      const customerEmail = str(fd, "customerEmail"); const mode = str(fd, "sendMode");
      if (!validEmail(customerEmail)) throw new Error("Indique une adresse email valide.");
      const live = await readDossier(dossier.id, session.shop);
      const summary = summarizeCase(live.items, live.personalizations);
      if (summary.pendingQualification || summary.missing) throw new Error("Qualifie tous les articles et prépare les BAT requis avant l’envoi.");
      const requiredIds = live.items.filter((i) => i.requirement === "required").map((i) => i.lineItemId);
      const pending = uniqueProofs(live.personalizations.filter((p) => requiredIds.includes(p.lineItemId)).flatMap((p) => currentProofs(p).filter((proof) => proof.status === "en_attente" && (mode === "reminder" ? proof.envoyeLe : !proof.envoyeLe)).map((proof) => ({ ...proof, personalization: p }))));
      if (!pending.length) throw new Error(mode === "reminder" ? "Aucun BAT à relancer." : "Aucun nouveau BAT à envoyer.");
      // Ensure the user reviewed exactly the versions that will be sent, even if Shopify changed in another tab.
      const expected = str(fd, "proofIds").split(",").filter(Boolean).sort().join(",");
      if (expected !== pending.map((p) => p.id).sort().join(",")) throw new Error("Le dossier a changé. Vérifie les nouvelles versions avant de confirmer l’envoi.");
      const settings = await prisma.shopSettings.findUnique({ where: { shop: session.shop } });
      // eslint-disable-next-line no-undef
      const reviewUrl = `${process.env.SHOPIFY_APP_URL}/proof-review?tokens=${pending.map((p) => p.token).join(",")}`;
      await sendProofValidationEmail({ to: customerEmail, orderName: `${dossier.name}${dossier.yachtName ? ` / ${dossier.yachtName}` : ""}`, artworks: pending, items: pending.map((p) => `${artworkLabel(p, { english: true })}, BAT V${p.version}`), reviewUrl, subjectTemplate: settings?.clientEmailSubject, messageTemplate: settings?.clientEmailMessage });
      await prisma.$transaction(async (tx) => {
        await tx.proof.updateMany({ where: { id: { in: pending.map((p) => p.id) }, isCurrent: true, status: "en_attente" }, data: { envoyeLe: new Date() } });
        await event(dossier.id, `${mode === "reminder" ? "Relance" : "Envoi"} à ${customerEmail} : ${pending.length} BAT.`, "Équipe", tx);
      });
      return { success: true, message: mode === "reminder" ? "Relance envoyée" : "BAT envoyés au client" };
    }
    throw new Error("Action inconnue.");
  } catch (e) { return { success: false, error: e.message }; }
};

const DirtyContext = createContext((...args) => { void args; });
export function WorkflowForm({ intent, caseId = null, children = null, label = "Enregistrer", onDone = null, confirm = null, className = "", onInput = null, hideSubmit = false, onSubmit = null, tone = "primary" }) {
  const fetcher = useFetcher(); const app = useAppBridge(); const id = useId(); const markDirty = useContext(DirtyContext); const ref = useRef(null);
  useEffect(() => () => markDirty(id, false), [id, markDirty]);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) { markDirty(id, false); if (ref.current) delete ref.current.dataset.workflowDirty; app.toast.show(fetcher.data.message || "Enregistré"); onDone?.(fetcher.data); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state]);
  return <fetcher.Form ref={ref} method="post" encType="multipart/form-data" className={`aw-form ${className}`} onChange={(e) => { markDirty(id, true); ref.current.dataset.workflowDirty = "true"; onInput?.(e); }} onSubmit={(e) => { onSubmit?.(e); if (!e.defaultPrevented && confirm && !window.confirm(confirm)) e.preventDefault(); }}>
    <input type="hidden" name="intent" value={intent}/><input type="hidden" name="caseId" value={caseId || ""}/>
    <fieldset disabled={fetcher.state !== "idle"}>{children}
      {fetcher.data?.error && <p className="aw-error" role="alert">{fetcher.data.error}</p>}
      {!hideSubmit && <button className={`aw-button ${tone}`} type="submit">{fetcher.state !== "idle" ? "En cours…" : label}</button>}
    </fieldset>
  </fetcher.Form>;
}
const date = (value) => value ? new Date(value).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" }) : "Synchronisation à venir";
const Badge = ({ status }) => <span className="aw-badge" style={{ color: CASE_STATUSES[status]?.color }}>{CASE_STATUSES[status]?.label}</span>;
function AddCase({ onClose, onOpen }) {
  const fetcher = useFetcher(); const [q, setQ] = useState("");
  return <section className="aw-panel"><div className="aw-between"><h2>Ajouter un devis Shopify</h2><button className="aw-button" onClick={onClose}>Fermer</button></div>
    <p>Le tag <strong>{ARTWORK_TAG}</strong> sera ajouté au devis. Tu peux aussi l’ajouter directement dans Shopify.</p>
    <fetcher.Form method="post" className="aw-toolbar"><input type="hidden" name="intent" value="search-drafts"/><label className="aw-grow">Rechercher dans Shopify<input name="query" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Numéro, nom ou email"/></label><button className="aw-button primary" disabled={fetcher.state !== "idle"}>Rechercher</button></fetcher.Form>
    {fetcher.data?.error && <p role="alert" className="aw-error">{fetcher.data.error}</p>}
    {fetcher.data?.results?.map((r) => <div key={r.id} className="aw-search-result"><div><strong>{r.name}</strong><p>{[r.shippingAddress?.firstName || r.billingAddress?.firstName, r.shippingAddress?.lastName || r.billingAddress?.lastName].filter(Boolean).join(" ") || r.email || "Client non renseigné"} · {r.shippingAddress?.company || ""}</p><small>Modifié le {date(r.updatedAt)}</small></div>
      <WorkflowForm intent="add-case" label="Ajouter au suivi" onDone={(data) => onOpen(data.openCase)}><input type="hidden" name="draftOrderId" value={r.id}/></WorkflowForm></div>)}
    {fetcher.data?.results?.length === 0 && <p>Aucun devis trouvé. Essaie le numéro ou l’email du client.</p>}
    {fetcher.data?.pageInfo?.hasNextPage && <fetcher.Form method="post"><input type="hidden" name="intent" value="search-drafts"/><input type="hidden" name="query" value={fetcher.data.searchQuery || ""}/><input type="hidden" name="after" value={fetcher.data.pageInfo.endCursor}/><button className="aw-button">Résultats suivants</button></fetcher.Form>}
  </section>;
}
function PersonalizationEditor({ dossier, item, p = null, duplicate = null, onClose }) {
  const [reuse, setReuse] = useState(duplicate); const source = reuse || p;
  return <section className="aw-editor"><div className="aw-between"><h3>{p ? "Modifier la personnalisation" : duplicate ? "Dupliquer cette personnalisation" : "Préparer une personnalisation"}</h3><button className="aw-button" onClick={() => { if (window.confirm("Fermer ce formulaire ? Les changements non enregistrés seront perdus.")) onClose(); }}>Fermer</button></div>
    {!p && <p className="aw-notice">{duplicate ? "Les caractéristiques et le logo sont repris. Modifie les champs souhaités avant d’enregistrer. " : "Chaque marquage possède ses propres caractéristiques. "}Les BAT, validations et états de production ne sont pas copiés.</p>}
    {!p && !duplicate && dossier.personalizations.length > 0 && <label>Réutiliser un logo et des paramètres<select value={reuse?.id || ""} onChange={(e) => { if (document.querySelector('[data-workflow-dirty="true"]') && !window.confirm("Changer de modèle et perdre les modifications non enregistrées ?")) return; setReuse(dossier.personalizations.find((row) => row.id === e.target.value) || null); }}><option value="">Nouvelle personnalisation</option>{dossier.personalizations.map((row) => <option key={row.id} value={row.id}>{personalizationLabel(row)}</option>)}</select></label>}
    <WorkflowForm key={reuse?.id || p?.id || "new"} intent="save-personalization" caseId={dossier.id} label="Enregistrer la personnalisation" onDone={onClose}>
      <input type="hidden" name="personalizationId" value={p?.id || ""}/><input type="hidden" name="lineItemId" value={item.lineItemId}/><input type="hidden" name="reuseId" value={reuse?.id || ""}/><input type="hidden" name="duplicateSourceId" value={duplicate?.id || ""}/>
      <div className="aw-grid"><label>Technique<select name="type" defaultValue={source?.type || "Broderie"}>{["Broderie", "Impression", "Gravure", "Sérigraphie"].map((t) => <option key={t}>{t}</option>)}</select></label>
        <label>Quantité personnalisée <small>Pièces concernées par ce marquage ; les mêmes pièces peuvent recevoir plusieurs marquages.</small><input type="number" name="quantity" min="1" max={item.quantity} required defaultValue={p?.quantity || (source ? copyPersonalization(source, item, { sameItem: source.lineItemId === item.lineItemId }).quantity : item.quantity)}/></label>
        <label>Dimensions du marquage<input name="dimensions" placeholder="Ex. largeur 80 mm × hauteur 35 mm" defaultValue={source?.dimensions || ""}/></label>
        <label>Couleur du marquage<input name="color" placeholder="Ex. bleu marine, fil Madeira 1243" defaultValue={source?.color || ""}/></label>
        <label>Emplacement<select name="location" defaultValue={source?.location || "Poitrine gauche"}>{source?.location && !["Poitrine gauche", "Poitrine droite", "Manche", "Dos", "Autre"].includes(source.location) && <option>{source.location}</option>}{["Poitrine gauche", "Poitrine droite", "Manche", "Dos", "Autre"].map((v) => <option key={v}>{v}</option>)}</select></label>
        <label>Texte à personnaliser<input name="customText" defaultValue={source?.customText || ""}/></label></div>
      {p?.size && <p className="aw-muted">Ancienne information taille / dimensions : {p.size}</p>}
      <label>Logo source <small>Image, PDF, AI ou EPS, 20 Mo maximum. {source?.logoUrl ? "Logo existant conservé si aucun fichier n’est choisi." : ""}</small><input type="file" name="logo" accept="image/*,.pdf,.ai,.eps"/></label>
      <p className="aw-muted">Importe ensuite l’artwork commun dans la section « Artworks de cet article ».</p>
      {p && <p className="aw-notice">Une modification des caractéristiques crée une nouvelle version des BAT. L’ancienne validation reste dans l’historique.</p>}
    </WorkflowForm>
  </section>;
}
function MarkingChoices({ markings, selected = markings.map((p) => p.id) }) {
  return <fieldset><legend>Personnalisations présentées dans cet artwork</legend>{markings.map((p) => <label className="aw-check" key={p.id}><input type="checkbox" name="markingId" value={p.id} defaultChecked={selected.includes(p.id)}/>{personalizationLabel(p, { product: false })} · {p.quantity} pièce(s)</label>)}</fieldset>;
}
function GroupChoices({ dossier, item, selected = [item.lineItemId] }) {
  const peers = dossier.items.filter((i) => i.id !== item.id && i.isActive !== false && i.requirement !== "none" && item.productId && i.productId === item.productId);
  if (!peers.length) return null;
  return <fieldset><legend>Regrouper d’autres tailles dans ce BAT</legend><p>Les marquages seront repris sur les tailles non préparées. Les tailles déjà préparées doivent avoir les mêmes caractéristiques.</p>{peers.map((i) => <label className="aw-check" key={i.id}><input type="checkbox" name="groupItemId" value={i.id} defaultChecked={selected.includes(i.lineItemId)}/>{i.variantTitle || i.sizeLabel || "Variante"} · {i.quantity} pièce(s){i.colorLabel && i.colorLabel !== item.colorLabel ? " · autre couleur : à vérifier" : ""}</label>)}</fieldset>;
}
function ArtworkComparison({ proof, file, previous }) {
  const [url, setUrl] = useState(null);
  useEffect(() => { const next = file ? URL.createObjectURL(file) : null; setUrl(next); return () => { if (next) URL.revokeObjectURL(next); }; }, [file]);
  const render = (src, mime, title) => mime === "application/pdf" || /\.pdf(?:\?|$)/i.test(src) ? <iframe src={src} title={title} className="aw-pdf"/> : <img src={src} alt={title}/>;
  if (!url && !previous) return null;
  return <section className="aw-comparison"><div><h4>{url ? `Version actuelle V${proof.version}` : `Version précédente V${previous.version}`}</h4>{render(url ? proof.imageUrl : previous.imageUrl, url ? proof.mimeType : previous.mimeType, "Artwork précédent")}</div><div><h4>{url ? "Nouvel artwork à enregistrer" : `Version actuelle V${proof.version}`}</h4>{render(url || proof.imageUrl, url ? file.type : proof.mimeType, "Nouvel artwork")}</div></section>;
}
function ProofView({ proof, p, caseId, readOnly, item = null, markings = [], dossier = null, partners = {} }) {
  const [mode, setMode] = useState(null); const [file, setFile] = useState(null);
  const pdf = proof.mimeType === "application/pdf" || /\.pdf(?:\?|$)/i.test(proof.imageUrl);
  const linked = artworkMarkings(proof, p ? [p] : []); const sizes = sizeSummary(proof);
  const summary = artworkSummary(proof).length ? artworkSummary(proof) : linked;
  const point = commentPoint(proof.commentaireClient);
  const previous = dossier && dossierProofs(dossier).find((pr) => pr.id === proof.supersedesId);
  const changeMode = (next) => { if (mode && document.querySelector('[data-workflow-dirty="true"]') && !window.confirm("Fermer le formulaire sans enregistrer ?")) return; setMode(mode === next ? null : next); setFile(null); };
  return <article className={`aw-proof ${!proof.isCurrent ? "historic" : ""}`} id={`bat-${proof.id}`}>
    <div className="aw-between"><div><h3>{p?.productTitle || proof.snapshot?.productTitle || "BAT"}{sizes.total > 0 ? ` · ${sizes.total} vêtements` : ""}</h3><small>BAT V{proof.version}{proof.deletedAt ? " · retiré" : !proof.isCurrent ? " · historique" : ""}</small></div><span className={`aw-badge ${proof.status === "approuve" ? "success" : proof.status === "modification_demandee" ? "warning" : ""}`}>{proof.deletedAt ? "Retiré" : proof.status === "approuve" ? "Validé" : proof.status === "modification_demandee" ? "À corriger" : proof.envoyeLe ? "En attente du client" : "À envoyer"}</span></div>
    {sizes.articles.length > 0 && <div className="aw-chips">{sizes.articles.map((i) => <span className="aw-chip" key={i.lineItemId}>{[i.colorLabel, i.sizeLabel || i.variantTitle].filter(Boolean).join(" / ")} : {i.quantity}</span>)}</div>}
    {!proof.deletedAt && <a href={proof.imageUrl} target="_blank" rel="noreferrer" className="aw-proof-preview">{pdf ? <span>Consulter l’artwork PDF ↗</span> : <span className="aw-image-wrap"><img src={proof.imageUrl} alt={`Artwork V${proof.version}`} loading="lazy"/>{point && <span className="aw-point" style={{ left: `${point.x}%`, top: `${point.y}%` }} aria-label="Repère du commentaire client">1</span>}</span>}</a>}
    <p className="aw-muted">{proof.fileName || "Fichier artwork"}</p>
    <div className="aw-chips">{summary.map((row, i) => <span className="aw-chip" key={i}>{row.type} · {row.location} · {row.quantity} pièces</span>)}</div>
    {sizes.articles.length > 0 && <a href={`/app/artwork-summary?proof=${proof.id}`} target="_blank" rel="noreferrer">Récapitulatif tailles (PDF)</a>}
    {proof.commentaireClient && <div className="aw-correction"><strong>Correction demandée par le client</strong><blockquote>{proof.commentaireClient}</blockquote></div>}
    {proof.partnerSentAt && <p className="aw-muted">Dernier envoi de ce BAT au prestataire : {date(proof.partnerSentAt)} à {proof.partnerSentTo}.</p>}
    {proof.envoyeLe && <small>Dernier envoi : {date(proof.envoyeLe)}</small>}{proof.reponduLe && <small>Réponse : {date(proof.reponduLe)}{proof.approvedVia ? ` · ${proof.approvedVia}` : ""}</small>}
    {!readOnly && proof.isCurrent && item && <>
      <div className="aw-toolbar"><button type="button" className={`aw-button ${proof.status === "modification_demandee" ? "primary" : ""}`} onClick={() => changeMode(proof.status === "modification_demandee" ? "correct" : "revise")}>{proof.status === "modification_demandee" ? "Préparer la correction" : "Remplacer l’artwork"}</button>{proof.status === "approuve" && <button type="button" className="aw-button primary" onClick={() => changeMode("partner")}>Envoyer au prestataire</button>}</div>
      {mode === "correct" && <ArtworkCorrectionEditor dossier={dossier} proof={proof} Form={WorkflowForm} Comparison={ArtworkComparison} onDone={() => setMode(null)} onCancel={() => changeMode("correct")}/>}
      {mode === "partner" && <ArtworkPartnerForm dossier={dossier} proof={proof} partners={partners} Form={WorkflowForm} onDone={() => setMode(null)} onCancel={() => changeMode("partner")}/>}
      <details><summary>Autres actions</summary><div className="aw-toolbar"><button className="aw-button" onClick={() => changeMode("correct")}>Modifier les personnalisations et le BAT</button><button className="aw-button" onClick={() => changeMode("link")}>Modifier les marquages associés</button>{proof.status === "en_attente" && <button className="aw-button" onClick={() => changeMode("approve")}>Validation reçue ailleurs</button>}</div><WorkflowForm intent="delete-proof" caseId={caseId} tone="danger" label="Supprimer l’artwork" confirm={`Retirer ce BAT pour ${sizes.total || "les"} vêtements et tous ses marquages ? Le lien client sera désactivé et la production concernée sera à revoir. L’historique sera conservé.`}><input type="hidden" name="itemId" value={item.id}/><input type="hidden" name="proofId" value={proof.id}/></WorkflowForm></details>
      {mode && !["correct", "partner"].includes(mode) && <div className="aw-editor"><div className="aw-between"><h4>{mode === "revise" ? "Remplacer le fichier" : mode === "link" ? "Périmètre du BAT commun" : "Validation reçue ailleurs"}</h4><button className="aw-button" onClick={() => changeMode(mode)}>Annuler</button></div><WorkflowForm intent={mode === "revise" ? "revise-proof" : mode === "link" ? "link-proof" : "manual-approve"} caseId={caseId} label={mode === "approve" ? "Enregistrer la validation" : "Enregistrer la nouvelle version"} confirm={mode === "approve" ? "Confirmer que le client a validé cette version commune pour tous les marquages et vêtements associés ?" : null} onDone={() => { setMode(null); setFile(null); }}>
        <input type="hidden" name="itemId" value={item.id}/><input type="hidden" name="proofId" value={proof.id}/><input type="hidden" name="personalizationId" value={p?.id || ""}/>
        {mode === "approve" ? <label>Canal de validation<select name="approvedVia" required><option>Email</option><option>WhatsApp</option><option>Téléphone</option></select></label> : <><MarkingChoices markings={markings} selected={linked.map((row) => row.personalizationId || row.id)}/><GroupChoices dossier={dossier} item={item} selected={dossier.personalizations.filter((row) => row.proofs.some((pr) => pr.id === proof.id)).map((row) => row.lineItemId)}/>{mode === "revise" && <><label>Nouvel artwork<input required type="file" name="proofImages" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)}/></label><ArtworkComparison proof={proof} file={file}/></>}<p className="aw-notice">Une nouvelle validation sera requise pour tous les marquages et vêtements de ce BAT.</p></>}
      </WorkflowForm></div>}
    </>}
    {previous && <details><summary>Comparer avec la version précédente</summary><ArtworkComparison proof={proof} previous={previous}/></details>}
  </article>;
}
function PersonalizationView({ p, dossier, item }) {
  const [editing, setEditing] = useState(false); const [duplicating, setDuplicating] = useState(false); const [copy, setCopy] = useState(false);
  return <section className="aw-personalization"><div className="aw-between"><h3>{personalizationLabel(p, { product: false })} · {p.quantity} pièce(s)</h3>{!dossier.archivedAt && item.requirement === "required" && <div className="aw-toolbar"><button className="aw-button" onClick={() => { if (editing && document.querySelector('[data-workflow-dirty="true"]') && !window.confirm("Fermer sans enregistrer les modifications ?")) return; setEditing(!editing); }}>Modifier</button><button className="aw-button" onClick={() => setDuplicating(true)}>Dupliquer cette personnalisation</button><button className="aw-button" onClick={() => setCopy(!copy)}>Copier sur des articles</button></div>}</div>
    <p>{[p.dimensions, p.color, p.location, p.customText].filter(Boolean).join(" · ") || "Caractéristiques à compléter"}</p>
    {p.logoUrl && <a href={p.logoUrl} target="_blank" rel="noreferrer">Ouvrir le logo source ↗</a>}
    {editing && <PersonalizationEditor dossier={dossier} item={item} p={p} onClose={() => setEditing(false)}/>}
    {duplicating && <PersonalizationEditor dossier={dossier} item={item} duplicate={p} onClose={() => setDuplicating(false)}/>}
    {copy && <WorkflowForm intent="copy-personalization" caseId={dossier.id} label="Copier les paramètres et le logo" onDone={() => setCopy(false)}><input type="hidden" name="personalizationId" value={p.id}/><p>Les artworks et validations ne sont pas copiés.</p>{dossier.items.filter((i) => i.requirement === "required" && i.lineItemId !== p.lineItemId).map((i) => <label className="aw-check" key={i.id}><input type="checkbox" name="targetItemId" value={i.id}/>{i.title} · {i.variantTitle} · {i.quantity} pièce(s)</label>)}</WorkflowForm>}
    {!dossier.archivedAt && <details><summary>Enregistrer comme modèle réutilisable</summary><WorkflowForm intent="save-template" caseId={dossier.id} label="Enregistrer le modèle"><input type="hidden" name="personalizationId" value={p.id}/><label>Nom du modèle<input name="templateName" maxLength={100} placeholder="Ex. Broderie poitrine yacht" required/></label><small>Le logo et les caractéristiques seront disponibles dans tous les dossiers de cette boutique. Les quantités restent propres aux vêtements choisis.</small></WorkflowForm></details>}
    {!currentProofs(p).length && <p className="aw-notice">Ce marquage reste à associer à un artwork dans la section ci-dessous.</p>}
  </section>;
}
function DossierArtworks({ dossier, partners }) {
  const proofs = dossierProofs(dossier); const current = proofs.filter((pr) => pr.isCurrent && !pr.deletedAt);
  const history = proofs.filter((pr) => !pr.isCurrent || pr.deletedAt);
  const view = (proof) => { const context = artworkContext(dossier, proof); return <ProofView key={proof.id} proof={proof} {...context} partners={partners} dossier={dossier} caseId={dossier.id} readOnly={Boolean(dossier.archivedAt) || !proof.isCurrent || context.item?.requirement !== "required"}/>; };
  return <section aria-label="BAT communs du dossier"><div className="aw-proof-grid">{current.map(view)}</div>{!current.length && <div className="aw-empty aw-panel"><h2>Prépare ton premier BAT</h2><p>Regroupe les vêtements, ajoute leurs marquages et importe l’artwork dans l’assistant.</p></div>}{history.length > 0 && <details><summary>Historique des artworks ({history.length})</summary><div className="aw-proof-grid">{history.map(view)}</div></details>}</section>;
}
function SendPreview({ dossier, mode, subject, message }) {
  const [open, setOpen] = useState(false); const [preview, setPreview] = useState(false);
  const requiredIds = dossier.items.filter((i) => i.requirement === "required").map((i) => i.lineItemId);
  const proofs = uniqueProofs(dossier.personalizations.filter((p) => requiredIds.includes(p.lineItemId)).flatMap((p) => currentProofs(p).filter((proof) => proof.status === "en_attente" && (mode === "reminder" ? proof.envoyeLe : !proof.envoyeLe)).map((proof) => ({ ...proof, productTitle: artworkLabel(proof, { english: true }) }))));
  if (!proofs.length) return null;
  const summary = summarizeCase(dossier.items, dossier.personalizations); const blocked = summary.missing || summary.pendingQualification;
  const name = `${dossier.name}${dossier.yachtName ? ` / ${dossier.yachtName}` : ""}`;
  return <section><button className={`aw-button ${mode === "reminder" ? "" : "primary"}`} disabled={blocked} onClick={() => setOpen(!open)}>{mode === "reminder" ? "Relancer le client" : `Envoyer ${proofs.length} BAT au client`}</button>
    {blocked && <small className="aw-muted">Qualifie les articles et prépare tous les BAT requis avant l’envoi.</small>}
    {open && <div className="aw-editor"><h3>{mode === "reminder" ? "Vérifier la relance" : "Vérifier l’envoi"}</h3><WorkflowForm intent="send-for-validation" caseId={dossier.id} label={mode === "reminder" ? "Confirmer la relance" : "Confirmer l’envoi"} onDone={() => setOpen(false)}>
      <input type="hidden" name="sendMode" value={mode}/><input type="hidden" name="proofIds" value={proofs.map((p) => p.id).join(",")}/>
      <label>Destinataire<input type="email" name="customerEmail" defaultValue={dossier.email || ""} required/></label>
      <p className="aw-muted">Langue de l’email et du parcours client : anglais.</p>
      <div className="aw-send-grid">{proofs.map((p) => <article key={p.id} className="aw-send-card"><a href={p.imageUrl} target="_blank" rel="noreferrer">{p.mimeType === "application/pdf" ? <span className="aw-file-icon">PDF</span> : <img src={p.imageUrl} alt={`Aperçu ${p.productTitle}`}/>}<strong>{p.productTitle} · V{p.version}</strong></a><p>{sizeSummary(p).articles.map((i) => `${i.variantTitle || i.sizeLabel}: ${i.quantity}`).join(" · ")}</p><small>Pièce jointe : récapitulatif tailles PDF{p.envoyeLe ? ` · dernier envoi ${date(p.envoyeLe)}` : ""}</small></article>)}</div>
      <button className="aw-button" type="button" onClick={() => setPreview(!preview)}>{preview ? "Fermer l’aperçu client" : "Voir comme le client"}</button>
      {preview && <div className="pr-page aw-client-preview"><style>{REVIEW_STYLES}</style><p className="pr-preview-banner">Aperçu interne — aucune réponse ni aucun envoi ne peut être enregistré ici.</p>{proofs.map((p) => <ProofReviewContent key={p.id} proof={{ ...p, markings: artworkSummary(p).length ? artworkSummary(p) : artworkMarkings(p, [p.personalization]), sizes: sizeSummary(p) }} summaryUrl={`/app/artwork-summary?proof=${p.id}`}/>)}</div>}
      <div className="aw-email-preview"><strong>{applyPlaceholders(subject, { orderName: name })}</strong><p>{applyPlaceholders(message, { orderName: name })}</p><p>Review my designs</p></div>
    </WorkflowForm></div>}
  </section>;
}
function DossierView({ dossier, shop, emailSubject, emailMessage, templates, partners }) {
  const [tab, setTab] = useState("bats"); const [editor, setEditor] = useState(null); const [builder, setBuilder] = useState(null); const [expandedItem, setExpandedItem] = useState(null);
  const markDirty = useContext(DirtyContext); const summary = summarizeCase(dossier.items, dossier.personalizations); const issues = preparationIssues(dossier);
  const guard = () => !document.querySelector('[data-workflow-dirty="true"]') || window.confirm("Quitter le formulaire sans enregistrer les modifications ?");
  const changeTab = (next) => { if (next !== tab && guard()) { setTab(next); setBuilder(null); } };
  const prepare = (item = null) => { if (guard()) { setBuilder({ item }); setTab("bats"); } };
  return <>
    <header className="aw-panel aw-dossier-header"><div className="aw-between"><div><span className="aw-eyebrow">Dossier {dossier.name}</span><h1>{dossier.yachtName || dossier.customerName || "Dossier artwork"}</h1><p>{dossier.customerName || dossier.email || "Client non renseigné"}{dossier.responsibleName ? ` · Responsable : ${dossier.responsibleName}` : ""}</p><Badge status={summary.status}/></div><div className="aw-toolbar">{!dossier.archivedAt && !builder && <button className="aw-button primary" onClick={() => prepare()}>Préparer un BAT</button>}<a className="aw-button" href={`https://${shop}/admin/draft_orders/${dossier.draftOrderId.split("/").pop()}`} target="_blank" rel="noreferrer">Ouvrir dans Shopify ↗</a></div></div>
      <div className="aw-toolbar"><strong>{summary.approved} / {summary.total} BAT validés</strong><span>{dossier.items.reduce((sum, i) => sum + i.quantity, 0)} vêtements au devis</span>{dossier.orderId && <span className="aw-badge">Commande {dossier.orderName}</span>}</div>
      <div className="aw-progress" role="progressbar" aria-label="BAT validés" aria-valuenow={summary.approved} aria-valuemin={0} aria-valuemax={summary.total || 1}><span style={{ width: `${summary.total ? summary.approved / summary.total * 100 : 0}%` }}/></div>
      {dossier.archivedAt ? <div className="aw-notice"><p>Dossier archivé. Les fichiers et l’historique sont conservés.</p><WorkflowForm caseId={dossier.id} intent="restore-case" label="Réactiver le dossier"/></div> : <><div className="aw-toolbar aw-send-actions"><SendPreview dossier={dossier} mode="new" subject={emailSubject} message={emailMessage}/><SendPreview dossier={dossier} mode="reminder" subject={emailSubject} message={emailMessage}/></div><details><summary>Informations et actions du dossier</summary><p className="aw-muted">Dernière modification Shopify : {date(dossier.shopifyUpdatedAt)} · Synchronisé : {date(dossier.syncedAt)}</p><WorkflowForm intent="rename-yacht" caseId={dossier.id} label="Enregistrer le nom"><label>Nom du yacht<input name="yachtName" defaultValue={dossier.yachtName || ""}/></label></WorkflowForm><WorkflowForm intent="assign-case" caseId={dossier.id} label="Enregistrer le responsable"><label>Responsable du dossier<input name="responsibleName" maxLength={100} defaultValue={dossier.responsibleName || ""} placeholder="Nom du membre de l’équipe"/></label></WorkflowForm><WorkflowForm intent="archive-case" caseId={dossier.id} tone="danger" label="Retirer du suivi artwork" confirm="Retirer ce devis du suivi actif ? Ses fichiers et son historique seront conservés."/></details></>}
    </header>
    {!dossier.archivedAt && !builder && issues.length > 0 && <section className="aw-notice"><strong>Avant l’envoi · {issues.length} élément(s) à compléter</strong><ul className="aw-issues">{issues.map(({ item, message }) => <li key={item.id}><span>{message}</span><button className="aw-button" onClick={() => { if (guard()) { setTab("articles"); setBuilder(null); setExpandedItem(item.id); } }}>Compléter</button></li>)}</ul></section>}
    <nav className="aw-tabs" aria-label="Sections du dossier">{[["bats", `BAT communs (${summary.total})`], ["articles", "Vêtements et marquages"], ["models", `Modèles (${templates.length})`], ["history", `Historique (${dossier.events.length})`]].map(([key, title]) => <button key={key} aria-pressed={tab === key} className={tab === key ? "active" : ""} onClick={() => changeTab(key)}>{title}</button>)}</nav>
    {tab === "bats" && <>{builder && <ArtworkBuilder key={`${dossier.id}-${builder.item?.id || "new"}`} dossier={dossier} templates={templates} initialItem={builder.item} Form={WorkflowForm} markDirty={markDirty} onClose={() => setBuilder(null)} onDone={() => setBuilder(null)}/>}{!builder && <DossierArtworks dossier={dossier} partners={partners}/>}</>}
    {tab === "history" && <section className="aw-panel"><h2>Historique du dossier</h2>{dossier.removedPersonalizations?.length > 0 && <details><summary>BAT d’articles retirés du devis ({dossier.removedPersonalizations.length})</summary>{dossier.removedPersonalizations.map((p) => <section key={p.id}><h3>{p.productTitle} · article retiré ou à vérifier</h3><div className="aw-proof-grid">{p.proofs.map((proof) => <ProofView key={proof.id} proof={proof} p={p} caseId={dossier.id} readOnly/>)}</div></section>)}</details>}{dossier.events.length ? <ol className="aw-timeline">{dossier.events.map((e) => <li key={e.id}><strong>{e.message}</strong><small>{date(e.createdAt)} · {e.actor}</small></li>)}</ol> : <p>Les nouveaux événements apparaîtront ici.</p>}</section>}
    {tab === "models" && <section className="aw-panel"><h2>Modèles de marquages</h2><p>Enregistre un marquage depuis « Vêtements et marquages » pour reprendre ses caractéristiques et son logo dans d’autres dossiers.</p>{templates.map((t) => <div className="aw-search-result" key={t.id}><div><strong>{t.name}</strong><small>{[t.specs.type, t.specs.location, t.specs.dimensions].filter(Boolean).join(" · ")}</small></div>{!dossier.archivedAt && <WorkflowForm intent="delete-template" caseId={dossier.id} tone="danger" label="Supprimer le modèle" confirm="Supprimer ce modèle pour la boutique ? Les marquages déjà créés resteront inchangés."><input type="hidden" name="templateId" value={t.id}/></WorkflowForm>}</div>)}</section>}
    {tab === "articles" && dossier.items.map((item) => <section id={`article-${item.id}`} key={item.id} className="aw-panel"><div className="aw-between"><div><h2>{item.title}</h2><p className="aw-muted">{item.variantTitle || "Variante non renseignée"} · {item.quantity} vêtements{item.sku ? ` · Réf. ${item.sku}` : ""}</p></div><span className="aw-badge">{item.requirement === "required" ? "BAT requis" : item.requirement === "none" ? "Sans BAT requis" : "À qualifier"}</span></div>
      {!dossier.archivedAt && item.requirement !== "none" && <button className="aw-button" onClick={() => prepare(item)}>Préparer un BAT pour ces vêtements</button>}
      <details open={expandedItem === item.id} onToggle={(e) => { if (e.currentTarget.open) setExpandedItem(item.id); }}><summary>Marquages et suivi de cette taille</summary>
        {!dossier.archivedAt && <WorkflowForm intent="set-requirement" caseId={dossier.id} label="Appliquer" className="aw-inline-form"><input type="hidden" name="itemId" value={item.id}/><label>Suivi de cet article<select key={item.requirement} name="requirement" defaultValue={item.requirement}><option value="pending">À qualifier</option><option value="required">BAT requis</option><option value="none">Sans BAT requis</option></select></label></WorkflowForm>}
        {item.requirement !== "required" && <p className="aw-muted">{item.requirement === "none" ? "Cet article n’entre pas dans la validation des BAT." : "Décide si cet article nécessite un artwork, ou prépare-le directement avec l’assistant."}</p>}
        {item.requirement === "required" && <p className="aw-muted">Les mêmes vêtements peuvent recevoir plusieurs marquages. Leurs quantités ne s’additionnent pas aux pièces à livrer.</p>}
        {dossier.personalizations.filter((p) => p.lineItemId === item.lineItemId).map((p) => <PersonalizationView key={p.id} p={p} item={item} dossier={dossier}/>)}
        {item.requirement === "required" && !dossier.archivedAt && <button className="aw-button" onClick={() => setEditor(item.id)}>Ajouter une personnalisation</button>}
        {editor === item.id && <PersonalizationEditor dossier={dossier} item={item} onClose={() => setEditor(null)}/>}
      </details>
    </section>)}
  </>;
}
export default function Personnalisation() {
  const data = useLoaderData(); const navigate = useNavigate(); const navigation = useNavigation(); const revalidator = useRevalidator(); const [add, setAdd] = useState(false);
  const [dirty, setDirty] = useState({}); const dirtyRef = useRef({});
  const markDirty = useRef((id, value) => { if (Boolean(dirtyRef.current[id]) === value) return; dirtyRef.current = { ...dirtyRef.current, [id]: value }; setDirty(dirtyRef.current); }).current;
  const hasDirty = Object.values(dirty).some(Boolean);
  const blocker = useBlocker(hasDirty);
  useEffect(() => { if (blocker.state === "blocked") { if (window.confirm("Quitter ce dossier et perdre les modifications non enregistrées ?")) { dirtyRef.current = {}; setDirty({}); blocker.proceed(); } else blocker.reset(); } }, [blocker]);
  useEffect(() => { const before = (e) => { if (Object.values(dirtyRef.current).some(Boolean)) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", before); return () => window.removeEventListener("beforeunload", before); }, []);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && !Object.values(dirtyRef.current).some(Boolean) && navigation.state === "idle" && revalidator.state === "idle") revalidator.revalidate(); };
    window.addEventListener("focus", refresh); const interval = setInterval(refresh, 45000); return () => { window.removeEventListener("focus", refresh); clearInterval(interval); };
  }, [navigation.state, revalidator]);
  const location = useLocation(); const url = new URL(location.pathname + location.search, "https://app.local"); const filter = url.searchParams.get("status") || "all"; const q = url.searchParams.get("q") || ""; const archive = url.searchParams.get("archived") === "1";
  const [query, setQuery] = useState(q); const [page, setPage] = useState(1);
  const update = (key, value) => { const params = new URLSearchParams(url.search); value ? params.set(key, value) : params.delete(key); params.delete("case"); setPage(1); navigate(`?${params}`, { preventScrollReset: true }); };
  const open = (id) => { const params = new URLSearchParams(url.search); params.set("case", id); setAdd(false); navigate(`?${params}`); };
  const active = data.cases.filter((c) => Boolean(c.archivedAt) === archive);
  const matching = active.filter((c) => `${c.name} ${c.customerName || ""} ${c.yachtName || ""} ${c.email || ""} ${c.products} ${c.responsibleName || ""}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
  const visible = matching.filter((c) => filter === "all" || c.summary.status === filter);

  return <DirtyContext.Provider value={markDirty}><s-page heading={data.selected ? "Dossier artwork" : "Dossiers artwork"}><style>{WORKSPACE_STYLES}</style><main className="aw-workspace">
    {data.syncError && <p role="alert" className="aw-error">{data.syncError} Les dernières données connues sont affichées.</p>}
    {data.selected ? <><Link className="aw-back" to={`?${new URLSearchParams([...url.searchParams].filter(([k]) => k !== "case"))}`}>← Retour aux dossiers</Link><DossierView key={data.selected.id} dossier={data.selected} shop={data.shop} emailSubject={data.emailSubject} emailMessage={data.emailMessage} templates={data.templates} partners={data.partners}/></> : <>
      <header className="aw-between"><div><h1>Dossiers artwork</h1><p className="aw-muted">Uniquement les devis nécessitant un BAT. Derniers devis modifiés en premier.</p></div><button className="aw-button primary" onClick={() => setAdd(!add)}>Ajouter un devis Shopify</button></header>
      {add && <AddCase onClose={() => setAdd(false)} onOpen={open}/>}
      {!archive && <nav className="aw-queue" aria-label="Travail à réaliser">{["a_personnaliser", "a_corriger", "a_envoyer", "en_attente_reponse", "valide"].map((status) => <button key={status} aria-pressed={filter === status} onClick={() => update("status", filter === status ? "" : status)}><strong>{matching.filter((c) => c.summary.status === status).length}</strong><span>{({ a_personnaliser: "À préparer", a_corriger: "Corrections client", a_envoyer: "Prêts à envoyer", en_attente_reponse: "En attente client", valide: "BAT validés" })[status]}</span></button>)}</nav>}
      <section className="aw-panel"><div className="aw-toolbar"><form className="aw-toolbar aw-grow" onSubmit={(e) => { e.preventDefault(); update("q", query); }}><label className="aw-grow">Rechercher un dossier<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Devis, client, yacht, produit, référence ou responsable"/></label><button className="aw-button">Rechercher</button></form><WorkflowForm intent="refresh-index" label="Actualiser Shopify"/></div>
        <div className="aw-filters"><button className={filter === "all" ? "active" : ""} onClick={() => update("status", "")}>Tous ({matching.length})</button>{Object.entries(CASE_STATUSES).map(([key, meta]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => update("status", key)}>{meta.label} ({matching.filter((c) => c.summary.status === key).length})</button>)}<button onClick={() => update("archived", archive ? "" : "1")}>{archive ? "Voir les actifs" : "Archives"}</button></div>
        <p className="aw-muted">{visible.length} dossier(s){archive ? " archivé(s)" : " actif(s)"} · Index Shopify : {date(data.indexedAt)}</p>
        {!visible.length ? <div className="aw-empty"><h2>{q || filter !== "all" ? "Aucun dossier ne correspond" : "Aucun dossier artwork"}</h2><p>{q || filter !== "all" ? "Essaie un autre filtre ou une autre recherche." : `Ajoute un devis ici ou utilise le tag ${ARTWORK_TAG} dans Shopify.`}</p></div> : <div className="aw-table-wrap"><table className="aw-table"><thead><tr><th>Devis / client</th><th>Avancement</th><th>Suivi équipe</th><th>Action</th></tr></thead><tbody>{visible.slice(0, page * 30).map((c) => <tr key={c.id}><td><button className="aw-name" onClick={() => open(c.id)}>{c.yachtName || c.customerName || c.name}</button><small>{c.name} · {c.customerName || c.email || "Client non renseigné"}</small></td><td><Badge status={c.summary.status}/><small>{c.summary.approved} / {c.summary.total} BAT validé(s){c.summary.pendingQualification ? " · articles à qualifier" : ""}</small></td><td>{c.responsibleName || "Non attribué"}<small>{c.waitingSince ? `En attente depuis ${Math.max(0, Math.floor((Date.now() - new Date(c.waitingSince).getTime()) / 86400000))} jour(s)` : `Modifié le ${date(c.shopifyUpdatedAt)}`}</small></td><td><button className="aw-button" onClick={() => open(c.id)}>{CASE_STATUSES[c.summary.status].action}</button></td></tr>)}</tbody></table></div>}
        {visible.length > page * 30 && <button className="aw-button" onClick={() => setPage(page + 1)}>Afficher 30 dossiers supplémentaires</button>}
      </section>
    </>}
  </main></s-page></DirtyContext.Provider>;
}
