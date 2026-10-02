const mongoose = require('mongoose');

const quoteSchema = new mongoose.Schema({
  consecutivo: { type: String, required: true, unique: true, index: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  customer: {
    nombre: { type: String, required: true }, documento: String, telefono: String,
    email: String, direccion: String, ciudad: String
  },
  company: { type: mongoose.Schema.Types.Mixed, default: {} },
  items: { type: [mongoose.Schema.Types.Mixed], required: true },
  total: { type: Number, required: true, min: 0 },
  vigenciaDias: { type: Number, default: 15 },
  formaPago: { type: String, default: '' },
  observaciones: { type: String, default: '' },
  estado: { type: String, enum: ['borrador', 'enviada', 'aprobada', 'rechazada'], default: 'borrador', index: true },
  historial: [{ estado: String, usuario: mongoose.Schema.Types.ObjectId, fecha: { type: Date, default: Date.now }, nota: String }]
}, { timestamps: true });

module.exports = mongoose.model('Quote', quoteSchema);
