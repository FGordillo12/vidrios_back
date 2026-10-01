const crypto = require('crypto');

function encryptionKey() {
  const raw = process.env.ENC_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error('ENC_KEY debe contener 64 caracteres hexadecimales');
  return Buffer.from(raw, 'hex');
}

function encryptField(value) {
  if (value === undefined || value === null || value === '') return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptField(value) {
  if (value === undefined || value === null || value === '') return value;
  const [version, ivPart, tagPart, dataPart] = String(value).split(':');
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) throw new Error('Formato de dato cifrado inválido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivPart, 'base64'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encryptField, decryptField };
