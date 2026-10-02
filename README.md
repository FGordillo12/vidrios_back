# Vidrios Alejo

## Backend

1. Copiar `.env.example` como `.env`; configurar `MONGODB_URI`, `FRONTEND_URL`, un `JWT_SECRET` aleatorio de 32 bytes y una clave `ENC_KEY` aleatoria de 32 bytes en hexadecimal.
2. Ejecutar `npm install`.
3. Definir `ADMIN_USERNAME`, `ADMIN_EMAIL` y `ADMIN_PASSWORD` (mínimo 12 caracteres con mayúscula, minúscula, número y símbolo).
4. Ejecutar `npm run seed:admin` para crear/promover el administrador inicial.
5. Ejecutar `npm run seed:catalogo` para cargar las combinaciones base (precios en 0).
6. Ejecutar `npm run dev`.

Las cotizaciones se guardan con consecutivo `COT-####`; los datos del cliente se cifran con `ENC_KEY` (64 caracteres hexadecimales, no se debe cambiar después de almacenar cotizaciones). El área mínima facturable por pieza parte de `MIN_M2` y puede ajustarse desde Catálogo de vidrios como administrador.

Desde Catálogo de vidrios también se editan los datos comerciales que se imprimen en el PDF (razón social, NIT, dirección, contacto, vigencia predeterminada y condiciones de pago). El historial permite a los usuarios consultar sus propias cotizaciones y al administrador actualizar su estado. Al enviar una cotización por correo, su estado pasa a `enviada`.

## Frontend

1. Ejecutar `npm install`.
2. Ejecutar `npm run dev`.
