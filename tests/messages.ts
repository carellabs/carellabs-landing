import { readFileSync } from "node:fs";

/** Idiomas del sitio. */
export type Lang = "es" | "en";

/** Lo que leen los tests de src/i18n: así no fijan cifras ni textos que cambian con el contenido. */
export interface Messages {
  meta: { jobTitle: string };
  experience: { items: { company: string; highlights?: string[] }[] };
  about: { stackTitle: string; stackGroups: { label: string; items: string[] }[] };
}

/** Los textos de un idioma, tal como están en src/i18n. */
export const messagesOf = (lang: Lang): Messages =>
  JSON.parse(readFileSync(`src/i18n/${lang}.json`, "utf8"));
