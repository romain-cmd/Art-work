// Remplace les placeholders {{cle}} dans un texte personnalisable par
// l'utilisateur (Réglages) par leur valeur réelle. Une clé inconnue est
// laissée telle quelle plutôt que supprimée, pour rester visible en cas de
// faute de frappe côté admin.
export function applyPlaceholders(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : match
  );
}
