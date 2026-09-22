import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { root } from './store.mjs';
const keyPath = path.join(root, 'secret.key');
if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
const key = fs.readFileSync(keyPath);
export function seal(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.'); }
export function unseal(value) { if (!value) return ''; const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64')); const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'); }
export function hydrated(provider) { return { ...provider, apiKey: unseal(provider.secret), headers: JSON.parse(unseal(provider.headerSecret) || '{}') }; }
export function publicProvider(provider) { const { secret, headerSecret, ...rest } = provider; return { ...rest, hasApiKey: Boolean(secret), headers: Object.fromEntries(Object.keys(JSON.parse(unseal(headerSecret) || '{}')).map(k => [k, '••••'])) }; }
