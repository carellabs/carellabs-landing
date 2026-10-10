/**
 * Marcas de contenido provisional que no pueden llegar a producción.
 *
 * Sin la bandera `i` a propósito: con ella `TODO` coincidiría con "todos", "todo" o
 * "método" (palabras normales del español), y la comprobación fallaría en cualquier texto.
 */
export const PLACEHOLDERS = /TU_USUARIO|lorem ipsum|\bTODO\b/;
