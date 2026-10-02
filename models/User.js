const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, minlength: 2, maxlength: 60 },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 254 },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ['admin', 'user'], default: 'user', index: true },
  active: { type: Boolean, default: true, index: true },
  approvalStatus: { type: String, enum: ['pending', 'approved', 'disabled'], default: 'approved', index: true },
  failedLoginAttempts: { type: Number, default: 0, select: false },
  lockUntil: { type: Date, default: null, select: false },
  createdAt: { type: Date, default: Date.now }
});

userSchema.pre('save', async function savePasswordHash() {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function comparePassword(candidatePassword) {
  const matches = await bcrypt.compare(candidatePassword, this.password);
  if (matches && bcrypt.getRounds(this.password) < 12) {
    this.password = candidatePassword;
    await this.save();
  }
  return matches;
};

module.exports = mongoose.model('User', userSchema);
