// Medidas del icono para iOS, compartidas por scripts/icons/render.mjs y por el test que comprueba que
// el icono está al día (tests/seo.spec.ts): una sola definición.

// Lado del lienzo, en px: el apple-touch-icon que iOS espera.
export const SIZE = 180;
// Lado con el que se dibuja el favicon, en px: mayor que el lienzo (180 x 1,18), así que se centra y los bordes lo
// recortan. Lo que se recorta es el cuadrado redondeado oscuro que el favicon trae de fondo, del mismo color que el
// del icono, y la marca (que ocupa algo más de la mitad del favicon, 16 de sus 32 unidades) llena en torno al 60 %
// del lado. Par, para que el desplazamiento sea un número entero de px y los bordes salgan nítidos.
export const DRAW = 212;
