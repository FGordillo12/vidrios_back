const mongoose = require('mongoose');

const connectionDb = async () => {
  try {
    const connectDb = await mongoose.connect("mongodb+srv://vidriosalejoseguridad_db_user:FOLou86nyuNu8Wd8@cluster0.uf6ruxb.mongodb.net/vidrios_alejo?appName=Cluster0");
    
    console.log(
      'Connection established',
      '\nnombre DB:', connectDb.connection.name
    );
  } catch (err) {
    console.log('Fallo en la conexion: ' + err);
  }
};
connectionDb();
module.exports = { connectionDb };