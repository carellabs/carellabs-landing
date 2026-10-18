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

test.describe("hero role at 320px", () => {
  test.use({ viewport: { width: 320, height: 568 } });

  for (const pg of PAGES) {
    test(`${pg.path}: the «·» stays on the line where the job title ends`, async ({ page }) => {
      await page.goto(pg.path);
      const { jobTitle } = messagesOf(pg.lang).meta;
      const measured = await page.locator(".hero .who span").evaluate((span, title) => {
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
        return {
          text,
          lines: rects(0, text.length).length,
          titleEndTop: rects(titleEnd - 1, titleEnd)[0]?.top,
          dotTop: rects(dot, dot + 1)[0]?.top,
        };
      }, jobTitle);

      // Controles positivos: se ha medido de verdad (el texto lleva el rol y el punto), y a 320 px el rol
      // se parte en dos líneas, que es cuando el punto podría quedar suelto.
      expect(measured.text).toContain(jobTitle);
      expect(measured.dotTop, "no se ha podido medir el «·»").toBeDefined();
      expect(measured.lines, "a 320 px el rol deja de partirse: el test ya no comprueba nada").toBeGreaterThan(1);

      expect(
        Math.abs(measured.dotTop! - measured.titleEndTop!),
        `el «·» empieza una línea: está a ${measured.dotTop} y el final del cargo a ${measured.titleEndTop}`,
      ).toBeLessThan(1);
    });

    // El punto no empieza línea en ningún ancho de móvil, no solo a 320 px: se recorre de 320 a 420 px.
    test(`${pg.path}: the «·» is never the first character of a line between 320 and 420px`, async ({ page }) => {
      await page.goto(pg.path);
      const widths = Array.from({ length: 26 }, (_, i) => 320 + i * 4);
      const wrappedAt: number[] = [];
      const atLineStart: number[] = [];
      for (const width of widths) {
        await page.setViewportSize({ width, height: 568 });
        const m = await page.locator(".hero .who span").evaluate((span) => {
          const node = span.firstChild as Text;
          const rects = (from: number, to: number) => {
            const range = document.createRange();
            range.setStart(node, from);
            range.setEnd(node, to);
            return Array.from(range.getClientRects());
          };
          const dot = node.data.indexOf("·");
          return {
            lines: rects(0, node.data.length).length,
            firstLeft: rects(0, 1)[0].left,
            dotLeft: rects(dot, dot + 1)[0].left,
          };
        });
        if (m.lines > 1) wrappedAt.push(width);
        // Empieza línea cuando está a la altura del margen izquierdo del texto.
        if (Math.abs(m.dotLeft - m.firstLeft) < 1) atLineStart.push(width);
      }
      // Control positivo: a 320 px el rol se parte (si no, el recorrido no comprobaría nada).
      expect(wrappedAt, "el rol no se parte en ningún ancho: el test no comprueba nada").toContain(320);
      expect(atLineStart, "anchos (px) en los que el «·» empieza una línea").toEqual([]);
    });
  }
});
