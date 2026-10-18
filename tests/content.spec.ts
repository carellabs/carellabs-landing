import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { HERO_FOCUS, PAGES } from "./viewports";
import { PLACEHOLDERS } from "./placeholders";
import { APPS, HIDDEN_APPS, VISIBLE_APPS, isLinked } from "./apps";
import { messagesOf } from "./messages";
import { hostLine } from "../src/lib/host";

test("apps.json: `hidden`, when present, is a boolean", () => {
  for (const app of APPS) {
    if ("hidden" in app) expect(typeof app.hidden, `${app.name}: hidden debe ser true o false`).toBe("boolean");
  }
});

test("apps.json: live and beta apps have an https url, and any url that is present is https", () => {
  // Control positivo: hay apps con enlace y apps sin él, para que el recorrido compruebe algo de cada.
  expect(APPS.some(isLinked), "ninguna app en beta o disponible").toBe(true);
  expect(APPS.some((app) => !isLinked(app)), "todas las apps están en beta o disponibles").toBe(true);
  for (const app of APPS) {
    if (isLinked(app)) expect(app.url, `${app.name}: en ${app.status} necesita url`).toBeTruthy();
    if (app.url === undefined) continue;
    expect(URL.canParse(app.url), `${app.name}: la url no es una URL`).toBe(true);
    expect(new URL(app.url).protocol, `${app.name}: la url tiene que ser https`).toBe("https:");
  }
});

test("hostLine: the host line is the hostname plus the path, without the trailing slash", () => {
  const cases: [string, string][] = [
    ["https://finanzas.carellabs.com", "finanzas.carellabs.com"],
    ["https://finanzas.carellabs.com/", "finanzas.carellabs.com"],
    ["https://github.com/carellabs/carellabs-landing", "github.com/carellabs/carellabs-landing"],
    ["https://github.com/carellabs/carellabs-landing/", "github.com/carellabs/carellabs-landing"],
    ["https://example.com//", "example.com"],
    // Ni la búsqueda, ni el fragmento, ni el puerto forman parte de la dirección que se enseña.
    ["https://github.com/carellabs/carellabs-landing?tab=readme#top", "github.com/carellabs/carellabs-landing"],
    ["https://localhost:8443/app/", "localhost/app"],
  ];
  for (const [url, expected] of cases) expect(hostLine(url), url).toBe(expected);
});

const GROUP_TITLES = {
  es: { software: "Desarrollo de software", before: "Antes del software" },
  en: { software: "Software development", before: "Before software" },
} as const;

const SKIP_LABEL = { es: "Saltar al contenido", en: "Skip to content" } as const;
const CURRENT_PERIOD = { es: "Nov 2023 - Actualidad", en: "Nov 2023 - Present" } as const;
const NAV_LABEL = { es: "Secciones", en: "Sections" } as const;

const SITE = "https://carellabs.com";
const CANONICAL = { es: `${SITE}/`, en: `${SITE}/en/` } as const;
/** Alternativas de idioma: el español es también el x-default. */
const ALTERNATES = { es: `${SITE}/`, en: `${SITE}/en/`, "x-default": `${SITE}/` } as const;

/** El titular (h1) de cada idioma, tal como está en src/i18n: así el test no fija el texto de marketing. */
const headline = (lang: "es" | "en"): string =>
  JSON.parse(readFileSync(`src/i18n/${lang}.json`, "utf8")).hero.headline;

test("Spanish page is in Spanish, English page is in English", async ({ page }) => {
  // Los dos titulares existen y son distintos: si no, el test no distinguiría un idioma del otro.
  expect(headline("es")).not.toBe(headline("en"));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.locator("h1")).toHaveText(headline("es"));
  await page.goto("/en/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("h1")).toHaveText(headline("en"));
});

// El selector está en la cabecera y en el pie: los dos tienen que llevar al otro idioma.
for (const where of [".nav", ".foot"]) {
  test(`language switch in ${where} goes to the exact URL of the other language`, async ({ page }) => {
    // `(url) => url.pathname === ...` y no una regex: `/\/$/` también casa con `/otra/ruta/`.
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await page.locator(`${where} a[lang='en']`).click();
    await expect(page).toHaveURL((url) => url.pathname === "/en/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    await page.locator(`${where} a[lang='es']`).click();
    await expect(page).toHaveURL((url) => url.pathname === "/");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
  });

  // El enlace lleva `lang` del idioma de destino, así que su nombre accesible va entero en ese idioma
  // (un lector de pantalla lo lee con esa voz): «English» o «Español», sin mezclar.
  test(`language switch in ${where} is announced as the target language, in that language`, async ({ page }) => {
    for (const [path, name, lang] of [
      ["/", "English", "en"],
      ["/en/", "Español", "es"],
    ]) {
      await page.goto(path);
      const link = page.locator(where).getByRole("link", { name, exact: true });
      await expect(link, `${path}: el selector de ${where} no se anuncia como «${name}»`).toHaveCount(1);
      await expect(link).toHaveAttribute("lang", lang);
      await expect(link).toHaveAttribute("hreflang", lang);
    }
  });
}

for (const pg of PAGES) {
  test(`${pg.path}: canonical and hreflang alternates have the exact values`, async ({ page }) => {
    await page.goto(pg.path);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", CANONICAL[pg.lang]);

    // Todas las alternativas, con su URL exacta: ni una de más ni una de menos.
    const alternates = await page
      .locator('link[rel="alternate"][hreflang]')
      .evaluateAll((links) => links.map((l) => [l.getAttribute("hreflang"), l.getAttribute("href")]));
    expect(alternates).toHaveLength(Object.keys(ALTERNATES).length);
    expect(Object.fromEntries(alternates)).toEqual(ALTERNATES);

    // La URL que se comparte coincide con la canónica.
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", CANONICAL[pg.lang]);
  });

  // Canario para 2027. El año del pie es el de la primera publicación (2026), no el de la construcción:
  // el mismo commit tiene que dar siempre el mismo HTML (prod-check lo compara byte a byte con producción).
  // OJO: mientras el año real sea 2026, este test no distingue un año escrito de uno calculado con la
  // fecha (pasaría igual). La guarda efectiva es la de .github/scripts/repo-config.test.mjs (nada de src/
  // lee la fecha); este test solo avisa, a partir del 1-1-2027, si el año vuelve a salir de la construcción.
  test(`${pg.path}: the footer carries the publication year (2026), not the build year`, async ({ page }) => {
    await page.goto(pg.path);
    await expect(page.locator(".foot")).toContainText(/© 2026 \S/);
  });

  test(`${pg.path}: description and social meta are present`, async ({ page }) => {
    await page.goto(pg.path);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /.{40,}/);
    await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  });

  test(`${pg.path}: the section navigation is labelled in the page language`, async ({ page }) => {
    await page.goto(pg.path);
    const nav = page.getByRole("navigation", { name: NAV_LABEL[pg.lang] });
    await expect(nav).toHaveCount(1);
    // Control positivo: es la única navegación y es la que lleva los enlaces de sección.
    await expect(page.getByRole("navigation")).toHaveCount(1);
    await expect(nav.locator('a[href="#perfil"]')).toHaveCount(1);
  });

  test(`${pg.path}: each app's stack list is labelled "Stack"`, async ({ page }) => {
    await page.goto(pg.path);
    await expect(page.getByRole("list", { name: "Stack" })).toHaveCount(VISIBLE_APPS.length);
  });

  test(`${pg.path}: og:image points to a PNG that the site serves`, async ({ page, request }) => {
    await page.goto(pg.path);
    const content = await page.locator('meta[property="og:image"]').getAttribute("content");
    expect(content, "no hay og:image").toBeTruthy();
    const url = new URL(content!);
    // La URL pública es la del dominio real; el fichero se pide al servidor de pruebas.
    expect(url.origin).toBe(SITE);
    const res = await request.get(url.pathname);
    expect(res.status(), `GET ${url.pathname}`).toBe(200);
    expect(res.headers()["content-type"], `GET ${url.pathname}`).toMatch(/^image\/png\b/);
  });

  test(`${pg.path}: internal anchors resolve to existing sections`, async ({ page }) => {
    await page.goto(pg.path);
    const hrefs = await page.locator('a[href^="#"]').evaluateAll((as) =>
      as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!)
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) {
      await expect(page.locator(h), `ancla rota: ${h}`).toHaveCount(1);
    }
  });

  test(`${pg.path}: no placeholders left in production`, async ({ page }) => {
    test.skip(!process.env.CI, "solo bloquea en CI; en local se permite trabajar con placeholders");
    await page.goto(pg.path);
    const html = await page.content();
    // Control positivo: se está mirando la página entera, no un documento vacío.
    expect(html).toContain("Fabrizio Carella");
    expect(html).not.toMatch(PLACEHOLDERS);
  });

  test(`${pg.path}: apps without a live status have no link`, async ({ page }) => {
    await page.goto(pg.path);
    const inProgress = page.locator('.app:has(.status[data-status="in-progress"]) .name a');
    await expect(inProgress).toHaveCount(0);
  });

  test(`${pg.path}: the cards follow apps.json; only live and beta ones are links with a host line`, async ({ page }) => {
    await page.goto(pg.path);
    const cards = page.locator("#lab .apps .app");
    // Controles positivos: hay tarjetas con y sin enlace, y el recuento es el de las apps no ocultas.
    expect(VISIBLE_APPS.some(isLinked), "ninguna app visible en beta o disponible").toBe(true);
    expect(VISIBLE_APPS.some((app) => !isLinked(app)), "todas las apps visibles enlazan").toBe(true);
    await expect(cards).toHaveCount(VISIBLE_APPS.length);

    for (const [i, app] of VISIBLE_APPS.entries()) {
      const card = cards.nth(i);
      await expect(card.locator(".name"), `tarjeta ${i + 1}: no es ${app.name}`).toHaveText(app.name);
      if (isLinked(app)) {
        await expect(card.locator(".name a"), `${app.name}: debe enlazar`).toHaveAttribute("href", app.url!);
        await expect(card.locator(".host"), `${app.name}: debe enseñar su dirección`).toHaveText(hostLine(app.url!));
      } else {
        await expect(card.locator(".name a"), `${app.name}: no debe enlazar`).toHaveCount(0);
        await expect(card.locator(".host"), `${app.name}: no debe enseñar una dirección que aún no existe`).toHaveCount(0);
      }
    }
    // Y no hay líneas de dirección de más en el laboratorio.
    await expect(page.locator("#lab .host")).toHaveCount(VISIBLE_APPS.filter(isLinked).length);
  });

  test(`${pg.path}: the carellabs.com card is the featured one, links to the repository and shows its path`, async ({ page }) => {
    await page.goto(pg.path);
    const app = APPS.find((a) => a.id === "carellabs");
    expect(app, "no hay una app con id «carellabs» en apps.json").toBeDefined();
    expect(VISIBLE_APPS[0], "carellabs.com tiene que ser la primera tarjeta").toBe(app);

    const card = page.locator("#lab .apps .app").first();
    const link = card.getByRole("link", { name: "carellabs.com" });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("href", "https://github.com/carellabs/carellabs-landing");
    await expect(card.locator(".host")).toHaveText("github.com/carellabs/carellabs-landing");
  });

  test(`${pg.path}: hidden apps are not shown, neither their name nor their hostname`, async ({ page }) => {
    await page.goto(pg.path);
    // Control positivo: el laboratorio está y muestra justo las apps visibles.
    await expect(page.locator("#lab .apps .app")).toHaveCount(VISIBLE_APPS.length);
    const html = await page.content();
    for (const app of HIDDEN_APPS) {
      expect(html, `${app.name} está oculta en apps.json y sigue en la página`).not.toContain(app.name);
      if (app.url) expect(html, `${app.name}: su dominio sigue en la página`).not.toContain(new URL(app.url).hostname);
    }
  });

  test(`${pg.path}: experience is split into two translated groups with one current job`, async ({ page }) => {
    await page.goto(pg.path);
    const order = await page
      .locator("#trayectoria [data-group]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-group")));
    expect(order).toEqual(["software", "before"]);

    for (const [group, jobs] of [["software", 4], ["before", 2]] as const) {
      const box = page.locator(`#trayectoria [data-group="${group}"]`);
      await expect(box.locator("h3")).toHaveText(GROUP_TITLES[pg.lang][group]);
      await expect(box.locator(".job")).toHaveCount(jobs);
    }

    await expect(page.locator("#trayectoria .job")).toHaveCount(6);
    await expect(page.locator("#trayectoria .now")).toHaveCount(1);
    const current = page.locator('#trayectoria [data-group="software"] .job.now');
    await expect(current).toHaveCount(1);
    await expect(current.locator(".company")).toHaveText("AMURA IT");
  });

  test(`${pg.path}: the stack is split into labelled groups, each list named after its group`, async ({ page }) => {
    await page.goto(pg.path);
    const { stackTitle, stackGroups } = messagesOf(pg.lang).about;
    // Controles positivos: hay más de un grupo, todos con fichas, y el encabezado del bloque está pintado.
    expect(stackGroups.length, "el stack no está dividido en grupos en i18n").toBeGreaterThan(1);
    const profile = page.locator("#perfil");
    await expect(profile.locator("dt").first()).toHaveText(stackTitle);

    for (const group of stackGroups) {
      expect(group.items.length, `${group.label}: grupo sin fichas en i18n`).toBeGreaterThan(0);
      // La etiqueta se ve y es el nombre accesible de su lista (lo que anuncia un lector de pantalla).
      await expect(profile.getByText(group.label, { exact: true })).toBeVisible();
      const list = profile.getByRole("list", { name: group.label, exact: true });
      await expect(list, `${group.label}: su lista no lleva ese nombre accesible`).toHaveCount(1);
      await expect(list.getByRole("listitem")).toHaveText(group.items);
    }
    // Ni una lista de fichas de más: la antigua lista plana ya no existe.
    await expect(profile.locator("ul.tokens")).toHaveCount(stackGroups.length);
  });

  test(`${pg.path}: only the jobs with highlights in src/i18n show a list of achievements`, async ({ page }) => {
    await page.goto(pg.path);
    const all = messagesOf(pg.lang).experience.items;
    const withList = all.filter((job) => job.highlights !== undefined);
    const withoutList = all.filter((job) => job.highlights === undefined);
    // Controles positivos: hay puestos con logros y sin ellos, y los de i18n coinciden con los pintados.
    expect(withList.length, "ningún puesto tiene `highlights` en i18n").toBeGreaterThan(0);
    expect(withoutList.length, "todos los puestos tienen `highlights` en i18n").toBeGreaterThan(0);
    await expect(page.locator("#trayectoria .job")).toHaveCount(all.length);

    const jobBox = (company: string) =>
      page.locator("#trayectoria .job").filter({ has: page.getByText(company, { exact: true }) });

    for (const job of withList) {
      const list = jobBox(job.company).locator("ul");
      await expect(list, `${job.company}: debe llevar una lista de logros`).toHaveCount(1);
      // El recuento y el texto de cada logro salen de i18n: sin cifras fijas en el test.
      await expect(list.locator("li")).toHaveText(job.highlights!);
    }
    for (const job of withoutList) {
      await expect(jobBox(job.company), `${job.company}: no se encuentra su puesto`).toHaveCount(1);
      await expect(jobBox(job.company).locator("ul, ol"), `${job.company}: no lleva logros`).toHaveCount(0);
    }
    // Y no hay ninguna lista de más en toda la trayectoria.
    await expect(page.locator("#trayectoria .job ul")).toHaveCount(withList.length);
  });

  test(`${pg.path}: no em or en dashes in the visible text`, async ({ page }) => {
    await page.goto(pg.path);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toMatch(/[—–]/);
    // Control positivo: el texto está pintado y los rangos de fechas usan guion.
    expect(text).toContain(CURRENT_PERIOD[pg.lang]);
  });

  test(`${pg.path}: hero specialties are a labelled list of three`, async ({ page }) => {
    await page.goto(pg.path);
    const list = page.getByRole("list", { name: HERO_FOCUS[pg.lang].label });
    await expect(list.getByRole("listitem")).toHaveText([...HERO_FOCUS[pg.lang].items]);
  });

  test(`${pg.path}: the skip link is the first tab stop and jumps to main`, async ({ page }) => {
    await page.goto(pg.path);
    const skip = page.locator(".skip");
    await expect(skip).not.toBeInViewport();
    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    await expect(skip).toHaveText(SKIP_LABEL[pg.lang]);
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
    await expect(page.locator("main#main")).toHaveCount(1);
  });
}

test("the placeholder detector flags real placeholders and ignores ordinary Spanish words", () => {
  // Corre siempre (el test de las páginas solo corre en CI): fija qué cuenta como placeholder.
  for (const text of ["https://github.com/TU_USUARIO", "lorem ipsum dolor", "TODO: escribir", "<!-- TODO -->"]) {
    expect(PLACEHOLDERS.test(text), text).toBe(true);
  }
  for (const text of [
    "todos los proyectos",
    "Todo el stack",
    "método",
    "Metodología",
    "todoterreno",
    "tengo todo listo",
    "TODOS LOS DERECHOS RESERVADOS",
  ]) {
    expect(PLACEHOLDERS.test(text), text).toBe(false);
  }
});

test("404 page exists and links home", async ({ page }) => {
  const res = await page.goto("/no-existe");
  expect(res?.status()).toBe(404);
  await expect(page.locator('a[href="/"]')).toHaveCount(1);
  await expect(page.locator("h1")).toHaveText("Esta página no existe.");
});

test("404 page texts: Spanish message, English line and English home link keep their own language", async ({ page }) => {
  await page.goto("/no-existe");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page).toHaveTitle("404 · Carellabs");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", "Página no encontrada");
  await expect(page.getByRole("link", { name: "Volver al inicio" })).toHaveAttribute("href", "/");
  await expect(page.locator('p[lang="en"]')).toHaveText("This page doesn't exist.");
  const english = page.getByRole("link", { name: "Back to home", exact: true });
  await expect(english).toHaveAttribute("href", "/en/");
  await expect(english).toHaveAttribute("lang", "en");
  await expect(english).toHaveAttribute("hreflang", "en");
});

test("404 page is not indexable: noindex, and no canonical, hreflang, og:* or twitter:* tags", async ({ page }) => {
  // Control positivo: estos mismos selectores sí encuentran las etiquetas en una página real.
  await page.goto("/");
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
  await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(3);
  expect(await page.locator('meta[property^="og:"]').count()).toBeGreaterThan(3);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveCount(1);
  // Los metadatos para redes más recientes también están en la página real (y no en la 404, abajo).
  await expect(page.locator('meta[name="twitter:image"]')).toHaveCount(1);
  await expect(page.locator('meta[name="twitter:image:alt"]')).toHaveCount(1);
  await expect(page.locator('meta[property="og:site_name"]')).toHaveCount(1);
  await expect(page.locator('meta[property="og:locale:alternate"]')).toHaveCount(1);
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveCount(1);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);

  const res = await page.goto("/no-existe");
  expect(res?.status()).toBe(404);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  await expect(page.locator('meta[name="robots"]')).toHaveCount(1);
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(0);
  await expect(page.locator('meta[property^="og:"]')).toHaveCount(0);
  await expect(page.locator('meta[name^="twitter:"]')).toHaveCount(0);
  await expect(page.locator('meta[property="og:site_name"]')).toHaveCount(0);
  await expect(page.locator('meta[property="og:locale:alternate"]')).toHaveCount(0);
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveCount(0);
});

// La CSP no permite estilos en línea (`style-src 'self'`): ninguna página puede depender de ellos.
for (const path of ["/", "/en/", "/no-existe"]) {
  test(`${path}: no inline styles (CSP style-src 'self')`, async ({ page }) => {
    await page.goto(path);
    const inline = await page.evaluate(() => ({
      styleTags: document.querySelectorAll("style").length,
      styleAttrs: Array.from(document.querySelectorAll("[style]")).map((el) => el.tagName),
    }));
    expect(inline).toEqual({ styleTags: 0, styleAttrs: [] });
  });
}

test("favicon uses the current palette and carries no embedded metadata", () => {
  const svg = readFileSync("public/favicon.svg", "utf8");
  expect(svg).not.toMatch(/<metadata|c2pa/i);
  expect(svg).not.toMatch(/#fafaf7|#c0392b/i);
  expect(svg).toMatch(/#0e0f11/i);
  expect(svg).toMatch(/#f2b13a/i);
});
