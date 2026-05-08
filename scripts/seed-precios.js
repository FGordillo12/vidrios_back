require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const mongoose = require('mongoose');
const { seedPreciosIniciales } = require('../lib/seedPrecios');
const Precio = require('../models/Precio');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI no está definida');
  process.exit(1);
}

mongoose
  .connect(uri, { serverSelectionTimeoutMS: 10000 })
  .then(async () => {
    console.log('Conectado a MongoDB');
    const r = await seedPreciosIniciales(Precio);
    console.log('Semilla de precios completada:', r);
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
