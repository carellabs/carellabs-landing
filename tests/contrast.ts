/** Utilidades de contraste WCAG para colores que calcula el navegador (`rgb(...)` / `rgba(...)`). */

/** Canales de un color: 0-255 y alfa 0-1. */
type Rgba = { r: number; g: number; b: number; a: number };

/** Convierte `rgb(r, g, b)` o `rgba(r, g, b, a)` en canales. */
export function parseColor(color: string): Rgba {
  const [r, g, b, a] = (color.match(/[\d.]+/g) ?? []).map(Number);
  if ([r, g, b].some((v) => v === undefined || Number.isNaN(v))) {
    throw new Error(`color no reconocido: ${color}`);
  }
  return { r, g, b, a: a ?? 1 };
}

/** Luminancia relativa WCAG de un color. */
export function luminance(color: string): number {
  const { r, g, b } = parseColor(color);
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** Relación de contraste WCAG entre dos colores (1 a 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Color resultante de pintar `over` (con su alfa) sobre `under` (opaco).
 * Sirve para el peor caso de un fondo con puntos translúcidos: el centro de un punto.
 */
export function blend(over: string, under: string): string {
  const top = parseColor(over);
  const base = parseColor(under);
  const mix = (t: number, b: number) => Math.round(t * top.a + b * (1 - top.a));
  return `rgb(${mix(top.r, base.r)}, ${mix(top.g, base.g)}, ${mix(top.b, base.b)})`;
}
