import { test, expect, type Locator } from "@playwright/test";
import { HERO_FOCUS, PAGES } from "./viewports";

/** Estilo y grosor del contorno de foco que calcula el navegador. */
const outlineOf = (el: Locator) =>
  el.evaluate((node) => {
    const cs = getComputedStyle(node);
    return { style: cs.outlineStyle, width: cs.outlineWidth };
  });

for (const pg of PAGES) {
  test(`${pg.path}: the skip link moves focus into main (Safari needs tabindex="-1")`, async ({ page }) => {
    await page.goto(pg.path);
    const main = page.locator("main#main");
    await expect(main).toHaveAttribute("tabindex", "-1");
    // Control positivo: antes de usar el enlace, el foco no está en main.
    await expect(main).not.toBeFocused();

    await page.keyboard.press("Tab");
    await expect(page.locator(".skip")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(main).toBeFocused();
  });

  test(`${pg.path}: focus rings stay visible on links but not around the whole of main`, async ({ page }) => {
    await page.goto(pg.path);
    const main = page.locator("main#main");

    await page.keyboard.press("Tab");
    await expect(page.locator(".skip")).toBeFocused();
    expect(await outlineOf(page.locator(".skip")), ":focus-visible del enlace").toEqual({ style: "solid", width: "2px" });

    await page.keyboard.press("Enter");
    await expect(main).toBeFocused();
    expect((await outlineOf(main)).style, "anillo de foco alrededor de todo main").toBe("none");

    // El resto de la página no pierde su anillo: el siguiente Tab cae en el primer enlace de main.
    await page.keyboard.press("Tab");
    const first = page.locator("main a").first();
    await expect(first).toBeFocused();
    expect(await outlineOf(first), ":focus-visible del primer enlace").toEqual({ style: "solid", width: "2px" });
  });

  test(`${pg.path}: every list keeps its list semantics (role="list", because list-style is none)`, async ({ page }) => {
    await page.goto(pg.path);
    const lists = await page.locator("ul, ol").evaluateAll((els) =>
      els.map((el) => ({
        name: `${el.tagName.toLowerCase()}.${el.className}`,
        role: el.getAttribute("role"),
        marker: getComputedStyle(el).listStyleType,
      })),
    );
    // Control positivo: hay listas (apps, tokens, raíl, especialidades, idiomas, formación...) y
    // todas pierden el marcador, que es lo que hace que Safari/VoiceOver las deje de anunciar.
    expect(lists.length).toBeGreaterThanOrEqual(10);
    expect(lists.filter((l) => l.marker !== "none")).toEqual([]);
    expect(lists.filter((l) => l.role !== "list").map((l) => l.name)).toEqual([]);
  });

  test(`${pg.path}: the decorative "/" between the specialties is not read out`, async ({ page }) => {
    await page.goto(pg.path);
    const list = page.getByRole("list", { name: HERO_FOCUS[pg.lang].label });
    const items = HERO_FOCUS[pg.lang].items;

    // Control positivo: el separador se pinta de verdad (si no, esto no probaría nada).
    const generated = await list
      .getByRole("listitem")
      .nth(1)
      .evaluate((el) => getComputedStyle(el, "::before").content);
    expect(generated).toContain("/");

    // Lo que anuncia un lector de pantalla: solo las especialidades, sin la barra.
    const snapshot = (await list.ariaSnapshot()).trim();
    const expected = [
      `- list "${HERO_FOCUS[pg.lang].label}":`,
      ...items.map((item) => `  - listitem: ${item}`),
    ].join("\n");
    expect(snapshot).toBe(expected);
  });
}
