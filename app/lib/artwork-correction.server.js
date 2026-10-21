import { correctionFingerprint } from "./artwork-correction.js";
import { createArtwork, invalidateArtworks, reopenArtworkProduction } from "./shared-artwork.server.js";

export async function reviseArtwork(db, { dossier, proof, rows, file, expected }) {
  return db.$transaction(async (tx) => {
    const current = await tx.proof.findFirst({ where: { id: proof.id, isCurrent: true, deletedAt: null } });
    const items = await tx.artworkItem.findMany({ where: { shop: dossier.shop, draftOrderId: dossier.draftOrderId, isActive: true } });
    const personalizations = await tx.personalization.findMany({ where: { shop: dossier.shop, draftOrderId: dossier.draftOrderId, isActive: true }, include: { proofs: true } });
    if (!current || expected !== correctionFingerprint({ items, personalizations }, current)) throw new Error("Ce BAT ou ses marquages ont changé pendant la correction. Actualise le dossier.");
    const updated = []; const changed = [];
    for (const row of rows) for (const member of row.members) {
      const before = personalizations.find((p) => p.id === member.id);
      const p = await tx.personalization.update({ where: { id: member.id }, data: { ...row.specs, ...row.logo, quantity: member.quantity } });
      updated.push(p);
      if (["type", "quantity", "location", "dimensions", "color", "customText", "logoUrl"].some((k) => p[k] !== before[k])) changed.push(p);
    }
    const next = await createArtwork(tx, updated, file, current);
    // Other views sharing these specifications also require a fresh approval.
    await invalidateArtworks(tx, changed, dossier.id, "Caractéristiques modifiées lors de la correction du BAT.", [next.id]);
    await reopenArtworkProduction(tx, updated.filter((p) => !changed.some((row) => row.id === p.id)), dossier.id);
    await tx.artworkEvent.create({ data: { caseId: dossier.id, actor: "Équipe", message: `BAT V${current.version} repris intégralement : caractéristiques et artwork enregistrés en V${next.version}. Nouvelle validation client requise.${current.partnerSentTo ? ` Prévenir le prestataire déjà destinataire : ${current.partnerSentTo}.` : ""}` } });
    return next;
  });
}
