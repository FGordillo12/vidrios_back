require('../load-env')();
const mongoose = require('mongoose');
const Glass = require('../models/Glass');
const { seedCatalogo } = require('../lib/seedCatalogo');

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI no está definida');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const result = await seedCatalogo(Glass);
  console.log(`Catálogo inicial procesado: ${result.upsertedCount || 0} combinaciones nuevas.`);
}

run()
  .catch((error) => {
    console.error('No se pudo cargar el catálogo inicial:', error.name || 'Error');
    process.exitCode = 1;
  })
  .finally(async () => { if (mongoose.connection.readyState) await mongoose.disconnect(); });
