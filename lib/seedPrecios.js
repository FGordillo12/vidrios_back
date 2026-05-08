const { PRECIOS_INICIALES } = require('../data/preciosIniciales');

/**
 * Upserta todos los precios iniciales en la colección precios_vidrios (idempotente).
 */
async function seedPreciosIniciales(PrecioModel) {
  const ops = [];
  for (const tipo of Object.keys(PRECIOS_INICIALES)) {
    const tipoNormalizado = tipo.trim().toLowerCase();
    const porGrosor = PRECIOS_INICIALES[tipo];
    for (const grosorKey of Object.keys(porGrosor)) {
      const grosorNormalizado = String(grosorKey).trim();
      const valor = porGrosor[grosorKey];
      ops.push({
        updateOne: {
          filter: { tipo: tipoNormalizado, grosor: grosorNormalizado },
          update: { $set: { tipo: tipoNormalizado, grosor: grosorNormalizado, valor } },
          upsert: true
        }
      });
    }
  }
  if (ops.length === 0) return { upserted: 0 };
  const result = await PrecioModel.bulkWrite(ops);
  return result;
}

module.exports = { seedPreciosIniciales };
