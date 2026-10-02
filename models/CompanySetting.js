const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'default' },
  nombre: { type: String, default: 'Vidrios Alejo SAS', maxlength: 100 },
  nit: { type: String, default: '901.452.128-4', maxlength: 40 },
  direccion: { type: String, default: 'Calle 12 #8-62, Ubaté - Cundinamarca', maxlength: 180 },
  telefono: { type: String, default: '+57 322 934 0900', maxlength: 80 },
  email: { type: String, default: 'contacto@vidriosalejo.com', maxlength: 254 },
  instagram: { type: String, default: '@vidrios_alejo_sas', maxlength: 80 },
  horario: { type: String, default: 'Lun – Sáb · 7:30 AM – 5:00 PM', maxlength: 100 },
  vigenciaDias: { type: Number, min: 1, max: 365, default: 15 },
  condicionesPago: { type: String, default: 'Se requiere un anticipo del 50% para iniciar la fabricación.', maxlength: 300 }
}, { timestamps: true });

module.exports = mongoose.model('CompanySetting', schema);
