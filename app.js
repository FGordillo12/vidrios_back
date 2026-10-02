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
const Glass = require('./models/Glass');
const Quote = require('./models/Quote');
const Counter = require('./models/Counter');
const QuoteSetting = require('./models/QuoteSetting');
const CompanySetting = require('./models/CompanySetting');
const { encryptField, decryptField } = require('./lib/crypto');
const PasswordResetToken = require('./models/PasswordResetToken');
const RefreshToken = require('./models/RefreshToken');
const { obtenerPrecioFallback } = require('./data/preciosIniciales');
const { mapLegacyPrice, mapCatalogPrice } = require('./lib/catalogPriceMap');

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

// Permite distinguir el servidor activo de una base de datos desconectada.
app.get('/api/health', async (req, res) => {
  try {
    await connectDb();
    res.json({ ok: true, database: 'connected' });
  } catch (err) {
    console.error('DB health check:', err.name || 'Error');
    const authFailed = err.code === 8000 || /bad auth|authentication failed/i.test(err.message || '');
    res.status(503).json({
      ok: false,
      database: 'disconnected',
      code: !process.env.MONGODB_URI ? 'DATABASE_CONFIG_MISSING' : authFailed ? 'DATABASE_AUTH_FAILED' : 'DATABASE_UNAVAILABLE',
      error: !process.env.MONGODB_URI
        ? 'Configura MONGODB_URI en vidrios_back/.env.'
        : authFailed
          ? 'Atlas rechazó las credenciales. Comprueba la contraseña vigente del usuario de base de datos y codifica caracteres especiales en la URI.'
          : 'MongoDB no responde. Comprueba la URI, la red y la lista de acceso de Atlas.'
    });
  }
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
    if (!process.env.MONGODB_URI) {
      return res.status(503).json({ code: 'DATABASE_CONFIG_MISSING', error: 'Falta configurar MONGODB_URI en vidrios_back/.env.' });
    }
    const authFailed = err.code === 8000 || /bad auth|authentication failed/i.test(err.message || '');
    res.status(503).json({
      code: authFailed ? 'DATABASE_AUTH_FAILED' : 'DATABASE_UNAVAILABLE',
      error: authFailed
        ? 'Atlas rechazó las credenciales. Comprueba la contraseña vigente del usuario de base de datos y codifica caracteres especiales en la URI.'
        : 'No hay conexión con MongoDB. Verifica la URI y el acceso de red.'
    });
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

function catalogoLegacy(tipo, variante, grosor) {
  const normalizedType = String(tipo || '').trim().toLowerCase();
  let catalogType = normalizedType;
  let catalogVariant = String(variante || '').trim().toLowerCase();
  let catalogThickness = String(grosor || '').trim();
  const explicitVariant = Boolean(catalogVariant);

  if (normalizedType === 'laminado' && !explicitVariant) {
    catalogType = 'transparente laminado';
    catalogVariant = catalogThickness;
    catalogThickness = catalogThickness === '3+3' ? '6' : catalogThickness === '4+4' ? '8' : catalogThickness;
  } else if (normalizedType === 'azul dark' && !explicitVariant) {
    catalogType = 'azul'; catalogVariant = 'dark';
  } else if (normalizedType === 'azul dark reflectivo' && !explicitVariant) {
    catalogType = 'azul'; catalogVariant = 'reflectivo';
  } else if (normalizedType === 'azul' && !explicitVariant) {
    catalogVariant = 'normal';
  } else if (normalizedType === 'bronce reflectivo' && !explicitVariant) {
    catalogType = 'bronce'; catalogVariant = 'reflectivo';
  } else if ((normalizedType === 'bronce' || normalizedType === 'bronce normal') && !explicitVariant) {
    catalogType = 'bronce'; catalogVariant = 'normal';
  } else if (['transparente', 'verde', 'gris'].includes(normalizedType) && !explicitVariant) {
    catalogVariant = 'normal';
  }

  return { tipo: catalogType, variante: catalogVariant, grosorMm: catalogThickness, explicitVariant };
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
    if ((process.env.JWT_SECRET || '').length < 32) {
      return res.status(503).json({ error: 'El registro no está configurado: define un JWT_SECRET de al menos 32 caracteres en vidrios_back/.env y reinicia el backend.' });
    }
    const { username, email, password } = input.data;
    const existingUser = await User.findOne({ $or: [{ username: { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }, { email }] });
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario o email ya está registrado' });
    }

    const newUser = new User({ username, email, password, role: 'user', active: false, approvalStatus: 'pending' });
    await newUser.save();

    res.status(202).json({
      code: 'ACCOUNT_PENDING',
      message: 'Tu solicitud fue recibida y está pendiente de aprobación por un administrador.',
      username: newUser.username,
      role: newUser.role,
      redirect: '/auth/pendiente.html'
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
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
    if (user.lockUntil && user.lockUntil > new Date()) return res.status(429).json({ error: 'Cuenta bloqueada temporalmente por intentos fallidos' });
    if (!(await user.comparePassword(password))) {
      const attempts = user.lockUntil && user.lockUntil <= new Date() ? 1 : user.failedLoginAttempts + 1;
      await User.updateOne({ _id: user._id }, { $set: { failedLoginAttempts: attempts, lockUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null } });
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    if (user.approvalStatus === 'pending') {
      return res.status(403).json({ code: 'ACCOUNT_PENDING', error: 'Tu cuenta está pendiente de aprobación por un administrador.', redirect: '/auth/pendiente.html' });
    }
    if (!user.active || user.approvalStatus === 'disabled') {
      return res.status(403).json({ code: 'ACCOUNT_DISABLED', error: 'Esta cuenta está desactivada. Contacta a un administrador.' });
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
  const users = await User.find().select('username email role active approvalStatus createdAt').sort({ createdAt: -1 }).lean();
  res.json(users);
});

const glassInputSchema = z.object({
  tipo: z.string().trim().min(2).max(60).transform((value) => value.toLowerCase()),
  variante: z.string().trim().max(40).optional().default('').transform((value) => value.toLowerCase()),
  grosorMm: z.union([z.string(), z.number()]).transform((value) => String(value).trim()).refine((value) => /^(\d{1,2}|\d{1,2}\+\d{1,2})$/.test(value), 'Grosor inválido'),
  precioM2: z.number().finite().min(0).max(100000000).default(0),
  activo: z.boolean().default(true)
}).strict();

async function saveLegacyPriceToCatalog(tipo, grosor, valor) {
  const key = mapLegacyPrice(tipo, grosor);
  if (!key) return;
  await Glass.findOneAndUpdate(
    key,
    { $set: { precioM2: valor }, $setOnInsert: { activo: true } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
}

async function saveCatalogPriceToLegacy(glass) {
  const key = mapCatalogPrice(glass);
  if (!key) return;
  await Precio.findOneAndUpdate(
    key,
    { $set: { ...key, valor: glass.precioM2 } },
    { upsert: true, new: true, runValidators: true }
  );
}

app.get('/api/catalogo', authenticateToken, async (req, res) => {
  const includeInactive = req.query.todos === '1';
  if (includeInactive && req.user.role !== 'admin') return res.status(403).json({ error: 'No tienes permisos para ver registros desactivados' });
  const filter = includeInactive ? {} : { activo: true };
  const catalog = await Glass.find(filter).sort({ tipo: 1, variante: 1, grosorMm: 1 }).lean();
  res.json(catalog);
});

app.post('/api/admin/catalogo', authenticateToken, requireRole('admin'), async (req, res) => {
  const input = glassInputSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: input.error.issues[0]?.message || 'Datos del vidrio inválidos' });
  try {
    const glass = await Glass.create(input.data);
    await saveCatalogPriceToLegacy(glass);
    res.status(201).json(glass);
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'Ya existe esa combinación de tipo, variante y grosor' });
    res.status(400).json({ error: 'No se pudo crear la combinación de vidrio' });
  }
});

app.patch('/api/admin/catalogo/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = z.string().regex(/^[a-f\d]{24}$/i).safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'Identificador de vidrio inválido' });
  const input = glassInputSchema.partial().safeParse(req.body);
  if (!input.success || Object.keys(input.data || {}).length === 0) return res.status(400).json({ error: input.success ? 'No hay cambios para guardar' : input.error.issues[0]?.message || 'Datos del vidrio inválidos' });
  try {
    const glass = await Glass.findByIdAndUpdate(id.data, { $set: input.data }, { new: true, runValidators: true });
    if (!glass) return res.status(404).json({ error: 'Combinación de vidrio no encontrada' });
    if (Object.hasOwn(input.data, 'precioM2')) await saveCatalogPriceToLegacy(glass);
    res.json(glass);
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'Ya existe esa combinación de tipo, variante y grosor' });
    res.status(400).json({ error: 'No se pudo actualizar la combinación de vidrio' });
  }
});

app.delete('/api/admin/catalogo/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = z.string().regex(/^[a-f\d]{24}$/i).safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'Identificador de vidrio inválido' });
  const glass = await Glass.findByIdAndDelete(id.data);
  if (!glass) return res.status(404).json({ error: 'Combinación de vidrio no encontrada' });
  res.json({ message: 'Combinación eliminada' });
});

app.get('/api/configuracion/cotizador', authenticateToken, async (req, res) => {
  const saved = await QuoteSetting.findOne({ key: 'default' }).lean();
  res.json({ minM2: saved?.minM2 ?? Number(process.env.MIN_M2 || 0) });
});
app.patch('/api/admin/configuracion/cotizador', authenticateToken, requireRole('admin'), async (req, res) => {
  const input = z.object({ minM2: z.number().finite().min(0).max(100).optional() }).strict().safeParse(req.body);
  if (!input.success || input.data.minM2 === undefined) return res.status(400).json({ error: 'Área mínima inválida' });
  const setting = await QuoteSetting.findOneAndUpdate({ key: 'default' }, { $set: input.data }, { upsert: true, new: true });
  res.json({ minM2: setting.minM2 });
});
const companySettingSchema = z.object({
  nombre: z.string().trim().min(2).max(100), nit: z.string().trim().max(40), direccion: z.string().trim().max(180),
  telefono: z.string().trim().max(80), email: z.union([emailSchema, z.literal('')]), instagram: z.string().trim().max(80),
  horario: z.string().trim().max(100), vigenciaDias: z.number().int().min(1).max(365), condicionesPago: z.string().trim().max(300)
}).strict();
app.get('/api/configuracion/empresa', authenticateToken, async (req, res) => {
  const settings = await CompanySetting.findOne({ key: 'default' }).lean();
  res.json(settings || new CompanySetting({ key: 'default' }).toObject());
});
app.patch('/api/admin/configuracion/empresa', authenticateToken, requireRole('admin'), async (req, res) => {
  const input = companySettingSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: input.error.issues[0]?.message || 'Configuración de empresa inválida' });
  const saved = await CompanySetting.findOneAndUpdate({ key: 'default' }, { $set: input.data }, { upsert: true, new: true, runValidators: true });
  res.json(saved);
});

function quoteResponse(doc) {
  const quote = doc.toObject ? doc.toObject() : doc;
  for (const key of Object.keys(quote.customer || {})) quote.customer[key] = decryptField(quote.customer[key]);
  quote.observaciones = decryptField(quote.observaciones);
  quote.historial = (quote.historial || []).map((entry) => ({ ...entry, nota: decryptField(entry.nota) }));
  return quote;
}
app.post('/api/cotizaciones', authenticateToken, async (req, res) => {
  const input = z.object({
    cliente: z.object({ nombre: z.string().trim().min(2).max(120), documento: z.string().trim().max(40).optional().default(''), telefono: z.string().trim().max(25).optional().default(''), email: z.string().trim().email().max(160).optional().or(z.literal('')).default(''), direccion: z.string().trim().max(220).optional().default(''), ciudad: z.string().trim().max(80).optional().default('') }).strict(),
    items: z.array(z.object({ tipo: z.string().max(60), variante: z.string().max(40).optional().default(''), grosor: z.union([z.string(), z.number()]), ancho: z.number().positive().max(10000), alto: z.number().positive().max(10000), unidad: z.enum(['m','cm','mm']).default('m'), cantidad: z.number().int().positive().max(1000), total: z.number().finite().min(0).max(1000000000) }).passthrough()).min(1).max(80),
    vigenciaDias: z.number().int().min(1).max(365).default(15), formaPago: z.string().trim().max(120).optional().default(''), observaciones: z.string().trim().max(1000).optional().default('')
  }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: input.error.issues[0]?.message || 'Datos de cotización inválidos' });
  try {
    const savedSettings = await QuoteSetting.findOne({ key: 'default' }).lean();
    const companyDoc = await CompanySetting.findOne({ key: 'default' }).lean() || new CompanySetting({ key: 'default' }).toObject();
    const company = Object.fromEntries(['nombre','nit','direccion','telefono','email','instagram','horario','vigenciaDias','condicionesPago'].map((key) => [key, companyDoc[key]]));
    const minM2 = savedSettings?.minM2 ?? Number(process.env.MIN_M2 || 0);
    const pricedItems = [];
    for (const item of input.data.items) {
      const mapped = catalogoLegacy(item.tipo, item.variante, String(item.grosor));
      const glass = await Glass.findOne({ tipo: mapped.tipo, variante: mapped.variante, grosorMm: mapped.grosorMm, activo: true }).lean();
      if (!glass || glass.precioM2 <= 0) return res.status(400).json({ error: `El precio de ${item.tipo} ${item.grosor} aún no está disponible` });
      const factor = item.unidad === 'cm' ? 0.01 : item.unidad === 'mm' ? 0.001 : 1;
      const anchoM = item.ancho * factor;
      const altoM = item.alto * factor;
      const realM2 = anchoM * altoM;
      const areaAproximada = aproximarMedidaFacturable(anchoM) * aproximarMedidaFacturable(altoM);
      const billedM2 = Math.max(areaAproximada, minM2) * item.cantidad;
      const vidrio = billedM2 * glass.precioM2;
      const pulido = item.vidrioPulido ? billedM2 * Number(process.env.PRECIO_PULIDO_COP_M2 || 15000) : 0;
      const sandblast = item.vidrioSandblasteado ? Number(item.sandblastExtra) || 0 : 0;
      pricedItems.push({ ...item, areaM2: realM2 * item.cantidad, areaFacturableM2: billedM2, precioM2: glass.precioM2, totalVidrio: vidrio, pulidoExtra: pulido, sandblastExtra: sandblast, total: vidrio + pulido + sandblast });
    }
    const seq = await Counter.findOneAndUpdate({ key: 'cotizacion' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
    const cliente = Object.fromEntries(Object.entries(input.data.cliente).map(([key, value]) => [key, encryptField(value)]));
    const quote = await Quote.create({ consecutivo: `COT-${String(seq.seq).padStart(4, '0')}`, owner: req.user._id,
      customer: cliente, company, items: pricedItems, total: pricedItems.reduce((sum, item) => sum + item.total, 0),
      vigenciaDias: input.data.vigenciaDias, formaPago: input.data.formaPago, observaciones: encryptField(input.data.observaciones),
      historial: [{ estado: 'borrador', usuario: req.user._id, nota: encryptField('Cotización creada') }] });
    res.status(201).json(quoteResponse(quote));
  } catch (error) {
    console.error('quote create:', error.name || 'Error');
    res.status(500).json({ error: 'No se pudo guardar la cotización. Verifica ENC_KEY.' });
  }
});
app.get('/api/cotizaciones', authenticateToken, async (req, res) => {
  const filter = req.user.role === 'admin' ? {} : { owner: req.user._id };
  if (['borrador','enviada','aprobada','rechazada'].includes(req.query.estado)) filter.estado = req.query.estado;
  if (req.query.desde || req.query.hasta) filter.createdAt = {};
  if (filter.createdAt) { if (req.query.desde) filter.createdAt.$gte = new Date(req.query.desde); if (req.query.hasta) filter.createdAt.$lte = new Date(`${req.query.hasta}T23:59:59.999Z`); }
  const docs = await Quote.find(filter).sort({ createdAt: -1 }).limit(300).lean();
  let rows = docs.map(quoteResponse);
  const search = String(req.query.buscar || '').trim().toLowerCase();
  if (search) rows = rows.filter((q) => [q.consecutivo, ...Object.values(q.customer || {})].some((v) => String(v || '').toLowerCase().includes(search)));
  res.json(rows);
});
app.get('/api/cotizaciones/:id', authenticateToken, async (req, res) => {
  const id = z.string().regex(/^[a-f\d]{24}$/i).safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'Identificador de cotización inválido' });
  const quote = await Quote.findById(id.data);
  if (!quote || (req.user.role !== 'admin' && quote.owner.toString() !== req.user._id.toString())) return res.status(404).json({ error: 'Cotización no encontrada' });
  res.json(quoteResponse(quote));
});
app.patch('/api/cotizaciones/:id/estado', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede cambiar el estado de la cotización' });
  const id = z.string().regex(/^[a-f\d]{24}$/i).safeParse(req.params.id);
  const input = z.object({ estado: z.enum(['borrador','enviada','aprobada','rechazada']), nota: z.string().trim().max(300).optional().default('') }).strict().safeParse(req.body);
  if (!id.success || !input.success) return res.status(400).json({ error: 'Cambio de estado inválido' });
  const quote = await Quote.findById(id.data);
  if (!quote) return res.status(404).json({ error: 'Cotización no encontrada' });
  if (req.user.role !== 'admin' && quote.owner.toString() !== req.user._id.toString()) return res.status(404).json({ error: 'Cotización no encontrada' });
  quote.estado = input.data.estado;
  quote.historial.push({ estado: input.data.estado, usuario: req.user._id, nota: encryptField(input.data.nota) });
  await quote.save();
  res.json(quoteResponse(quote));
});

app.patch('/api/admin/users/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  const userId = z.string().regex(/^[a-f\d]{24}$/i).safeParse(req.params.id);
  if (!userId.success) return res.status(400).json({ error: 'Identificador de usuario inválido' });
  const input = z.object({ role: z.enum(['admin', 'user']).optional(), active: z.boolean().optional() }).strict().safeParse(req.body);
  if (!input.success || Object.keys(input.data || {}).length === 0) return res.status(400).json({ error: 'Cambios de usuario inválidos' });
  if (userId.data === req.user._id.toString() && (input.data.active === false || input.data.role === 'user')) return res.status(400).json({ error: 'No puedes quitarte el acceso de administrador a ti mismo' });
  try {
    const changes = { ...input.data };
    if (changes.active === true) changes.approvalStatus = 'approved';
    if (changes.active === false) changes.approvalStatus = 'disabled';
    const user = await User.findByIdAndUpdate(userId.data, { $set: changes }, { new: true, runValidators: true }).select('username email role active approvalStatus createdAt');
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

function aproximarMedidaFacturable(metros) {
  return Math.ceil((metros * 10) - 1e-10) / 10;
}

async function handleCotizar(req, res) {
  let {
    tipo,
    variante,
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

  if (!tipo || !Number.isFinite(ancho) || !Number.isFinite(alto) || ancho <= 0 || alto <= 0 || !Number.isInteger(cantidad) || cantidad <= 0 || grosor === undefined) {
    return res.status(400).json({ error: 'Faltan datos o datos inválidos' });
  }

  if (sandblast && sandblastNum <= 0) {
    return res.status(400).json({ error: 'Indique el valor adicional del sandblast (COP) para este ítem' });
  }

  try {
    const grosorStr = String(grosor).trim();
    const catalogQuery = catalogoLegacy(tipo, variante, grosorStr);
    const glass = await Glass.findOne({ tipo: catalogQuery.tipo, variante: catalogQuery.variante, grosorMm: catalogQuery.grosorMm });
    if (catalogQuery.explicitVariant && !glass) return res.status(400).json({ error: 'No existe esta combinación en el catálogo' });
    if (glass && !glass.activo) return res.status(400).json({ error: 'Esta combinación de vidrio está desactivada' });
    if (catalogQuery.explicitVariant && glass.precioM2 <= 0) return res.status(400).json({ error: 'El administrador aún no ha configurado el precio de esta combinación' });
    let precioUnit = glass?.precioM2 > 0 ? glass.precioM2 : null;
    const precioDoc = precioUnit === null ? await Precio.findOne({ tipo, grosor: grosorStr }) : null;

    if (precioUnit !== null) {
      precioUnit = glass.precioM2;
    } else if (precioDoc) {
      precioUnit = precioDoc.valor;
    } else {
      const fallback = obtenerPrecioFallback(tipo, grosorStr);
      if (fallback === null || fallback === undefined) {
        return res.status(400).json({ error: `No se encontró precio para ${tipo} con grosor ${grosor}` });
      }
      precioUnit = fallback;
    }

    const areaReal = ancho * alto;
    const areaAproximada = aproximarMedidaFacturable(ancho) * aproximarMedidaFacturable(alto);
    const savedSettings = await QuoteSetting.findOne({ key: 'default' }).lean();
    const minM2 = savedSettings?.minM2 ?? Number(process.env.MIN_M2 || 0);
    const area = Math.max(areaAproximada, minM2);
    const totalVidrio = area * precioUnit * cantidad;

    const precioPulidoM2 = Number(process.env.PRECIO_PULIDO_COP_M2 || 15000);
    const pulidoExtra = pulido ? area * cantidad * precioPulidoM2 : 0;
    const sandblastExtra = sandblast ? sandblastNum : 0;

    const total = totalVidrio + pulidoExtra + sandblastExtra;

    res.json({
      total,
      area: area * cantidad,
      areaReal: areaReal * cantidad,
      areaPorUnidad: area,
      tipo,
      variante: variante || catalogQuery.variante,
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
        await saveLegacyPriceToCatalog(tipoNormalizado, grosorNormalizado, valor);
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
      <td style="padding:8px;border:1px solid #ccc;">${escapeHtml(String(item.tipo || ''))}${item.variante ? ` · ${escapeHtml(String(item.variante))}` : ''}<br><span style="font-size:11px;color:#555;">${escapeHtml(acabados)}</span></td>
      <td style="padding:8px;border:1px solid #ccc;">${escapeHtml(String(item.grosor || ''))}${String(item.grosor || '').includes('+') ? '' : ' mm'}</td>
      <td style="padding:8px;border:1px solid #ccc;">${escapeHtml(String(item.anchoOriginal ?? item.ancho))} ${escapeHtml(String(item.unidad || 'm'))} × ${escapeHtml(String(item.altoOriginal ?? item.alto))} ${escapeHtml(String(item.unidad || 'm'))}</td>
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
    const { contacto, cotizaciones, pdfBase64, pdfFilename, consecutivo, cliente } = req.body;
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
    const quoteFilter = typeof consecutivo === 'string' && /^COT-\d{4,}$/.test(consecutivo)
      ? { consecutivo, ...(req.user.role === 'admin' ? {} : { owner: req.user._id }) } : null;
    const linkedQuote = quoteFilter ? await Quote.findOne(quoteFilter) : null;
    const safeConsecutivo = linkedQuote?.consecutivo || '';
    const company = linkedQuote?.company?.nombre ? linkedQuote.company : (await CompanySetting.findOne({ key: 'default' }).lean() || {});
    const companyName = escapeHtml(company.nombre || 'Vidrios Alejo SAS');
    const companyEmail = escapeHtml(company.email || 'contacto@vidriosalejo.com');
    const companyPhone = escapeHtml(company.telefono || '+57 322 934 0900');

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;background:#f4f7fb;padding:24px;color:#1f2d3d;">
        <div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #dfe7f2;border-radius:10px;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#1f3f68,#2d6bb5);padding:22px 24px;color:#fff;">
            <h2 style="margin:0 0 6px 0;font-size:22px;">Cotización Comercial - ${companyName}</h2>
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
              ${safeConsecutivo ? `<p style="margin:0 0 6px 0;font-size:13px;"><strong>Cotización:</strong> ${escapeHtml(safeConsecutivo)}</p>` : ''}
              <p style="margin:0 0 6px 0;font-size:13px;"><strong>Solicitado por:</strong> ${solicitadoPor}</p>
              <p style="margin:0;font-size:13px;"><strong>Contacto registrado:</strong> ${escapeHtml(contacto.trim())}</p>
            </div>

            ${cotizacionesHtmlTable(cotizaciones, total)}

            <p style="margin:16px 0 0 0;line-height:1.6;">
              Para confirmar, ajustar o resolver cualquier inquietud sobre esta cotización, estaremos atentos a su mensaje.
            </p>
            <p style="margin:16px 0 0 0;">Cordialmente,</p>
            <p style="margin:6px 0 0 0;"><strong>Equipo Comercial</strong><br/>${companyName}<br/>${companyPhone} · ${companyEmail}</p>
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
      subject: `${String(company.nombre || 'Vidrios Alejo SAS').replace(/[\r\n]/g, ' ')}: cotización comercial${safeConsecutivo ? ` ${safeConsecutivo}` : ''}`,
      html,
      attachments: attachments.length ? attachments : undefined
    });

    if (linkedQuote && linkedQuote.estado !== 'enviada') {
      linkedQuote.estado = 'enviada';
      linkedQuote.historial.push({ estado: 'enviada', usuario: req.user._id, nota: encryptField('Cotización enviada por correo') });
      await linkedQuote.save();
    }

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
