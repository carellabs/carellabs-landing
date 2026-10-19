import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { DOTTED_CARD_TEXTS, PAGES, SCHEMES } from "./viewports";

for (const page of PAGES) {
  for (const scheme of SCHEMES) {
    for (const width of [390, 1280]) {
      test(`${page.path} @ ${width}px (${scheme.name}) has no accessibility violations`, async ({ page: p }) => {
        await p.emulateMedia({ colorScheme: scheme.name });
        await p.setViewportSize({ width, height: 900 });
        await p.goto(page.path);
        // Precondición: el esquema se aplica de verdad. Sin ella, axe auditaría dos
        // veces la misma pantalla y el test pasaría sin comprobar el otro esquema.
        const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
        expect(bg, `el esquema ${scheme.name} no se aplica`).toBe(scheme.bg);
        const results = await new AxeBuilder({ page: p })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
          .analyze();
        const summary = results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`);
        expect(summary, "violaciones de accesibilidad").toEqual([]);

        // Un contraste "incompleto" es un contraste que axe NO ha podido evaluar (p. ej. por un
        // degradado de fondo), no uno que pase. Si no se mira, un texto ilegible puede colarse.
        // Única excepción: los textos de la primera tarjeta del laboratorio (fondo de puntos),
        // que se comprueban a mano en theme.spec.ts contra el peor fondo posible. Se exime exactamente
        // lo que allí se mide: cada texto y el enlace que lleve dentro (el nombre de la destacada es un
        // enlace, `.name a`). Cualquier otro elemento dentro de esos textos sigue sin estar cubierto.
        const incompleteContrast = results.incomplete
          .filter((i) => i.id === "color-contrast")
          .flatMap((i) => i.nodes.map((n) => String(n.target[0])));
        const manuallyChecked = DOTTED_CARD_TEXTS.flatMap((sel) => [sel, `${sel} a`]).join(", ");
        const unchecked: string[] = [];
        for (const selector of incompleteContrast) {
          const covered = await p
            .locator(selector)
            .evaluate(
              (el, texts) => el.closest(".apps .app:first-child") !== null && el.matches(texts),
              manuallyChecked,
            );
          if (!covered) unchecked.push(selector);
        }
        expect(unchecked, "contrastes que axe no pudo evaluar y nadie comprueba").toEqual([]);
      });
    }
  }
}

// La 404 no tiene skip link ni nav, así que no comparte el bucle de PAGES; se audita aparte.
for (const scheme of SCHEMES) {
  for (const width of [390, 1280]) {
    test(`/no-existe (404) @ ${width}px (${scheme.name}) has no accessibility violations`, async ({ page: p }) => {
      await p.emulateMedia({ colorScheme: scheme.name });
      await p.setViewportSize({ width, height: 900 });
      const response = await p.goto("/no-existe");
      expect(response?.status()).toBe(404);
      const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg, `el esquema ${scheme.name} no se aplica`).toBe(scheme.bg);

      const results = await new AxeBuilder({ page: p })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
      const incomplete = results.incomplete.filter((i) => i.id === "color-contrast").flatMap((i) => i.nodes);
      expect(incomplete.map((n) => String(n.target[0])), "contrastes que axe no pudo evaluar").toEqual([]);
    });
  }
}
