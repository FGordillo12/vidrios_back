require('./load-env')();
const { connectDb, mongoose } = require('./db');

async function checkConnection() {
  try {
    await connectDb();
    console.log('Conexión establecida. Base de datos:', mongoose.connection.name);
  } catch (error) {
    console.error('No se pudo conectar a MongoDB:', error.message);
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState) await mongoose.disconnect();
  }
}

checkConnection();
