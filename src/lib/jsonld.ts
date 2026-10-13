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

/**
 * El JSON-LD de schema.org `Person` de una página, ya serializado y escapado. Es lo único que el layout
 * pone dentro del `<script type="application/ld+json">`: ningún texto puede cerrar la etiqueta.
 *
 * @param t Los textos del idioma de la página.
 * @param url La URL canónica de la página.
 */
export function personJsonLd(t: PersonTexts, url: URL): string {
  return serializeJsonLd({
    "@context": "https://schema.org",
    "@type": "Person",
    name: t.hero.name,
    jobTitle: t.meta.jobTitle,
    url: url.href,
    sameAs: t.contact.links.map((link) => link.href),
    address: { "@type": "PostalAddress", addressLocality: t.meta.locality, addressCountry: "ES" },
    knowsAbout: t.hero.note,
  });
}
