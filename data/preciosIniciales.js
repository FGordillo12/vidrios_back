/**
 * Precios base por m² (COP). Normalizar tipos en minúsculas.
 * "azul" corregido respecto a valores de prueba (250/280); ajustar en BD si el negocio requiere otro precio.
 */
const PRECIOS_INICIALES = {
  transparente: { 4: 45000, 5: 65000, 6: 75000, 8: 0, 10: 0 },
  azul: { 4: 52000, 5: 68000 },
  'azul lake': { 4: 55000, 5: 70000 },
  'azul dark': { 4: 50000, 5: 68000 },
  'azul dark reflectivo': { 4: 53000, 5: 75000 },
  bronce: { 4: 0, 5: 0 },
  'bronce normal': { 4: 50000, 5: 68000 },
  'bronce reflectivo': { 4: 55000, 5: 75000 },
  verde: { 4: 0, 5: 0 },
  'verde automotriz': { 4: 52000, 5: 72000 },
  'verde botella': { 4: 53000, 5: 72000 },
  'verde botella reflectivo': { 4: 55000, 5: 75000 },
  gris: { 5: 68000 },
  grabado: { 4: 55000 },
  espejo: { 3: 55000, 4: 85000 },
  laminado: { '3+3': 85000, '4+4': 90000 }
};

function obtenerPrecioFallback(tipoNormalizado, grosor) {
  const porTipo = PRECIOS_INICIALES[tipoNormalizado];
  if (!porTipo) return null;
  const g = String(grosor).trim();
  const numKey = Number(g);
  if (Object.prototype.hasOwnProperty.call(porTipo, g)) return porTipo[g];
  if (!Number.isNaN(numKey) && Object.prototype.hasOwnProperty.call(porTipo, numKey)) {
    return porTipo[numKey];
  }
  return null;
}

module.exports = { PRECIOS_INICIALES, obtenerPrecioFallback };
