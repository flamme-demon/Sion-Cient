/**
 * Réduit un corps de message Markdown à une ligne lisible.
 *
 * Les aperçus — barre des épinglés, liste des épinglés — affichaient le corps
 * brut : un message de documentation y apparaissait comme
 * « ``` ## Download mods at: … ## ## Disable a mod: ## - Add a single `#` … ».
 * On ne cherche pas à rendre le Markdown, seulement à en retirer la ponctuation
 * de balisage pour que l'aperçu se lise.
 */
export function plainPreview(raw: string): string {
  return raw
    // Blocs de code : on garde le contenu, on jette les clôtures et le langage.
    .replace(/```[a-zA-Z0-9-]*\n?/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    // Images avant liens : `![alt](url)` ne doit pas laisser un `!` orphelin.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Titres, citations et puces en début de ligne.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    // Emphase : on retire les marqueurs, pas le texte.
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    // Tout aperçu tient sur une ligne.
    .replace(/\s+/g, " ")
    .trim();
}
