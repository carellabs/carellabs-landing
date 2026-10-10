# Política de seguridad

## Cómo reportar una vulnerabilidad

Usa el reporte privado de GitHub: pestaña **Security** del repositorio, botón **Report a vulnerability**. Solo lo ves tú y el propietario.

Si lo prefieres, escribe a **hola@carellabs.com** con el asunto "Seguridad: carellabs-landing". En ambos casos, incluye:

- qué has encontrado y dónde (URL o fichero),
- cómo reproducirlo,
- el impacto que crees que tiene.

**No abras una issue pública** para una vulnerabilidad: cualquiera la vería antes de que haya arreglo.

Responderé en cuanto pueda. Es un proyecto personal, sin SLA.

## Alcance

Este repositorio es una web estática (sin servidor, sin base de datos, sin cookies ni rastreadores). Lo más relevante es la cadena de dependencias, el CI y las cabeceras de seguridad de `public/_headers`.
