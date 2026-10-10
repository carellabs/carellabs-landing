import { test, expect } from "@playwright/test";
import { VIEWPORTS, PAGES } from "./viewports";

for (const page of PAGES) {
  for (const vp of VIEWPORTS) {
    test.describe(`${page.path} @ ${vp.name} (${vp.width}px)`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

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
        await expect(p.locator(".apps .app")).toHaveCount(3);
        await expect(p.locator(".contact .email")).toBeVisible();
        // Selector de idioma accesible en todos los anchos (cabecera y pie)
        const switchLinks = p.locator(`a[href="${page.lang === "es" ? "/en/" : "/"}"]`);
        expect(await switchLinks.count()).toBeGreaterThan(0);
        await expect(switchLinks.first()).toBeVisible();
      });

      test("text is readable: line length and font size", async ({ page: p }) => {
        await p.goto(page.path);
        const stats = await p.evaluate(() => {
          const paras = Array.from(document.querySelectorAll<HTMLElement>(".prose p, .desc, .summary, .text"));
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
