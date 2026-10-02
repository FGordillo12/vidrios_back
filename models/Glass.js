const mongoose = require('mongoose');

const glassSchema = new mongoose.Schema({
  tipo: { type: String, required: true, trim: true, lowercase: true, minlength: 2, maxlength: 60 },
  variante: { type: String, default: '', trim: true, lowercase: true, maxlength: 40 },
  grosorMm: { type: String, required: true, trim: true, match: /^(\d{1,2}|\d{1,2}\+\d{1,2})$/ },
  precioM2: { type: Number, required: true, default: 0, min: 0, max: 100000000 },
  activo: { type: Boolean, default: true, index: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

glassSchema.index({ tipo: 1, variante: 1, grosorMm: 1 }, { unique: true });
glassSchema.pre('save', function updateTimestamp() { this.updatedAt = new Date(); });
glassSchema.pre('findOneAndUpdate', function updateTimestamp() { this.set({ updatedAt: new Date() }); });

module.exports = mongoose.model('Glass', glassSchema);
