# Vidrios Alejo

## Backend

1. Copiar `.env.example` como `.env`; configurar `MONGODB_URI`, `FRONTEND_URL`, un `JWT_SECRET` aleatorio de 32 bytes y una clave `ENC_KEY` aleatoria de 32 bytes en hexadecimal.
2. Ejecutar `npm install`.
3. Definir `ADMIN_USERNAME`, `ADMIN_EMAIL` y `ADMIN_PASSWORD` (mínimo 12 caracteres con mayúscula, minúscula, número y símbolo).
4. Ejecutar `npm run seed:admin` para crear/promover el administrador inicial.
5. Ejecutar `npm run seed:catalogo` para cargar las combinaciones base (precios en 0).
6. Ejecutar `npm run dev`.

Para el clúster mostrado en la captura, configurar en `.env` la URI con este formato: `mongodb+srv://vidriosalejoseguridad_db_user:<PASSWORD_URL_ENCODED>@cluster0.uf6ruxb.mongodb.net/vidrios_alejo?retryWrites=true&w=majority&appName=Cluster0`. Reemplazar el marcador por la contraseña del usuario de base de datos y codificar caracteres especiales de URL; habilitar la IP de desarrollo en Atlas → **Network Access**. No pegar credenciales en el frontend ni en el repositorio; `.env` está excluido por `.gitignore`. Reiniciar el backend después de cambiarlo. `GET /api/health` confirma tanto la API como la conexión a la base.

Las cotizaciones se guardan con consecutivo `COT-####`; los datos del cliente se cifran con `ENC_KEY` (64 caracteres hexadecimales, no se debe cambiar después de almacenar cotizaciones). El área mínima facturable por pieza parte de `MIN_M2` y puede ajustarse desde Catálogo de vidrios como administrador.

Desde Catálogo de vidrios también se editan los datos comerciales que se imprimen en el PDF (razón social, NIT, dirección, contacto, vigencia predeterminada y condiciones de pago). El historial permite a los usuarios consultar sus propias cotizaciones y al administrador actualizar su estado. Al enviar una cotización por correo, su estado pasa a `enviada`.

## Frontend

1. Ejecutar `npm install`.
2. Ejecutar `npm run dev`.
