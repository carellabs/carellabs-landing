import { test, expect } from "@playwright/test";
import { DOTTED_CARD_TEXTS, PAGES, SCHEMES } from "./viewports";
import { blend, contrast } from "./contrast";

for (const pg of PAGES) {
  test(`${pg.path}: declares support for both color schemes`, async ({ page }) => {
    await page.goto(pg.path);
    await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute("content", "light dark");
    await expect(
      page.locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]'),
    ).toHaveAttribute("content", "#0e0f11");
    await expect(
      page.locator('meta[name="theme-color"][media="(prefers-color-scheme: light)"]'),
    ).toHaveAttribute("content", "#f4f4f1");
  });

  for (const scheme of SCHEMES) {
    test.describe(`${pg.path} with prefers-color-scheme: ${scheme.name}`, () => {
      test.use({ colorScheme: scheme.name });

      test("the body background follows the user's scheme", async ({ page }) => {
        await page.goto(pg.path);
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        expect(bg).toBe(scheme.bg);
      });

      // axe no evalúa el contraste de elementos que no son texto (WCAG 1.4.11): el ámbar de
      // relleno contra el fondo claro da 1.7:1, así que estos rellenos llevan borde --accent.
      test("current job node and live status keep non-text contrast", async ({ page }) => {
        await page.goto(pg.path);
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        const node = await page
          .locator("#trayectoria .job.now")
          .evaluate((el) => getComputedStyle(el, "::before").borderTopColor);
        expect(contrast(node, bg), `nodo ${node} sobre ${bg}`).toBeGreaterThanOrEqual(3);

        // Ninguna app usa hoy el estado "live": se fuerza en el DOM para ejercitar la regla CSS.
        const live = await page
          .locator(".apps .app")
          .first()
          .evaluate((card) => {
            const status = card.querySelector<HTMLElement>(".status")!;
            status.dataset.status = "live";
            const cs = getComputedStyle(status);
            return {
              border: cs.borderTopColor,
              fill: cs.backgroundColor,
              text: cs.color,
              card: getComputedStyle(card).backgroundColor,
            };
          });
        expect(contrast(live.border, live.card), `borde live ${JSON.stringify(live)}`).toBeGreaterThanOrEqual(3);
        expect(contrast(live.text, live.fill), `texto live ${JSON.stringify(live)}`).toBeGreaterThanOrEqual(4.5);
      });

      // axe no puede resolver el fondo de puntos de la tarjeta FinApp (un degradado) y marca sus
      // textos como "incomplete" (ver a11y.spec.ts). Se comprueban aquí contra el PEOR fondo
      // posible: el color de la tarjeta con el centro de un punto translúcido encima.
      test("the first app card text keeps AA contrast over its dotted background", async ({ page }) => {
        await page.goto(pg.path);
        const card = page.locator(".apps .app").first();
        const { cardBg, image, dots, texts } = await card.evaluate((el, selectors) => {
          const pick = (sel: string) => (el.querySelector(`${sel} a`) ?? el.querySelector(sel)) as HTMLElement;
          // `--dots` llega minificado (`#ededea12`): se resuelve a `rgba()` con un elemento de prueba.
          const probe = document.createElement("span");
          probe.style.color = "var(--dots)";
          document.body.append(probe);
          const dots = getComputedStyle(probe).color;
          probe.remove();
          return {
            cardBg: getComputedStyle(el).backgroundColor,
            image: getComputedStyle(el).backgroundImage,
            dots,
            texts: selectors.map((sel) => ({ sel, color: getComputedStyle(pick(sel)).color })),
          };
        }, [...DOTTED_CARD_TEXTS]);

        // Controles positivos: es la tarjeta con degradado, el punto cambia de verdad el
        // fondo y se han leído todos los textos.
        expect(image).toContain("radial-gradient");
        const worst = blend(dots, cardBg);
        expect(worst, "el punto no cambia el fondo: el peor caso no se está calculando").not.toBe(cardBg);
        expect(texts).toHaveLength(DOTTED_CARD_TEXTS.length);

        for (const { sel, color } of texts) {
          expect(contrast(color, worst), `${sel}: ${color} sobre ${worst}`).toBeGreaterThanOrEqual(4.5);
        }
      });

      // axe no evalúa :hover, así que el estado del botón principal se comprueba aquí.
      // Sin transición (reducedMotion) para leer el color final al instante.
      test.describe("primary button", () => {
        test.use({ reducedMotion: "reduce" });

        test("keeps AA contrast at rest and on hover", async ({ page }) => {
          await page.goto(pg.path);
          const btn = page.locator(".hero .btn.primary");
          const colors = () =>
            btn.evaluate((el) => {
              const cs = getComputedStyle(el);
              return { bg: cs.backgroundColor, fg: cs.color };
            });

          const rest = await colors();
          await btn.hover();
          const hover = await colors();

          // Control positivo: el hover cambia de verdad el aspecto del botón.
          expect(hover.bg).not.toBe(rest.bg);
          expect(contrast(rest.fg, rest.bg), `reposo ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(hover.fg, hover.bg), `hover ${JSON.stringify(hover)}`).toBeGreaterThanOrEqual(4.5);
        });
      });
    });
  }
}
