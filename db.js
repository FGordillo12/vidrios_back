require('./load-env')();
const mongoose = require('mongoose');
const mongooseOptions = {
  // Fail-fast para entornos serverless (Vercel) y evitar 504 por espera larga.
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 15000,
  retryWrites: true,
  w: 'majority'
};

let connectionPromise = null;
const isVercel = process.env.VERCEL === '1';

async function connectDb() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI no está definida');
  }
  if (!connectionPromise) {
    connectionPromise = mongoose
      .connect(process.env.MONGODB_URI, mongooseOptions)
      .then(async () => {
        const shouldAutoSeed = process.env.AUTO_SEED_PRECIOS === '1' || (!isVercel && process.env.AUTO_SEED_PRECIOS !== '0');
        if (shouldAutoSeed) {
          const Precio = require('./models/Precio');
          const { seedPreciosIniciales } = require('./lib/seedPrecios');
          const count = await Precio.countDocuments();
          if (count === 0) {
            await seedPreciosIniciales(Precio);
            console.log('Semilla automática: precios iniciales cargados (BD vacía)');
          }
        }
        return mongoose.connection;
      })
      .catch((err) => {
        connectionPromise = null;
        throw err;
      });
  }
  return connectionPromise;
}

module.exports = { connectDb, mongoose };
