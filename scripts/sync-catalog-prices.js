require('../load-env')();
const mongoose = require('mongoose');
const Glass = require('../models/Glass');
const Precio = require('../models/Precio');
const { mapLegacyPrice } = require('../lib/catalogPriceMap');

async function syncCatalogPrices() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI no está definida');
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false });

  const legacyPrices = await Precio.find().lean();
  const summary = { mode: apply ? 'apply' : 'preview', sourceRows: legacyPrices.length, catalogRows: await Glass.countDocuments(), imported: 0, wouldImport: 0, preserved: 0, zeroPrices: 0, unmapped: 0 };

  for (const price of legacyPrices) {
    const value = Number(price.valor);
    if (!Number.isFinite(value) || value <= 0) {
      summary.zeroPrices += 1;
      continue;
    }

    const key = mapLegacyPrice(price.tipo, price.grosor);
    if (!key) {
      summary.unmapped += 1;
      continue;
    }

    const current = await Glass.findOne(key);
    if (current && Number(current.precioM2) > 0) {
      summary.preserved += 1;
      continue;
    }

    summary.wouldImport += 1;
    if (!apply) continue;

    if (current) {
      current.precioM2 = value;
      await current.save();
    } else {
      await Glass.create({ ...key, precioM2: value, activo: true });
    }
    summary.imported += 1;
  }

  console.log(JSON.stringify(summary));
}

syncCatalogPrices()
  .catch((error) => {
    console.error('No se pudo sincronizar el catálogo:', error.name || 'Error', error.code || '');
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState) await mongoose.disconnect();
  });
