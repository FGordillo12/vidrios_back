const mongoose = require('mongoose');
const schema = new mongoose.Schema({ key: { type: String, unique: true }, seq: { type: Number, default: 0 } });
module.exports = mongoose.model('Counter', schema);
