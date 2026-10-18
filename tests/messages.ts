import { readFileSync } from "node:fs";

/** Idiomas del sitio. */
export type Lang = "es" | "en";

/** Lo que leen los tests de src/i18n: así no fijan cifras ni textos que cambian con el contenido. */
export interface Messages {
  experience: { items: { company: string; highlights?: string[] }[] };
}

/** Los textos de un idioma, tal como están en src/i18n. */
export const messagesOf = (lang: Lang): Messages =>
  JSON.parse(readFileSync(`src/i18n/${lang}.json`, "utf8"));
