// Shared between the client email preview and server-side email rendering.
export function applyPlaceholders(template, values) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? match);
}
