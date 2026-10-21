import { test, expect } from "@playwright/test";
import { VIEWPORTS, PAGES } from "./viewports";
import { VISIBLE_APPS } from "./apps";

for (const page of PAGES) {
  for (const vp of VIEWPORTS) {
    test.describe(`${page.path} @ ${vp.name} (${vp.width}px)`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

      test("lab mosaic: the featured card ends level with the rest of the grid", async ({ page: p }) => {
        await p.goto(page.path);
        const grid = await p.evaluate(() => {
          const apps = document.querySelector<HTMLElement>("#lab .apps")!;
          const cols = getComputedStyle(apps).gridTemplateColumns.split(" ").filter(Boolean).length;
          const cards = Array.from(apps.querySelectorAll<HTMLElement>(":scope > .app")).map((card) => {
            const r = card.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
          });
          return { cols, cards };
        });
        const [featured, ...rest] = grid.cards;
        // Las que comparten franja con la destacada: empiezan antes de que ella termine y van en otra columna.
        // Las de filas posteriores (una 4.ª app, por ejemplo) no cuentan.
        const peers = rest.filter((card) => card.top < featured!.bottom && card.left >= featured!.right);
        test.skip(grid.cols < 2 || peers.length === 0, "una columna o ninguna tarjeta al lado: no hay mosaico que nivelar");
        // La destacada solo ocupa dos filas si justo otras dos apps llenan su lado. Con más apps se queda en
        // una fila: alargada a dos, su texto corto dejaría un hueco vacío dentro de la tarjeta.
        expect(peers.length, "la destacada reserva más filas de las que sus vecinas llenan").toBe(
          VISIBLE_APPS.length === 3 ? 2 : 1,
        );
        // Si la destacada reservara una fila que nadie llena, sobresaldría por debajo de las de su lado.
        expect(featured!.bottom, "la tarjeta destacada no termina a la altura de las de su lado").toBe(
          Math.max(...peers.map((card) => card.bottom)),
        );
      });

      test("lab mosaic: the last row of cards is full (no empty cell at the end)", async ({ page: p }) => {
        await p.goto(page.path);
        const grid = await p.evaluate(() => {
          const apps = document.querySelector<HTMLElement>("#lab .apps")!;
          const cols = getComputedStyle(apps).gridTemplateColumns.split(" ").filter(Boolean).length;
          const cards = Array.from(apps.querySelectorAll<HTMLElement>(":scope > .app")).map((card) => {
            const r = card.getBoundingClientRect();
            return { bottom: Math.round(r.bottom), right: Math.round(r.right) };
          });
          return { cols, right: Math.round(apps.getBoundingClientRect().right), cards };
        });
        test.skip(grid.cols < 2, "una columna: no hay mosaico");
        // Control positivo: hay tarjetas que medir.
        expect(grid.cards.length).toBe(VISIBLE_APPS.length);
        const lastBottom = Math.max(...grid.cards.map((card) => card.bottom));
        const lastRow = grid.cards.filter((card) => card.bottom === lastBottom);
        expect(
          Math.max(...lastRow.map((card) => card.right)),
          "la última fila del mosaico deja una celda vacía a la derecha",
        ).toBe(grid.right);
      });

      test("no horizontal scroll", async ({ page: p }) => {
        await p.goto(page.path);
        const { scrollWidth, clientWidth } = await p.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(scrollWidth, "el documento desborda horizontalmente").toBeLessThanOrEqual(clientWidth);
      });

      test("no element overflows the viewport", async ({ page: p }) => {
        await p.goto(page.path);
        const offenders = await p.evaluate(() => {
          const w = document.documentElement.clientWidth;
          const bad: string[] = [];
          for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            if (r.right > w + 1 || r.left < -1) {
              bad.push(`${el.tagName.toLowerCase()}.${el.className || ""}`.slice(0, 60));
            }
          }
          return bad.slice(0, 10);
        });
        expect(offenders, "elementos fuera del viewport").toEqual([]);
      });

      test("key content is visible", async ({ page: p }) => {
        await p.goto(page.path);
        await expect(p.locator("h1")).toBeVisible();
        await expect(p.locator(".hero .btn.primary")).toBeVisible();
        await expect(p.locator(".apps .app")).toHaveCount(VISIBLE_APPS.length);
        await expect(p.locator(".contact .email")).toBeVisible();
        // Selector de idioma accesible en todos los anchos (cabecera y pie)
        const switchLinks = p.locator(`a[href="${page.lang === "es" ? "/en/" : "/"}"]`);
        expect(await switchLinks.count()).toBeGreaterThan(0);
        await expect(switchLinks.first()).toBeVisible();
      });

      test("text is readable: line length and font size", async ({ page: p }) => {
        await p.goto(page.path);
        // Control positivo: los logros de la trayectoria también entran en la medición.
        await expect(p.locator(".highlights li").first()).toBeVisible();
        const stats = await p.evaluate(() => {
          const paras = Array.from(
            document.querySelectorAll<HTMLElement>(".prose p, .desc, .summary, .text, .highlights li"),
          );
          return paras.map((el) => {
            const cs = getComputedStyle(el);
            return { fontSize: parseFloat(cs.fontSize), width: el.getBoundingClientRect().width };
          });
        });
        for (const s of stats) {
          expect(s.fontSize, "texto demasiado pequeño").toBeGreaterThanOrEqual(15);
          // ~ 0.5em por carácter: 80ch máximo
          expect(s.width / (s.fontSize * 0.5), "línea demasiado larga").toBeLessThanOrEqual(82);
        }
      });
    });
  }
}

test.describe("touch targets on mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  for (const page of PAGES) {
    test(`${page.path}: interactive elements are at least 44px tall or well spaced`, async ({ page: p }) => {
      await p.goto(page.path);
      const small = await p.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("a, button"))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          // Enlaces en línea dentro de texto se evalúan por su línea de 24px+ de alto
          const inline = getComputedStyle(el).display === "inline";
          const min = inline ? 24 : 44;
          if (r.height < min - 0.5) out.push(`${el.textContent?.trim().slice(0, 20)} (${Math.round(r.height)}px)`);
        }
        return out;
      });
      expect(small, "objetivos táctiles demasiado pequeños").toEqual([]);
    });
  }
});
