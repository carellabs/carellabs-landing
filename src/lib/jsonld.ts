/**
 * Serializa un objeto para ponerlo dentro de un `<script type="application/ld+json">`.
 *
 * Un `<` dentro del texto (`</script>`, `<!--`) podría cerrar la etiqueta o abrir un comentario del
 * HTML y colar marcado en la página. Se escribe como `\u003c`, que el JSON lee de vuelta como `<`:
 * los datos no cambian.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/** Los textos que usa el `Person`: un subconjunto de los de src/i18n/*.json. */
export interface PersonTexts {
  hero: { name: string; note: string[] };
  meta: { jobTitle: string; locality: string };
  contact: { links: { href: string }[] };
}

/** Una URL https absoluta: lo único que cuenta como perfil en `sameAs`. */
const isHttpsUrl = (href: string) => URL.canParse(href) && new URL(href).protocol === "https:";

/**
 * El JSON-LD de schema.org `Person` de una página, ya serializado y escapado. Es lo único que el layout
 * pone dentro del `<script type="application/ld+json">`: ningún texto puede cerrar la etiqueta.
 *
 * @param t Los textos del idioma de la página.
 * @param url La URL canónica de la página; de su origen sale el `@id` común a todos los idiomas.
 */
export function personJsonLd(t: PersonTexts, url: URL): string {
  return serializeJsonLd({
    "@context": "https://schema.org",
    "@type": "Person",
    // El mismo en todas las páginas del sitio: así se entiende que describen a la misma persona.
    "@id": new URL("/#person", url).href,
    name: t.hero.name,
    jobTitle: t.meta.jobTitle,
    url: url.href,
    // Los perfiles en otros sitios: de los enlaces de contacto, solo los https (no un `mailto:`, por ejemplo).
    sameAs: t.contact.links.map((link) => link.href).filter(isHttpsUrl),
    address: { "@type": "PostalAddress", addressLocality: t.meta.locality, addressCountry: "ES" },
    knowsAbout: t.hero.note,
  });
}
