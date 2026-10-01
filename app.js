require('./load-env')();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { connectDb } = require('./db');
const User = require('./models/User');
const Precio = require('./models/Precio');
const PasswordResetToken = require('./models/PasswordResetToken');
const RefreshToken = require('./models/RefreshToken');
const { obtenerPrecioFallback } = require('./data/preciosIniciales');

const app = express();
const isVercel = process.env.VERCEL === '1';
const isProduction = process.env.NODE_ENV === 'production';
const accessCookie = 'va_access';
const refreshCookie = 'va_refresh';
const csrfCookie = 'va_csrf';
const accessTtlMs = 15 * 60 * 1000;
const refreshTtlMs = 7 * 24 * 60 * 60 * 1000;

if (isVercel) app.set('trust proxy', 1);

const corsOptions = {
  origin: [process.env.FRONTEND_URL, 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:5173', 'https://vidriosalejo.vercel.app'].filter(Boolean),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'], 
  allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
  credentials: true
};
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https:', 'http://localhost:3000'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false
}));
app.use((req, res, next) => {
  if (isProduction && req.get('x-forwarded-proto') && req.get('x-forwarded-proto') !== 'https') {
    return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
  }
  next();
});
app.use(cors(corsOptions));
// La generación de PDF (base64) puede ser grande para cotizaciones con muchos ítems.
// Ajustamos el límite para permitir adjuntar el PDF en el envío por correo.
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  [req.body, req.params, req.headers].forEach((value) => {
    if (value && typeof value === 'object') mongoSanitize.sanitize(value);
  });
  const query = req.query;
  if (query && typeof query === 'object') {
    mongoSanitize.sanitize(query);
    Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true });
  }
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Demasiados intentos. Inténtalo de nuevo en unos minutos.' } });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api', apiLimiter);

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use((req, res, next) => {
  if (!unsafeMethods.has(req.method) || (!req.cookies[accessCookie] && !req.cookies[refreshCookie])) return next();
  const cookieToken = req.cookies[csrfCookie];
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken || cookieToken.length !== headerToken.length || !crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))) {
    return res.status(403).json({ error: 'Validación CSRF fallida' });
  }
  next();
});

app.get('/', (req, res) => {
  res.json({message: "El servidor de vidrios está funcionando"});
});

// Health endpoint: responde sin depender de la base de datos.
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

async function ensureDbConnection(req, res, next) {
  try {
    await Promise.race([
      connectDb(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('DB connect timeout')), 8000);
      })
    ]);
    next();
  } catch (err) {
    console.error('DB connection error:', err.name || 'Error');
    res.status(503).json({ error: 'Servicio temporalmente no disponible' });
  }
}

app.use('/api', ensureDbConnection);
app.use('/cotizar', ensureDbConnection);

// Logging (sin datos sensibles)
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`${req.method} ${req.url}`);
  }
  next();
});

if (!isVercel) {
  app.get('/', (req, res) => {
    res.json({ ok: true, service: 'SistemaVidriosBack' });
  });
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || '';
  if (secret.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres');
  return secret;
}

const passwordSchema = z.string().min(12).max(128)
  .regex(/[a-z]/, 'Incluye una letra minúscula')
  .regex(/[A-Z]/, 'Incluye una letra mayúscula')
  .regex(/[0-9]/, 'Incluye un número')
  .regex(/[^A-Za-z0-9]/, 'Incluye un símbolo');

const emailSchema = z.string().trim().email().max(254).transform((email) => email.toLowerCase());

function cookieOptions(maxAge, httpOnly = true) {
  return { httpOnly, secure: isProduction, sameSite: 'strict', path: '/', maxAge };
}

function setCsrfCookie(res, token = crypto.randomBytes(32).toString('hex')) {
  res.cookie(csrfCookie, token, cookieOptions(refreshTtlMs, false));
}

async function createSession(user, res) {
  const access = jwt.sign({ sub: user._id.toString() }, getJwtSecret(), { expiresIn: '15m', issuer: 'vidrios-alejo' });
  const refresh = crypto.randomBytes(48).toString('base64url');
  await RefreshToken.create({ userId: user._id, tokenHash: crypto.createHash('sha256').update(refresh).digest('hex'), expiresAt: new Date(Date.now() + refreshTtlMs) });
  res.cookie(accessCookie, access, cookieOptions(accessTtlMs));
  res.cookie(refreshCookie, refresh, cookieOptions(refreshTtlMs));
  setCsrfCookie(res);
}

function clearSessionCookies(res) {
  for (const name of [accessCookie, refreshCookie, csrfCookie]) res.clearCookie(name, { httpOnly: name !== csrfCookie, secure: isProduction, sameSite: 'strict', path: '/' });
}

async function authenticateToken(req, res, next) {
  const token = req.cookies[accessCookie];
  if (!token) return res.status(401).json({ error: 'Inicia sesión para continuar' });
  try {
    const payload = jwt.verify(token, getJwtSecret(), { issuer: 'vidrios-alejo' });
    const user = await User.findById(payload.sub).select('username email role active');
    if (!user || !user.active) {
      clearSessionCookies(res);
      return res.status(401).json({ error: 'La sesión no está disponible' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => req.user && roles.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: 'No tienes permisos para realizar esta acción' });
}

function getMailTransporter() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

function formatCop(valor) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0
  }).format(valor);
}

/* ========== AUTENTICACIÓN ========== */
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const input = z.object({
      username: z.string().trim().min(2).max(60).regex(/^[\p{L}\p{N}._ -]+$/u),
      email: emailSchema,
      password: passwordSchema
    }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: input.error.issues[0]?.message || 'Datos de registro inválidos' });
    const { username, email, password } = input.data;
    const existingUser = await User.findOne({ $or: [{ username: { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }, { email }] });
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario o email ya está registrado' });
    }

    const newUser = new User({ username, email, password, role: 'user' });
    await newUser.save();
    await createSession(newUser, res);

    res.status(201).json({
      message: 'Usuario registrado exitosamente',
      username: newUser.username,
      role: newUser.role,
      redirect: '/index.html'
    });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'El usuario o email ya está registrado' });
    console.error('Error en el registro:', error.name || 'Error');
    res.status(500).json({ error: 'No se pudo completar el registro' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const input = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Correo o contraseña inválidos' });
    const { email, password } = input.data;
    const user = await User.findOne({ email }).select('+password +failedLoginAttempts +lockUntil');
    if (!user || !user.active) return res.status(401).json({ error: 'Credenciales inválidas' });
    if (user.lockUntil && user.lockUntil > new Date()) return res.status(429).json({ error: 'Cuenta bloqueada temporalmente por intentos fallidos' });
    if (!(await user.comparePassword(password))) {
      const attempts = user.lockUntil && user.lockUntil <= new Date() ? 1 : user.failedLoginAttempts + 1;
      await User.updateOne({ _id: user._id }, { $set: { failedLoginAttempts: attempts, lockUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null } });
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    await User.updateOne({ _id: user._id }, { $set: { failedLoginAttempts: 0, lockUntil: null } });
    await createSession(user, res);
    res.json({
      username: user.username,
      role: user.role,
      redirect: '/index.html'
    });
  } catch (error) {
    console.error('Error en el login:', error.name || 'Error');
    res.status(500).json({ error: 'No se pudo iniciar sesión' });
  }
});

app.get('/api/me', authenticateToken, async (req, res) => {
  res.json({ id: req.user._id, username: req.user.username, email: req.user.email, role: req.user.role });
});

app.post('/api/refresh', async (req, res) => {
  const refresh = req.cookies[refreshCookie];
  if (!refresh) return res.status(401).json({ error: 'La sesión expiró' });
  const tokenHash = crypto.createHash('sha256').update(refresh).digest('hex');
  try {
    const saved = await RefreshToken.findOne({ tokenHash, expiresAt: { $gt: new Date() } });
    if (!saved) {
      clearSessionCookies(res);
      return res.status(401).json({ error: 'La sesión expiró' });
    }
    const user = await User.findById(saved.userId).select('username email role active');
    await RefreshToken.deleteOne({ _id: saved._id });
    if (!user || !user.active) {
      clearSessionCookies(res);
      return res.status(401).json({ error: 'La cuenta no está disponible' });
    }
    await createSession(user, res);
    res.json({ message: 'Sesión renovada' });
  } catch (error) {
    console.error('Error al renovar sesión:', error.name || 'Error');
    res.status(500).json({ error: 'No se pudo renovar la sesión' });
  }
});

app.post('/api/logout', async (req, res) => {
  const refresh = req.cookies[refreshCookie];
  if (refresh) await RefreshToken.deleteOne({ tokenHash: crypto.createHash('sha256').update(refresh).digest('hex') });
  clearSessionCookies(res);
  res.json({ message: 'Sesión cerrada' });
});

app.get('/api/admin/users', authenticateToken, requireRole('admin'), async (req, res) => {
  const users = await User.find().select('username email role active createdAt').sort({ createdAt: -1 }).lean();
  res.json(users);
});

app.patch('/api/admin/users/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  const userId = z.string().regex(/^[a-f\d]{24}$/i).safeParse(req.params.id);
  if (!userId.success) return res.status(400).json({ error: 'Identificador de usuario inválido' });
  const input = z.object({ role: z.enum(['admin', 'user']).optional(), active: z.boolean().optional() }).strict().safeParse(req.body);
  if (!input.success || Object.keys(input.data || {}).length === 0) return res.status(400).json({ error: 'Cambios de usuario inválidos' });
  if (userId.data === req.user._id.toString() && (input.data.active === false || input.data.role === 'user')) return res.status(400).json({ error: 'No puedes quitarte el acceso de administrador a ti mismo' });
  try {
    const user = await User.findByIdAndUpdate(userId.data, { $set: input.data }, { new: true, runValidators: true }).select('username email role active createdAt');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (input.data.active === false || input.data.role === 'user') await RefreshToken.deleteMany({ userId: user._id });
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: 'No se pudieron guardar los cambios del usuario' });
  }
});

/* ========== COTIZACIÓN ========== */
function parseBoolCotizacion(val) {
  if (val === true || val === 1) return true;
  if (val === false || val === 0) return false;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'on' || s === 'yes' || s === 'si' || s === 'sí') return true;
    if (s === 'false' || s === '0' || s === '' || s === 'no') return false;
  }
  return false;
}

async function handleCotizar(req, res) {
  let {
    tipo,
    ancho,
    alto,
    cantidad,
    grosor,
    vidrioPulido,
    vidrioSandblasteado,
    sandblastValor
  } = req.body;

  tipo = (tipo || '').trim().toLowerCase();
  ancho = parseFloat(ancho);
  alto = parseFloat(alto);
  cantidad = parseInt(cantidad, 10);

  const pulido = parseBoolCotizacion(vidrioPulido);
  const sandblast = parseBoolCotizacion(vidrioSandblasteado);
  const sandblastNum = Math.max(0, parseFloat(sandblastValor) || 0);

  if (!tipo || Number.isNaN(ancho) || Number.isNaN(alto) || Number.isNaN(cantidad) || grosor === undefined) {
    return res.status(400).json({ error: 'Faltan datos o datos inválidos' });
  }

  if (sandblast && sandblastNum <= 0) {
    return res.status(400).json({ error: 'Indique el valor adicional del sandblast (COP) para este ítem' });
  }

  try {
    const grosorStr = String(grosor).trim();
    let precioDoc = await Precio.findOne({ tipo, grosor: grosorStr });
    let precioUnit;

    if (precioDoc) {
      precioUnit = precioDoc.valor;
    } else {
      const fallback = obtenerPrecioFallback(tipo, grosorStr);
      if (fallback === null || fallback === undefined) {
        return res.status(400).json({ error: `No se encontró precio para ${tipo} con grosor ${grosor}` });
      }
      precioUnit = fallback;
    }

    const area = ancho * alto;
    const totalVidrio = area * precioUnit * cantidad;

    const precioPulidoM2 = Number(process.env.PRECIO_PULIDO_COP_M2 || 15000);
    const pulidoExtra = pulido ? area * cantidad * precioPulidoM2 : 0;
    const sandblastExtra = sandblast ? sandblastNum : 0;

    const total = totalVidrio + pulidoExtra + sandblastExtra;

    res.json({
      total,
      area,
      tipo,
      grosor,
      precio: precioUnit,
      totalVidrio,
      pulidoExtra,
      sandblastExtra,
      vidrioPulido: pulido,
      vidrioSandblasteado: sandblast
    });
  } catch (error) {
    console.error('Error al cotizar:', error.name || 'Error');
    res.status(500).json({ error: 'Error al calcular la cotización' });
  }
}

app.post('/cotizar', authenticateToken, handleCotizar);
app.post('/api/cotizar', authenticateToken, handleCotizar);

app.post('/api/editar-precios', authenticateToken, requireRole('admin'), async (req, res) => {
  const parsed = z.record(z.string(), z.record(z.string(), z.number().finite().min(0).max(100000000))).safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data || {}).length === 0) return res.status(400).json({ error: 'El formato o los precios enviados no son válidos' });
  const nuevosPrecios = parsed.data;

  try {
    for (const tipo in nuevosPrecios) {
      for (const grosor in nuevosPrecios[tipo]) {
        const valor = nuevosPrecios[tipo][grosor];
        const tipoNormalizado = tipo.trim().toLowerCase();
        const grosorNormalizado = grosor.toString().trim();

        await Precio.findOneAndUpdate(
          { tipo: tipoNormalizado, grosor: grosorNormalizado },
          { valor, tipo: tipoNormalizado, grosor: grosorNormalizado },
          { upsert: true, new: true }
        );
      }
    }

    res.json({ message: 'Precios actualizados correctamente' });
  } catch (error) {
    console.error('Error al actualizar precios:', error.name || 'Error');
    res.status(500).json({ error: 'Error al guardar precios en la base de datos' });
  }
});

app.get('/api/precios', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const precios = await Precio.find();
    res.json(precios);
  } catch (error) {
    console.error('Error al obtener precios:', error.name || 'Error');
    res.status(500).json({ error: 'Error al obtener precios' });
  }
});

app.get('/api/obtener-precios', authenticateToken, async (req, res) => {
  try {
    const precios = await Precio.find({});
    const preciosFormateados = {};

    precios.forEach((p) => {
      if (!preciosFormateados[p.tipo]) preciosFormateados[p.tipo] = {};
      preciosFormateados[p.tipo][p.grosor] = p.valor;
    });

    res.json(preciosFormateados);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener precios' });
  }
});

function cotizacionesHtmlTable(cotizaciones, total) {
  const rows = cotizaciones
    .map((item) => {
      const partesAcabado = [];
      if (item.vidrioPulido) partesAcabado.push(`Pulido +${formatCop(Number(item.pulidoExtra) || 0)}`);
      if (item.vidrioSandblasteado) partesAcabado.push(`Sandblast +${formatCop(Number(item.sandblastExtra) || 0)}`);
      const acabados = partesAcabado.length ? partesAcabado.join(' · ') : '—';

      return `
    <tr>
      <td style="padding:8px;border:1px solid #ccc;">${escapeHtml(String(item.tipo || ''))}<br><span style="font-size:11px;color:#555;">${escapeHtml(acabados)}</span></td>
      <td style="padding:8px;border:1px solid #ccc;">${escapeHtml(String(item.grosor || ''))} mm</td>
      <td style="padding:8px;border:1px solid #ccc;">${escapeHtml(String(item.anchoOriginal ?? item.ancho))}m × ${escapeHtml(String(item.altoOriginal ?? item.alto))}m</td>
      <td style="padding:8px;border:1px solid #ccc;text-align:center;">${escapeHtml(String(item.cantidad))}</td>
      <td style="padding:8px;border:1px solid #ccc;text-align:right;">${formatCop(item.total)}</td>
    </tr>`;
    })
    .join('');
  return `
  <table style="border-collapse:collapse;width:100%;max-width:640px;font-family:Arial,sans-serif;">
    <thead>
      <tr style="background:#2c3e50;color:#fff;">
        <th style="padding:8px;border:1px solid #2c3e50;">Tipo</th>
        <th style="padding:8px;border:1px solid #2c3e50;">Grosor</th>
        <th style="padding:8px;border:1px solid #2c3e50;">Medidas</th>
        <th style="padding:8px;border:1px solid #2c3e50;">Cant.</th>
        <th style="padding:8px;border:1px solid #2c3e50;">Subtotal</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td colspan="4" style="padding:8px;border:1px solid #ccc;text-align:right;font-weight:bold;">Total</td>
        <td style="padding:8px;border:1px solid #ccc;text-align:right;font-weight:bold;">${formatCop(total)}</td>
      </tr>
    </tfoot>
  </table>`;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.post('/api/enviar-cotizacion', authenticateToken, async (req, res) => {
  try {
    const { contacto, cotizaciones, pdfBase64, pdfFilename, cliente } = req.body;
    if (!contacto || typeof contacto !== 'string' || contacto.length > 120) {
      return res.status(400).json({ error: 'Contacto inválido' });
    }
    if (!Array.isArray(cotizaciones) || cotizaciones.length === 0 || cotizaciones.length > 80) {
      return res.status(400).json({ error: 'Lista de cotizaciones inválida' });
    }

    const transporter = getMailTransporter();
    if (!transporter) {
      return res.status(503).json({ error: 'Envío de correo no configurado en el servidor' });
    }

    const total = cotizaciones.reduce((acc, c) => acc + (Number(c.total) || 0), 0);
    const toEmail = contacto.includes('@') ? contacto.trim() : process.env.EMAIL_USER;
    if (!toEmail || !toEmail.includes('@')) {
      return res.status(400).json({ error: 'Se requiere un correo electrónico válido para enviar' });
    }

    const clienteNombre = escapeHtml(String(cliente?.nombre || '').trim());
    const solicitadoPor = clienteNombre || 'Cliente sin nombre registrado';

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;background:#f4f7fb;padding:24px;color:#1f2d3d;">
        <div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #dfe7f2;border-radius:10px;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#1f3f68,#2d6bb5);padding:22px 24px;color:#fff;">
            <h2 style="margin:0 0 6px 0;font-size:22px;">Cotización Comercial - Vidrios Alejo SAS</h2>
            <p style="margin:0;font-size:13px;opacity:.95;">Calidad y transparencia para sus proyectos en vidrio y aluminio.</p>
          </div>

          <div style="padding:22px 24px;">
            <p style="margin:0 0 12px 0;">Estimado(a),</p>
            <p style="margin:0 0 12px 0;line-height:1.6;">
              Reciba un cordial saludo de parte de <strong>Vidrios Alejo SAS</strong>. 
              Compartimos la cotización solicitada, generada en nuestro sistema comercial.
            </p>
            <p style="margin:0 0 12px 0;line-height:1.6;">
              En este correo encontrará el resumen en tabla y, adicionalmente, el documento adjunto en formato PDF para su revisión y archivo.
            </p>

            <div style="background:#f8fbff;border:1px solid #d9e7fb;border-radius:8px;padding:12px 14px;margin:16px 0;">
              <p style="margin:0 0 6px 0;font-size:13px;"><strong>Solicitado por:</strong> ${solicitadoPor}</p>
              <p style="margin:0;font-size:13px;"><strong>Contacto registrado:</strong> ${escapeHtml(contacto.trim())}</p>
            </div>

            ${cotizacionesHtmlTable(cotizaciones, total)}

            <p style="margin:16px 0 0 0;line-height:1.6;">
              Para confirmar, ajustar o resolver cualquier inquietud sobre esta cotización, estaremos atentos a su mensaje.
            </p>
            <p style="margin:16px 0 0 0;">Cordialmente,</p>
            <p style="margin:6px 0 0 0;"><strong>Equipo Comercial</strong><br/>Vidrios Alejo SAS</p>
          </div>

          <div style="background:#f0f4fa;border-top:1px solid #dfe7f2;padding:12px 24px;font-size:12px;color:#4f6075;">
            Este correo fue generado automáticamente por el sistema de cotizaciones de Vidrios Alejo SAS.
          </div>
        </div>
      </div>
    `;

    const attachments = [];
    if (pdfBase64 && typeof pdfBase64 === 'string' && pdfBase64.length > 0) {
      // Límite defensivo (base64 crece ~33% vs binario).
      if (pdfBase64.length > 12_000_000) {
        return res.status(400).json({ error: 'El PDF es demasiado grande para enviarlo por correo.' });
      }
      attachments.push({
        filename: (typeof pdfFilename === 'string' && pdfFilename.trim()) ? pdfFilename.trim() : 'Cotizacion.pdf',
        content: pdfBase64,
        encoding: 'base64',
        contentType: 'application/pdf'
      });
    }

    await transporter.sendMail({
      from: `"Vidrios Alejo" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: 'Cotización comercial Vidrios Alejo SAS (tabla + PDF adjunto)',
      html,
      attachments: attachments.length ? attachments : undefined
    });

    res.json({ message: 'Cotización enviada correctamente' });
  } catch (err) {
    console.error('enviar-cotizacion:', err.name || 'Error');
    res.status(500).json({ error: 'Error al enviar la cotización' });
  }
});

/* ========== RECUPERACIÓN DE CONTRASEÑA ========== */
app.post('/api/forgot-password', authLimiter, async (req, res) => {
  const input = z.object({ email: emailSchema }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Correo electrónico inválido' });
  const { email } = input.data;

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(200).json({ message: 'Si el correo está registrado, se enviará un enlace.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 3600000);

  await PasswordResetToken.deleteMany({ userId: user._id });
  await PasswordResetToken.create({ userId: user._id, tokenHash, expiresAt });

  const baseUrl = process.env.FRONTEND_URL || '';
  const resetUrl = `${baseUrl.replace(/\/$/, '')}/auth/reset-password.html?token=${token}`;

  const transporter = getMailTransporter();
  if (!transporter) {
    console.error('Email no configurado: no se puede enviar recuperación');
    return res.status(503).json({ error: 'Servicio de correo no disponible' });
  }

  const mailOptions = {
    to: user.email,
    subject: 'Instrucciones para restablecer su contraseña - Vidrios Alejo SAS',
    html: `
      <h3>Estimado(a) ${escapeHtml(user.username)}</h3>
      <p>Reciba un cordial saludo.</p>
      <p>Hemos recibido una solicitud para restablecer la contraseña de su cuenta. Haga clic en el siguiente enlace:</p>
      <p><a href="${resetUrl}" target="_blank">Restablecer contraseña</a></p>
      <p>Este enlace expira en una hora. Si no fue usted quien lo solicitó, ignore este mensaje.</p>
      <p><b>Vidrios Alejo SAS</b> — Tel: +57 3229340900</p>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ message: 'Se ha enviado un correo si el email está registrado.' });
  } catch (err) {
    console.error('Error al enviar el correo:', err.name || 'Error');
    res.status(500).json({ error: 'Error al enviar el correo de recuperación' });
  }
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
  const input = z.object({ token: z.string().min(32).max(128), newPassword: passwordSchema }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: input.error.issues[0]?.message || 'Token o contraseña inválidos' });
  const { token, newPassword } = input.data;

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const record = await PasswordResetToken.findOne({ tokenHash });

  if (!record || record.expiresAt < new Date()) {
    return res.status(400).json({ error: 'Token inválido o expirado' });
  }

  try {
    const user = await User.findById(record.userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    user.password = newPassword;
    await user.save();
    await RefreshToken.deleteMany({ userId: user._id });
    await PasswordResetToken.deleteOne({ _id: record._id });
    clearSessionCookies(res);
    return res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    console.error('Error al restablecer contraseña:', err.name || 'Error');
    return res.status(500).json({ error: 'Error en el servidor' });
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status === 413 || err.type === 'entity.too.large' ? 413 : 500;
  console.error('Request error:', err.name || 'Error');
  res.status(status).json({ error: status === 413 ? 'La solicitud supera el tamaño permitido' : 'Error interno del servidor' });
});

module.exports = app;
