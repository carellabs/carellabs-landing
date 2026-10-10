import type es from "./es.json";

/** Idiomas del sitio. */
export type Lang = "es" | "en";

/** Forma de los textos: es.json es la referencia y en.json tiene que cumplirla. */
export type Messages = typeof es;
