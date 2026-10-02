const mongoose = require('mongoose');
const schema = new mongoose.Schema({ key: { type: String, unique: true }, minM2: { type: Number, min: 0, default: 0 } }, { timestamps: true });
module.exports = mongoose.model('QuoteSetting', schema);
