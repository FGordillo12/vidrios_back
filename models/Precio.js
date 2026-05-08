const mongoose = require('mongoose');

const precioSchema = new mongoose.Schema({
  tipo: { type: String, required: true },
  grosor: { type: String, required: true },
  valor: { type: Number, required: true }
});

module.exports = mongoose.model('PrecioVidrio', precioSchema, 'precios_vidrios');
