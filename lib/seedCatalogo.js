const catalogoInicial = require('../data/catalogoInicial');

async function seedCatalogo(GlassModel) {
  const operations = catalogoInicial.map((item) => ({
    updateOne: {
      filter: { tipo: item.tipo, variante: item.variante, grosorMm: item.grosorMm },
      update: { $setOnInsert: item },
      upsert: true
    }
  }));
  return GlassModel.bulkWrite(operations, { ordered: false });
}

module.exports = { seedCatalogo };
