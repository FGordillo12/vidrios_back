const path = require('path');
const dotenv = require('dotenv');

let loaded = false;

function loadEnv() {
  if (loaded) return;
  loaded = true;

  // Prioriza backend/.env para evitar errores al ejecutar desde la raíz del proyecto.
  dotenv.config({ path: path.join(__dirname, '.env') });
  // Fallback: también intenta cargar .env desde el cwd si existe.
  dotenv.config();
}

module.exports = loadEnv;
