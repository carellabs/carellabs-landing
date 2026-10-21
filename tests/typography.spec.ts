import { test, expect } from "@playwright/test";
import { PAGES } from "./viewports";
import { messagesOf } from "./messages";
import { noBreakBeforeDot } from "../src/lib/typography";

// Un separador «·» no puede empezar una línea: se pega a la palabra anterior con un espacio de no
// separación (U+00A0, escrito aquí como \xA0) y el salto, si hace falta, cae después del punto.

test("noBreakBeforeDot glues the dot to the word before it, so a line can only break after it", () => {
  const cases: [string, string][] = [
    ["Senior Full Stack Engineer · Madrid", "Senior Full Stack Engineer\xA0· Madrid"],
    ["A · B · C", "A\xA0· B\xA0· C"],
    // Sin el separador con espacios a los dos lados no hay nada que pegar.
    ["Madrid", "Madrid"],
    ["A·B", "A·B"],
    ["A ·B", "A ·B"],
    ["A· B", "A· B"],
  ];
  for (const [text, expected] of cases) expect(noBreakBeforeDot(text), text).toBe(expected);
  // Aplicarla dos veces no cambia nada más.
  const once = noBreakBeforeDot("Senior Full Stack Engineer · Madrid");
  expect(noBreakBeforeDot(once)).toBe(once);
});

// Dónde se parte el rol depende de cómo mida la fuente cada sistema (en Linux cabe en una línea a 320 px
// y en Windows no), así que no se confía en un ancho de pantalla concreto: se estrecha la caja del rol
// de 60 a 400 px, lo que recorre todos sus puntos de corte en cualquier sistema. El estilo se cambia por
// CSSOM, que la CSP de la web no bloquea (solo bloquea estilos en línea escritos en el HTML).
test.describe("hero role", () => {
  // Pantalla ancha: así la caja del rol solo la limita el `max-width` del recorrido, no la pantalla.
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const pg of PAGES) {
    test(`${pg.path}: at any width, the «·» stays on the line where the job title ends`, async ({ page }) => {
      await page.goto(pg.path);
      const { jobTitle } = messagesOf(pg.lang).meta;
      const sweep = await page.locator(".hero .who span").evaluate((span, title) => {
        const node = span.firstChild;
        if (!(node instanceof Text) || span.childNodes.length !== 1) throw new Error("el rol no es un único texto");
        const text = node.data;
        const rects = (from: number, to: number) => {
          const range = document.createRange();
          range.setStart(node, from);
          range.setEnd(node, to);
          return Array.from(range.getClientRects());
        };
        const titleEnd = text.indexOf(title) + title.length;
        const dot = text.indexOf("·");
        const results: { width: number; lines: number; dotTop?: number; titleEndTop?: number; dotLeft?: number; firstLeft?: number }[] = [];
        for (let width = 60; width <= 400; width += 4) {
          span.style.maxWidth = `${width}px`;
          results.push({
            width,
            lines: new Set(rects(0, text.length).map((r) => Math.round(r.top))).size,
            dotTop: rects(dot, dot + 1)[0]?.top,
            titleEndTop: rects(titleEnd - 1, titleEnd)[0]?.top,
            dotLeft: rects(dot, dot + 1)[0]?.left,
            firstLeft: rects(0, 1)[0]?.left,
          });
        }
        span.style.maxWidth = "";
        return { text, results };
      }, jobTitle);

      // Controles positivos: se ha medido el rol de verdad, y el recorrido incluye anchos en los que se
      // parte y anchos en los que cabe entero (si no, no estaría pasando por el punto de corte).
      expect(sweep.text).toContain(jobTitle);
      expect(sweep.results.every((r) => r.dotTop !== undefined), "no se ha podido medir el «·»").toBe(true);
      expect(sweep.results.some((r) => r.lines > 1), "el rol no se parte en ningún ancho").toBe(true);
      expect(sweep.results.some((r) => r.lines === 1), "el rol no cabe entero en ningún ancho").toBe(true);

      const dotOnAnotherLine = sweep.results.filter((r) => Math.abs(r.dotTop! - r.titleEndTop!) >= 1).map((r) => r.width);
      expect(dotOnAnotherLine, "anchos (px) en los que el «·» no está en la línea donde acaba el cargo").toEqual([]);
      const dotStartsLine = sweep.results.filter((r) => Math.abs(r.dotLeft! - r.firstLeft!) < 1).map((r) => r.width);
      expect(dotStartsLine, "anchos (px) en los que el «·» empieza una línea").toEqual([]);
    });
  }
});
