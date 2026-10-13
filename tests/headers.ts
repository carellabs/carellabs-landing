import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/** Un bloque de `public/_headers`: una ruta y las cabeceras que se le aplican. */
export type HeaderBlock = { path: string; headers: Record<string, string> };

/**
 * Lee `public/_headers` (formato de los assets estáticos de Cloudflare Workers): una línea sin sangría es una ruta; las
 * líneas con sangría debajo son sus cabeceras `Nombre: valor`. Los nombres van en minúsculas.
 */
export function readHeaders(file = "public/_headers"): HeaderBlock[] {
  const blocks: HeaderBlock[] = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      blocks.push({ path: raw.trim(), headers: {} });
      continue;
    }
    const current = blocks.at(-1);
    const sep = raw.indexOf(":");
    if (!current || sep < 0) throw new Error(`línea de _headers no reconocida: ${raw}`);
    const name = raw.slice(0, sep).trim().toLowerCase();
    if (name in current.headers) throw new Error(`cabecera repetida en ${current.path}: ${name}`);
    current.headers[name] = raw.slice(sep + 1).trim();
  }
  return blocks;
}

/** Cabeceras del bloque de una ruta; falla si la ruta no está en el fichero. */
export function headersFor(path: string): Record<string, string> {
  const block = readHeaders().find((b) => b.path === path);
  if (!block) throw new Error(`_headers no tiene un bloque para ${path}`);
  return block.headers;
}

/** La política CSP del sitio, tal como está en `public/_headers`. */
export function siteCsp(): string {
  const csp = headersFor("/*")["content-security-policy"];
  if (!csp) throw new Error("_headers no define Content-Security-Policy en /*");
  return csp;
}

/** Directivas de una CSP: `{ "img-src": ["'self'"], ... }`. */
export function parseCsp(csp: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives[name] = values;
  }
  return directives;
}

/** Lo que el navegador ha avisado al aplicar la CSP. */
export type CspReport = { violations: string[]; consoleErrors: string[] };

/**
 * Hace que las páginas de `page` se sirvan con la CSP del sitio. `astro preview` no lee
 * `_headers` (lo hace Cloudflare Workers), así que se añade a la respuesta del documento.
 * Devuelve el informe vivo: cada evento `securitypolicyviolation` y cada error de consola
 * de CSP se van apuntando. Llamar antes de `page.goto`.
 */
export async function enforceCsp(page: Page, csp: string): Promise<CspReport> {
  const report: CspReport = { violations: [], consoleErrors: [] };

  await page.exposeFunction("__reportCspViolation", (summary: string) => {
    report.violations.push(summary);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const report = (window as unknown as Record<string, (s: string) => void>).__reportCspViolation;
      report(`${event.violatedDirective} bloqueó ${event.blockedURI || "(en línea)"}`);
    });
  });
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|violates the following/i.test(message.text())) {
      report.consoleErrors.push(message.text());
    }
  });

  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
  });

  return report;
}
