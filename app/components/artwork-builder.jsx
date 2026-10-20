/* eslint-disable react/prop-types */
import { useEffect, useId, useRef, useState } from "react";
import { acceptsBat } from "../lib/artwork-status";
import { builderFingerprint, compactMarking, compatibleItems } from "../lib/artwork-workspace";

const steps = ["Vêtements", "Marquages", "Artwork", "Vérification"];
const newMarking = (items) => ({ key: crypto.randomUUID(), type: "Broderie", location: "Poitrine gauche", dimensions: "", color: "", customText: "", quantities: Object.fromEntries(items.map((i) => [i.id, i.quantity])) });

export function ArtworkBuilder({ dossier: liveDossier, templates, initialItem, Form, onClose, onDone, markDirty }) {
  const dossier = useRef(liveDossier).current;
  const id = useId(); const ref = useRef(null); const titleRef = useRef(null);
  const [step, setStep] = useState(0); const [selectedIds, setSelectedIds] = useState(initialItem ? [initialItem.id] : []);
  const [baseId, setBaseId] = useState(initialItem?.id || "");
  const [rows, setRows] = useState([]); const [existingIds, setExistingIds] = useState(dossier.personalizations.filter((p) => p.lineItemId === initialItem?.lineItemId).map((p) => p.id));
  const [files, setFiles] = useState([]); const [error, setError] = useState(""); const [colorsConfirmed, setColorsConfirmed] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null); const [changed, setChanged] = useState(false);
  const base = dossier.items.find((i) => i.id === baseId);
  const items = [base, ...dossier.items.filter((i) => selectedIds.includes(i.id) && i.id !== baseId)].filter(Boolean);
  const existing = dossier.personalizations.filter((p) => p.lineItemId === base?.lineItemId);
  const peers = base ? compatibleItems(dossier.items, base) : [];
  const sameColorPeers = peers.filter((i) => i.id !== base.id && i.colorLabel && i.colorLabel === base.colorLabel);
  const differentColors = new Set(items.map((i) => i.colorLabel || i.variantTitle || "")).size > 1;
  const total = items.reduce((sum, i) => sum + i.quantity, 0);
  useEffect(() => { titleRef.current?.focus(); }, [step]);
  useEffect(() => { markDirty(id, changed); return () => markDirty(id, false); }, [id, changed, markDirty]);
  useEffect(() => {
    const url = files[0] ? URL.createObjectURL(files[0]) : null; setPreviewUrl(url);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [files]);
  function touch() { setChanged(true); }
  function updateRow(key, patch) { touch(); setRows((rows) => rows.map((r) => r.key === key ? { ...r, ...patch } : r)); }
  function selectBase(value) {
    if (rows.length && value !== baseId && !window.confirm("Changer l’article de référence et effacer les nouveaux marquages saisis ?")) return;
    const item = dossier.items.find((i) => i.id === value);
    setBaseId(value); setSelectedIds(value ? [value] : []); setExistingIds([]); setRows([]); setColorsConfirmed(false); touch();
    if (item) setExistingIds(dossier.personalizations.filter((p) => p.lineItemId === item.lineItemId).map((p) => p.id));
  }
  function chooseItems(ids) {
    setSelectedIds(ids); setColorsConfirmed(false); touch();
    setRows((rows) => rows.map((r) => ({ ...r, quantities: { ...Object.fromEntries(dossier.items.filter((i) => ids.includes(i.id)).map((i) => [i.id, i.quantity])), ...r.quantities } })));
  }
  function next() {
    if (step === 0 && (!items.length || (differentColors && !colorsConfirmed))) { setError("Sélectionne les vêtements et confirme les couleurs concernées."); return; }
    if (step === 1) {
      if (!rows.length && !existingIds.length) { setError("Ajoute ou sélectionne au moins un marquage."); return; }
      if (rows.some((r) => items.some((i) => !Number.isInteger(Number(r.quantities[i.id])) || Number(r.quantities[i.id]) < 1 || Number(r.quantities[i.id]) > i.quantity))) { setError("Vérifie les quantités de chaque marquage."); return; }
    }
    if (step === 2 && (!files.length || files.length > 10 || files.some((f) => !acceptsBat(f)))) { setError("Dépose de 1 à 10 fichiers PNG, JPG, WebP ou PDF de 20 Mo maximum chacun."); return; }
    setError(""); setStep(step + 1);
  }
  function close() { if (!changed || window.confirm("Fermer l’assistant et perdre cette préparation non enregistrée ?")) onClose(); }
  return <section ref={ref} className="aw-builder aw-panel" aria-label="Assistant de création de BAT" onChange={touch} data-workflow-dirty={changed ? "true" : undefined}>
    <div className="aw-between"><div><span className="aw-eyebrow">Nouveau BAT commun</span><h2 ref={titleRef} tabIndex={-1}>{steps[step]}</h2></div><button className="aw-button" type="button" onClick={close}>Fermer l’assistant</button></div>
    <ol className="aw-steps" aria-label="Étapes de création">{steps.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    <Form intent="prepare-artwork" caseId={dossier.id} label="Enregistrer le BAT" hideSubmit={step !== 3} onDone={() => { markDirty(id, false); onDone(); }} onSubmit={(e) => { if (step !== 3) { e.preventDefault(); next(); } }}>
      <input type="hidden" name="selectedItems" value={JSON.stringify(items.map((i) => i.id))}/><input type="hidden" name="existingIds" value={JSON.stringify(existingIds)}/><input type="hidden" name="markings" value={JSON.stringify(rows)}/><input type="hidden" name="confirmColors" value={colorsConfirmed ? "yes" : "no"}/>
      <input type="hidden" name="preparationFingerprint" value={builderFingerprint(dossier, items.map((i) => i.id))}/>
      <div hidden={step !== 0}>
        <p>Choisis les vêtements qui partageront le même visuel. Les tailles restent distinctes dans Shopify et les livraisons.</p>
        <label>Article de référence<select value={baseId} onChange={(e) => selectBase(e.target.value)}><option value="">Choisir un article</option>{dossier.items.filter((i) => i.requirement !== "none").map((i) => <option key={i.id} value={i.id}>{i.title} · {i.variantTitle} · {i.quantity} pièces</option>)}</select></label>
        {base && <><p><strong>{base.title} · {base.variantTitle}</strong> est inclus.</p>{sameColorPeers.length > 0 && <div className="aw-suggestion"><span>{sameColorPeers.length} autre(s) taille(s) de la même couleur peuvent partager ce BAT.</span><button type="button" className="aw-button" onClick={() => chooseItems([...new Set([...selectedIds, ...sameColorPeers.map((i) => i.id)])])}>Ajouter les tailles de même couleur</button></div>}
          {peers.filter((i) => i.id !== base.id).map((i) => <label className="aw-choice" key={i.id} htmlFor={`${id}-${i.id}`} aria-label={`Inclure ${i.variantTitle || i.sizeLabel || "cette variante"}`}><input id={`${id}-${i.id}`} type="checkbox" checked={selectedIds.includes(i.id)} onChange={(e) => chooseItems(e.target.checked ? [...selectedIds, i.id] : selectedIds.filter((id) => id !== i.id))}/><span><strong>Taille · {i.variantTitle || i.sizeLabel || "Variante"}</strong><small>{i.quantity} vêtements{!i.colorLabel || i.colorLabel !== base.colorLabel ? " · Couleur à vérifier" : ""}{dossier.personalizations.some((p) => p.lineItemId === i.lineItemId) ? " · marquages existants conservés si identiques" : ""}</small></span></label>)}
          {differentColors && <label className="aw-check aw-notice"><input type="checkbox" checked={colorsConfirmed} onChange={(e) => setColorsConfirmed(e.target.checked)}/>J’ai vérifié que cet artwork convient à toutes les couleurs sélectionnées.</label>}
          <p className="aw-total">{total} vêtements · {items.length} variante(s)</p></>}
      </div>
      <div hidden={step !== 1}>
        <p>Un marquage correspond à une technique et un emplacement. Plusieurs marquages peuvent concerner les mêmes vêtements.</p>
        {existing.length > 0 && <fieldset><legend>Marquages existants de l’article de référence</legend>{existing.map((p) => <label className="aw-choice" key={p.id}><input type="checkbox" checked={existingIds.includes(p.id)} onChange={(e) => setExistingIds(e.target.checked ? [...existingIds, p.id] : existingIds.filter((id) => id !== p.id))}/><span>{compactMarking(p)}<small>{p.quantity} pièces sur {base.variantTitle} · caractéristiques conservées</small></span></label>)}<small>Les autres tailles déjà préparées conservent leurs quantités. Les tailles non préparées reprennent ces marquages sur tous leurs vêtements.</small></fieldset>}
        {rows.map((row, index) => <section className="aw-editor" key={row.key}><div className="aw-between"><h3>Marquage {index + 1}</h3><button type="button" className="aw-button" onClick={() => { touch(); setRows(rows.filter((r) => r.key !== row.key)); }}>Retirer ce marquage</button></div>
          <label>Reprendre un modèle<select value={row.templateId || ""} onChange={(e) => { const template = templates.find((t) => t.id === e.target.value); updateRow(row.key, { ...(template?.specs || {}), templateId: template?.id || "", logoUrl: template?.specs.logoUrl || null }); }}><option value="">Saisie libre</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <div className="aw-grid"><label>Technique<select value={row.type} onChange={(e) => updateRow(row.key, { type: e.target.value })}>{["Broderie", "Impression", "Gravure", "Sérigraphie"].map((v) => <option key={v}>{v}</option>)}</select></label><label>Emplacement<select value={row.location} onChange={(e) => updateRow(row.key, { location: e.target.value })}>{[...new Set(["Poitrine gauche", "Poitrine droite", "Manche", "Dos", "Autre", row.location])].filter(Boolean).map((v) => <option key={v}>{v}</option>)}</select></label>
            <label>Largeur × hauteur (mm)<input value={row.dimensions} placeholder="Ex. 80 × 35 mm" onChange={(e) => updateRow(row.key, { dimensions: e.target.value })}/></label><label>Couleur du marquage<input value={row.color} placeholder="Ex. fil Madeira 1243" onChange={(e) => updateRow(row.key, { color: e.target.value })}/></label><label>Texte à personnaliser<input value={row.customText} onChange={(e) => updateRow(row.key, { customText: e.target.value })}/></label>
          </div>
          {row.logoUrl && <a href={row.logoUrl} target="_blank" rel="noreferrer">Logo du modèle conservé · Voir le fichier ↗</a>}
          <label>Logo source {row.logoUrl ? "· remplacer (facultatif)" : "(facultatif)"}<input type="file" name={`logo-${row.key}`} accept="image/*,.pdf,.ai,.eps"/><small>Image, PDF, AI ou EPS · 20 Mo maximum.</small></label>
          <details><summary>Seulement certaines pièces ? Ajuster les quantités</summary>{items.map((i) => <label key={i.id}>{i.variantTitle} · sur {i.quantity} vêtements<input type="number" min="1" max={i.quantity} value={row.quantities[i.id] ?? i.quantity} onChange={(e) => updateRow(row.key, { quantities: { ...row.quantities, [i.id]: e.target.value } })}/></label>)}</details>
          <p className="aw-muted">{items.reduce((sum, i) => sum + Number(row.quantities[i.id] || 0), 0)} pièces recevront ce marquage.</p>
        </section>)}
        <button type="button" className="aw-button" disabled={rows.length >= 20} onClick={() => { touch(); setRows([...rows, newMarking(items)]); }}>Ajouter un autre marquage</button>
      </div>
      <div hidden={step !== 2}>
        <p>Dépose le fichier qui présente les {existingIds.length + rows.length} marquage(s) sélectionné(s). Chaque fichier sera un BAT à valider séparément.</p>
        <label className="aw-dropzone">Artwork image ou PDF<input name="proofImages" type="file" multiple accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setFiles(Array.from(e.target.files || []))}/><small>Glisse les fichiers ici ou clique pour les choisir. 10 fichiers maximum · 20 Mo par fichier.</small></label>
        <ul>{files.map((f, index) => <li key={`${f.name}-${index}`}>{f.name} · {(f.size / 1024 / 1024).toFixed(1)} Mo</li>)}</ul>
      </div>
      <div hidden={step !== 3}>
        <div className="aw-review-grid"><div>{previewUrl && (files[0]?.type === "application/pdf" ? <iframe className="aw-pdf" src={previewUrl} title="Aperçu du BAT à enregistrer"/> : <img className="aw-builder-preview" src={previewUrl} alt="Aperçu du BAT à enregistrer"/>)}</div><div><h3>{base?.title} · {total} vêtements</h3><ul>{items.map((i) => <li key={i.id}>{i.variantTitle} : {i.quantity}</li>)}</ul><h3>Marquages couverts</h3><ul>{existing.filter((p) => existingIds.includes(p.id)).map((p) => <li key={p.id}>{compactMarking(p)} · existant</li>)}{rows.map((r) => <li key={r.key}>{compactMarking(r)} · {r.dimensions || "Dimensions non renseignées"}</li>)}</ul><h3>Fichiers</h3><ul>{files.map((f, index) => <li key={index}>{f.name}</li>)}</ul><p>Un récapitulatif PDF des tailles accompagnera chaque BAT lors de l’envoi.</p><p className="aw-muted">L’enregistrement prépare les BAT. L’envoi au client se fait ensuite depuis le dossier.</p></div></div>
      </div>
      {error && <p className="aw-error" role="alert">{error}</p>}
      <div className="aw-toolbar">{step > 0 && <button type="button" className="aw-button" onClick={() => { setError(""); setStep(step - 1); }}>Précédent</button>}{step < 3 && <button type="button" className="aw-button primary" onClick={next}>Continuer</button>}</div>
    </Form>
  </section>;
}
