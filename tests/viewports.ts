/** Anchos representativos: móvil pequeño, móvil, tablet, portátil, escritorio. */
export const VIEWPORTS = [
  { name: "mobile-xs", width: 320, height: 568 },
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1024, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

export const PAGES = [
  { path: "/", lang: "es" },
  { path: "/en/", lang: "en" },
] as const;

/** Esquemas de color (`prefers-color-scheme`) y el fondo del body que debe producir cada uno. */
export const SCHEMES = [
  { name: "dark", bg: "rgb(14, 15, 17)" },
  { name: "light", bg: "rgb(244, 244, 241)" },
] as const;

/**
 * Textos de la primera tarjeta del laboratorio (FinApp), que tiene un fondo de puntos
 * (`radial-gradient`). axe no puede resolver ese fondo y marca estos textos como
 * "incomplete"; `theme.spec.ts` los comprueba a mano contra el peor fondo posible.
 */
export const DOTTED_CARD_TEXTS = [".name", ".host", ".status", ".desc"] as const;

/** Etiqueta y elementos de la lista de especialidades del hero, por idioma. */
export const HERO_FOCUS = {
  es: { label: "Especialidades", items: ["Backend distribuido", "Integraciones ERP", "Offline-first"] },
  en: { label: "Specialties", items: ["Distributed backend", "ERP integrations", "Offline-first"] },
} as const;
