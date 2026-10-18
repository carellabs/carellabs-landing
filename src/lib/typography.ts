/** Espacio de no separación (U+00A0): el navegador no parte la línea en él. */
const NO_BREAK_SPACE = "\xA0";

/**
 * Pega cada separador « · » a la palabra que lo precede con un espacio de no separación, para que una
 * línea nunca empiece por el punto: si hay que partir, el salto cae después de él (antes de lo que sigue).
 * Se aplica al pintar, no en los textos de i18n, que conservan el espacio normal.
 *
 * @param text Un texto con separadores « · » (con un espacio a cada lado).
 */
export function noBreakBeforeDot(text: string): string {
  return text.replaceAll(" · ", `${NO_BREAK_SPACE}· `);
}
