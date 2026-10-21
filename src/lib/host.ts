/**
 * La dirección que se enseña bajo el nombre de una app enlazada: el dominio y, si la hay, la ruta, sin la
 * barra final ("github.com/carellabs/carellabs-landing"; solo "finanzas.carellabs.com" si la ruta es "/").
 * Ni la búsqueda, ni el fragmento, ni el puerto forman parte de ella.
 *
 * @param url Una URL absoluta (la de `src/data/apps.json`).
 */
export function hostLine(url: string): string {
  const { hostname, pathname } = new URL(url);
  return hostname + pathname.replace(/\/+$/, "");
}
