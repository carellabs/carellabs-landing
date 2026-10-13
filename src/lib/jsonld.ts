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
