import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://carellabs.com',
  integrations: [
    // `locales` mapea la carpeta de cada idioma a su código hreflang. Se usan los mismos
    // códigos que los <link rel="alternate" hreflang> del HTML (`es` y `en`).
    sitemap({ i18n: { defaultLocale: 'es', locales: { es: 'es', en: 'en' } } }),
  ],
  // La CSP es `style-src 'self'`: el CSS siempre va en archivos, nunca en <style> en línea.
  build: { inlineStylesheets: 'never' },
  i18n: {
    defaultLocale: 'es',
    locales: ['es', 'en'],
    routing: { prefixDefaultLocale: false },
  },
  vite: {
    build: {
      // Vite incrusta como `data:` los archivos pequeños y la CSP (`font-src 'self'`)
      // bloquearía esas fuentes. Los .woff2 siempre se emiten como archivo.
      assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
    },
  },
});
