require('../load-env')();
const mongoose = require('mongoose');
const User = require('../models/User');

async function seedAdmin() {
  const { MONGODB_URI, ADMIN_USERNAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!MONGODB_URI || !ADMIN_USERNAME || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('Configura MONGODB_URI, ADMIN_USERNAME, ADMIN_EMAIL y ADMIN_PASSWORD en .env');
  }
  if (ADMIN_PASSWORD.length < 12 || !/[a-z]/.test(ADMIN_PASSWORD) || !/[A-Z]/.test(ADMIN_PASSWORD) || !/[0-9]/.test(ADMIN_PASSWORD) || !/[^A-Za-z0-9]/.test(ADMIN_PASSWORD)) {
    throw new Error('ADMIN_PASSWORD debe tener 12 caracteres y combinar mayúsculas, minúsculas, números y símbolos');
  }

  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const email = ADMIN_EMAIL.trim().toLowerCase();
  const user = await User.findOne({ email }).select('+password');
  if (user) {
    user.role = 'admin';
    user.active = true;
    await user.save();
    console.log('Rol administrador asignado a la cuenta configurada.');
  } else {
    await User.create({ username: ADMIN_USERNAME.trim(), email, password: ADMIN_PASSWORD, role: 'admin', active: true });
    console.log('Cuenta administrador creada.');
  }
}

seedAdmin()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => mongoose.connection.readyState && mongoose.disconnect());
