/* eslint-disable react/prop-types */
import { useState } from "react";
import { correctionFingerprint, correctionGroups } from "../lib/artwork-correction";

export function ArtworkCorrectionEditor({ dossier, proof, Form, Comparison, onDone, onCancel }) {
  const [source] = useState(dossier);
  const [rows, setRows] = useState(() => correctionGroups(source, proof).map((g) => ({ ...g, quantities: Object.fromEntries(g.members.map((m) => [m.id, m.quantity])) })));
  const [file, setFile] = useState(null);
  const update = (key, patch) => setRows((rows) => rows.map((r) => r.key === key ? { ...r, ...patch } : r));
  return <section className="aw-editor" aria-label="Correction complète du BAT"><div className="aw-between"><h3>Modifier les personnalisations et le BAT</h3><button className="aw-button" onClick={onCancel}>Annuler la correction</button></div>
    {proof.commentaireClient && <blockquote>{proof.commentaireClient}</blockquote>}
    {proof.partnerSentTo && <p className="aw-notice">Ce BAT a déjà été transmis à {proof.partnerSentTo}. Préviens ce prestataire avant de poursuivre avec une nouvelle version.</p>}
    <p>Modifie les caractéristiques puis ajoute l’artwork corrigé. Les modifications s’appliquent aux tailles regroupées ci-dessous. Une nouvelle validation client sera requise.</p>
    <Form intent="correct-artwork" caseId={dossier.id} label="Enregistrer la correction complète" onDone={onDone}>
      <input type="hidden" name="proofId" value={proof.id}/><input type="hidden" name="artworkFingerprint" value={correctionFingerprint(source, proof)}/><input type="hidden" name="corrections" value={JSON.stringify(rows)}/>
      {rows.map((row, index) => <section className="aw-personalization" key={row.key} aria-label={`Corriger le marquage ${index + 1}`}><h4>Marquage {index + 1} · {row.members.map((m) => m.variant).join(" / ")}</h4><div className="aw-grid">
        <label>Technique<select value={row.type} onChange={(e) => update(row.key, { type: e.target.value })}>{["Broderie", "Impression", "Gravure", "Sérigraphie"].map((v) => <option key={v}>{v}</option>)}</select></label>
        <label>Emplacement<select value={row.location} onChange={(e) => update(row.key, { location: e.target.value })}>{[...new Set(["Poitrine gauche", "Poitrine droite", "Manche", "Dos", "Autre", row.location])].map((v) => <option key={v}>{v}</option>)}</select></label>
        <label>Dimensions du marquage<input value={row.dimensions} onChange={(e) => update(row.key, { dimensions: e.target.value })}/></label><label>Couleur du marquage<input value={row.color} onChange={(e) => update(row.key, { color: e.target.value })}/></label><label>Texte à personnaliser<input value={row.customText} onChange={(e) => update(row.key, { customText: e.target.value })}/></label>
      </div><details><summary>Quantités de ce marquage par taille</summary>{row.members.map((m) => <label key={m.id}>{m.variant} · sur {m.max} vêtements<input type="number" min="1" max={m.max} required value={row.quantities[m.id]} onChange={(e) => update(row.key, { quantities: { ...row.quantities, [m.id]: e.target.value } })}/></label>)}</details>
        {row.logoUrl && <a href={row.logoUrl} target="_blank" rel="noreferrer">Consulter le logo actuel ↗</a>}<label>Remplacer le logo source (facultatif)<input type="file" name={`logo-${row.key}`} accept="image/*,.pdf,.ai,.eps"/><small>Le logo actuel est conservé sans nouveau fichier. Image, PDF, AI ou EPS · 20 Mo maximum.</small></label>
      </section>)}
      <label>Nouvel artwork corrigé<input type="file" name="proofImages" accept="image/png,image/jpeg,image/webp,application/pdf" required onChange={(e) => setFile(e.target.files?.[0] || null)}/><small>PNG, JPG, WebP ou PDF · 20 Mo maximum.</small></label>
      <Comparison proof={proof} file={file}/>
      <p className="aw-notice">Les anciennes versions et réponses sont conservées. Les autres vues utilisant des caractéristiques modifiées devront aussi être revalidées. La production concernée sera remise à revoir.</p>
    </Form>
  </section>;
}

export function ArtworkPartnerForm({ dossier, proof, partners, Form, onDone, onCancel }) {
  const [source] = useState(dossier); const [groups] = useState(() => correctionGroups(source, proof));
  const [selected, setSelected] = useState(groups.map((g) => g.key));
  const suggestion = (keys) => { const emails = groups.filter((g) => keys.includes(g.key)).map((g) => partners[g.type] || ""); return emails.length && emails.every((s) => s && s === emails[0]) ? emails[0] : ""; };
  const [email, setEmail] = useState(() => suggestion(groups.map((g) => g.key)));
  const toggle = (key, checked) => { const next = checked ? [...selected, key] : selected.filter((id) => id !== key); if (!email || email === suggestion(selected)) setEmail(suggestion(next)); setSelected(next); };
  return <section className="aw-editor" aria-label="Envoi au prestataire"><div className="aw-between"><h3>Envoyer le BAT validé au prestataire</h3><button className="aw-button" onClick={onCancel}>Annuler l’envoi</button></div>
    <Form intent="email-artwork" caseId={dossier.id} label="Confirmer l’envoi au prestataire" onDone={onDone}>
      <input type="hidden" name="proofId" value={proof.id}/><input type="hidden" name="artworkFingerprint" value={correctionFingerprint(source, proof)}/>
      <fieldset><legend>Marquages confiés à ce prestataire</legend>{groups.map((g) => <label className="aw-check" key={g.key}><input type="checkbox" checked={selected.includes(g.key)} onChange={(e) => toggle(g.key, e.target.checked)}/>{g.type} · {g.location} · {g.members.reduce((n, m) => n + m.quantity, 0)} pièces{selected.includes(g.key) && g.members.map((m) => <input key={m.id} type="hidden" name="targetMarkingId" value={m.id}/>)}</label>)}</fieldset>
      <label>Email du prestataire<input type="email" name="partnerEmail" required value={email} onChange={(e) => setEmail(e.target.value)}/></label>
      <label className="aw-check"><input type="checkbox" name="rememberPartner"/>Mémoriser cette adresse pour les techniques sélectionnées</label>
      <h4>Pièces jointes</h4><ul><li>BAT V{proof.version} validé : {proof.fileName || "artwork"}</li><li>Récapitulatif PDF des tailles et quantités du BAT</li><li>Logos sources des marquages sélectionnés, dans leur format d’origine</li></ul>
      <p>Le message précisera les caractéristiques et quantités par taille des seuls marquages sélectionnés. Le fichier commun peut présenter d’autres marquages.</p>
      {!selected.length && <p className="aw-error" role="alert">Sélectionne au moins un marquage à confier au prestataire.</p>}
    </Form>
  </section>;
}
