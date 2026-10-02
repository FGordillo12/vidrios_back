const iniciales = [];

function agregar(tipo, variante, grosores) {
  for (const grosorMm of grosores) iniciales.push({ tipo, variante, grosorMm, precioM2: 0, activo: true });
}

agregar('transparente', 'normal', ['4', '5', '6', '8', '10']);
agregar('transparente laminado', '3+3', ['6']);
agregar('transparente laminado', '4+4', ['8']);
agregar('verde', 'normal', ['4', '5', '6']);
agregar('gris', 'normal', ['4', '5', '6']);
agregar('azul', 'normal', ['4', '5', '6']);
agregar('azul', 'dark', ['4', '5', '6']);
agregar('azul', 'reflectivo', ['4', '5', '6']);
agregar('bronce', 'normal', ['5', '6']);
agregar('bronce', 'reflectivo', ['5', '6']);
agregar('grabado', '', ['4', '5', '6']);
agregar('espejo', '', ['3', '4', '5', '6']);

module.exports = iniciales;
