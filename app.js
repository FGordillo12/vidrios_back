require('./load-env')();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { connectDb } = require('./db');
const User = require('./models/User');
const Precio = require('./models/Precio');
const PasswordResetToken = require('./models/PasswordResetToken');
const { obtenerPrecioFallback } = require('./data/preciosIniciales');

const app = express();
const isVercel = process.env.VERCEL === '1';


const corsOptions = {
  origin: [
    'http://localhost:5173', 
    'https://cdisfruta.vercel.app'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'], 
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}; 

app.use(cors(corsOptions));
// La generación de PDF (base64) puede ser grande para cotizaciones con muchos ítems.
// Ajustamos el límite para permitir adjuntar el PDF en el envío por correo.
app.use(express.json({ limit: '15mb' }));

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
    console.error('DB connection error:', err.message);
    const payload = { error: 'Servicio temporalmente no disponible' };
    if (process.env.NODE_ENV !== 'production') {
      payload.detail = err.message;
    }
    res.status(503).json(payload);
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
  return process.env.JWT_SECRET || 'TU_SECRETO_JWT';
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token no proporcionado' });

  jwt.verify(token, getJwtSecret(), (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
    req.user = user;
    next();
  });
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
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario o email ya está registrado' });
    }

    const newUser = new User({ username, email, password });
    await newUser.save();

    const token = jwt.sign(
      { userId: newUser._id, username: newUser.username },
      getJwtSecret(),
      { expiresIn: '8h' }
    );

    res.status(201).json({
      message: 'Usuario registrado exitosamente',
      token,
      username: newUser.username,
      redirect: '/index.html'
    });
  } catch (error) {
    console.error('Error en el registro:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { userId: user._id, username: user.username },
      getJwtSecret(),
      { expiresIn: '8h' }
    );

    res.json({
      token,
      username: user.username,
      redirect: '/index.html'
    });
  } catch (error) {
    console.error('Error en el login:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener información del usuario' });
  }
});

app.post('/api/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Sesión cerrada exitosamente' });
});

/* ========== COTIZACIÓN ========== */
async function handleCotizar(req, res) {
  let { tipo, ancho, alto, cantidad, grosor } = req.body;

  tipo = (tipo || '').trim().toLowerCase();
  ancho = parseFloat(ancho);
  alto = parseFloat(alto);
  cantidad = parseInt(cantidad, 10);

  if (!tipo || Number.isNaN(ancho) || Number.isNaN(alto) || Number.isNaN(cantidad) || grosor === undefined) {
    return res.status(400).json({ error: 'Faltan datos o datos inválidos' });
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
    const total = area * precioUnit * cantidad;

    res.json({ total, area, tipo, grosor, precio: precioUnit });
  } catch (error) {
    console.error('Error al cotizar:', error.message);
    res.status(500).json({ error: 'Error al calcular la cotización' });
  }
}

app.post('/cotizar', handleCotizar);
app.post('/api/cotizar', handleCotizar);

app.post('/api/editar-precios', authenticateToken, async (req, res) => {
  const nuevosPrecios = req.body;

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
    console.error('Error al actualizar precios:', error.message);
    res.status(500).json({ error: 'Error al guardar precios en la base de datos' });
  }
});

app.get('/api/precios', authenticateToken, async (req, res) => {
  try {
    const precios = await Precio.find();
    res.json(precios);
  } catch (error) {
    console.error('Error al obtener precios:', error.message);
    res.status(500).json({ error: 'Error al obtener precios' });
  }
});

app.get('/api/obtener-precios', async (req, res) => {
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
    .map(
      (item) => `
    <tr>
      <td style="padding:8px;border:1px solid #ccc;">${escapeHtml(String(item.tipo || ''))}</td>
      <td style="padding:8px;border:1px solid #ccc;">${escapeHtml(String(item.grosor || ''))} mm</td>
      <td style="padding:8px;border:1px solid #ccc;">${escapeHtml(String(item.anchoOriginal ?? item.ancho))}m × ${escapeHtml(String(item.altoOriginal ?? item.alto))}m</td>
      <td style="padding:8px;border:1px solid #ccc;text-align:center;">${escapeHtml(String(item.cantidad))}</td>
      <td style="padding:8px;border:1px solid #ccc;text-align:right;">${formatCop(item.total)}</td>
    </tr>`
    )
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
    console.error('enviar-cotizacion:', err.message);
    res.status(500).json({ error: 'Error al enviar la cotización' });
  }
});

/* ========== RECUPERACIÓN DE CONTRASEÑA ========== */
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'Email requerido' });
  }

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
    console.error('Error al enviar el correo:', err.message);
    res.status(500).json({ error: 'Error al enviar el correo de recuperación' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Token o contraseña inválidos (mínimo 6 caracteres)' });
  }

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
    await PasswordResetToken.deleteOne({ _id: record._id });
    return res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    console.error('Error al restablecer contraseña:', err.message);
    return res.status(500).json({ error: 'Error en el servidor' });
  }
});

module.exports = app;
