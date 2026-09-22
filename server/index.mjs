import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { db, id, newProject, save, touch, mediaRoot, localFile } from './store.mjs';
import { health, probe } from './media.mjs';
import { publicProvider, hydrated, seal } from './secrets.mjs';
import { endpoint, request } from './providers.mjs';
import { busy, enqueue, cancel } from './jobs.mjs';

const app = express(); const port = Number(process.env.PORT || 4387);
app.disable('x-powered-by');
app.use((req, res, next) => {
  const hostname = req.hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return res.status(403).json({ error: '仅允许本机访问' });
  if (req.headers.origin) { try { const origin = new URL(req.headers.origin); if (!['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) return res.status(403).json({ error: '来源不允许' }); } catch { return res.status(403).end(); } }
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next();
});
app.use(express.json({ limit: '4mb' }));
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use('/media', express.static(mediaRoot, { setHeaders: res => { res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'; sandbox"); } }));
const getProject = req => { const p = db.projects.find(p => p.id === req.params.id); if (!p) throw new Error('找不到作品'); return p; };
const writable = p => { if (busy(p.id)) throw new Error('作品正在执行任务，请先等待或取消'); };
app.get('/api/state', (_req, res) => res.json({ projects: db.projects, providers: db.providers.map(publicProvider), jobs: db.jobs.slice(0, 100) }));
app.get('/api/health', async (_req, res) => res.json({ ok: true, ffmpeg: await health(), localOnly: true }));
app.post('/api/projects', (req, res) => { const p = newProject(z.string().max(100).parse(req.body.name || '未命名作品')); db.projects.unshift(p); save(); res.json(p); });
const projectPatch = z.object({ name: z.string().min(1).max(100).optional(), brief: z.string().max(30000).optional(), style: z.string().max(300).optional(), aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(), targetDuration: z.number().int().min(4).max(600).optional(), plannerId: z.string().optional(), fl2vaId: z.string().optional(), ref2vaId: z.string().optional() });
app.patch('/api/projects/:id', (req, res) => { const p = getProject(req); writable(p); const patch = projectPatch.parse(req.body); if (patch.aspectRatio && patch.aspectRatio !== p.aspectRatio) p.output = null; Object.assign(p, patch); touch(p); res.json(p); });
const shotPatch = z.object({ title: z.string().min(1).max(100).optional(), description: z.string().max(10000).optional(), prompt: z.string().min(1).max(20000).optional(), negativePrompt: z.string().max(4000).optional(), dialogue: z.string().max(4000).optional(), sound: z.string().max(4000).optional(), camera: z.string().max(500).optional(), duration: z.number().min(1).max(30).optional(), mode: z.enum(['FL2VA', 'REF2VA']).optional(), providerId: z.string().optional(), firstFrameId: z.string().optional(), lastFrameId: z.string().optional(), referenceIds: z.array(z.string()).max(20).optional() });
app.patch('/api/projects/:id/shots/:shotId', (req, res) => {
  const p = getProject(req); writable(p); const shot = p.shots.find(s => s.id === req.params.shotId); if (!shot) throw new Error('找不到分镜');
  const patch = shotPatch.parse(req.body);
  if (patch.referenceIds?.some(a => !p.assets.some(v => v.id === a))) throw new Error('参考素材不存在');
  for (const field of ['firstFrameId', 'lastFrameId']) if (patch[field] && !p.assets.some(a => a.id === patch[field] && a.kind === 'image')) throw new Error('首尾帧必须是图片素材');
  const changed = Object.keys(patch).some(k => JSON.stringify(patch[k]) !== JSON.stringify(shot[k]));
  Object.assign(shot, patch);
  if (changed) { shot.status = 'draft'; shot.videoUrl = null; shot.audioUrl = null; shot.remoteJobId = null; shot.demo = false; p.output = null; }
  touch(p); res.json(shot);
});
app.post('/api/projects/:id/reorder', (req, res) => { const p = getProject(req); writable(p); const ids = z.array(z.string()).parse(req.body.ids); if (ids.length !== p.shots.length || new Set(ids).size !== ids.length || ids.some(id => !p.shots.some(s => s.id === id))) throw new Error('分镜顺序无效'); p.shots = ids.map(id => p.shots.find(s => s.id === id)); p.output = null; touch(p); res.json(p); });
app.delete('/api/projects/:id/shots/:shotId', (req, res) => { const p = getProject(req); writable(p); p.shots = p.shots.filter(s => s.id !== req.params.shotId); p.output = null; touch(p); res.json(p); });
const allowedMime = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/flac': '.flac' };
const upload = multer({ storage: multer.diskStorage({ destination: mediaRoot, filename: (_req, file, cb) => cb(null, `${id()}${allowedMime[file.mimetype] || '.bin'}`) }), limits: { fileSize: 200 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => allowedMime[file.mimetype] ? cb(null, true) : cb(new Error('支持 JPG、PNG、WebP、MP4、WebM、MOV 与常用音频格式')) });
app.post('/api/projects/:id/assets', (req, _res, next) => { try { writable(getProject(req)); next(); } catch (e) { next(e); } }, upload.single('file'), async (req, res) => {
  const p = getProject(req); if (!req.file) throw new Error('请选择素材');
  try {
    writable(p); const info = await probe(req.file.path); if (!info.streams?.length) throw new Error('无法读取素材');
    const kind = req.file.mimetype.split('/')[0];
    const asset = { id: id(), name: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), kind, mime: req.file.mimetype, role: ['character', 'scene', 'first', 'last', 'voice', 'motion'].includes(req.body.role) ? req.body.role : 'character', url: `/media/${req.file.filename}`, size: req.file.size, duration: Number(info.format?.duration) || null };
    p.assets.push(asset); touch(p); res.json(asset);
  } catch (error) { await fs.rm(req.file.path, { force: true }); throw error; }
});
app.delete('/api/projects/:id/assets/:assetId', async (req, res) => { const p = getProject(req); writable(p); if (p.shots.some(s => s.referenceIds.includes(req.params.assetId) || s.firstFrameId === req.params.assetId || s.lastFrameId === req.params.assetId)) throw new Error('请先解除分镜对该素材的引用'); p.assets = p.assets.filter(a => a.id !== req.params.assetId); touch(p); res.json(p); });
const providerSchema = z.object({ id: z.string().optional(), name: z.string().min(1).max(100), kind: z.enum(['planner', 'video']), protocol: z.enum(['openai', 'h3', 'http', 'comfyui']), baseUrl: z.url(), model: z.string().max(200).default(''), apiKey: z.string().max(8000).optional(), clearApiKey: z.boolean().optional(), authHeader: z.string().default('Authorization'), authPrefix: z.string().default('Bearer '), headers: z.record(z.string(), z.string()).default({}), capabilities: z.array(z.enum(['FL2VA', 'REF2VA'])).default([]), submitPath: z.string().default(''), pollPath: z.string().default(''), resultPath: z.string().default(''), uploadPath: z.string().default('/upload/image'), assetEncoding: z.enum(['data-url', 'url']).default('data-url'), publicMediaBaseUrl: z.string().default(''), bodyTemplate: z.record(z.string(), z.unknown()).default({}), responseMap: z.object({ jobId: z.string().default('id'), status: z.string().default('status'), videoUrl: z.string().default('video_url'), audioUrl: z.string().default(''), successValues: z.array(z.string()).default(['completed', 'succeeded', 'success']), failureValues: z.array(z.string()).default(['failed', 'error', 'cancelled']) }).default({ jobId: 'id', status: 'status', videoUrl: 'video_url', audioUrl: '', successValues: ['completed', 'succeeded', 'success'], failureValues: ['failed', 'error', 'cancelled'] }), pollIntervalSeconds: z.number().min(1).max(60).default(5), timeoutSeconds: z.number().min(10).max(14400).default(1800), supportsAudio: z.boolean().default(false), jsonMode: z.boolean().default(false), extraBody: z.record(z.string(), z.unknown()).default({}) });
app.post('/api/providers', (req, res) => {
  const input = providerSchema.parse(req.body); endpoint(input);
  if (input.kind === 'video' && !input.capabilities.length) throw new Error('请选择至少一种视频能力');
  if ((input.kind === 'planner') !== (input.protocol === 'openai')) throw new Error('理解模型使用 Responses 协议，视频模型使用 H3、HTTP 或 ComfyUI');
  const existing = db.providers.find(p => p.id === input.id);
  if (existing && db.jobs.some(j => ['queued', 'running'].includes(j.status))) throw new Error('有运行中的任务，请完成后再修改模型配置');
  const oldHeaders = existing ? hydrated(existing).headers : {}; const headers = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k, v === '••••' ? oldHeaders[k] || '' : v]));
  const { apiKey, clearApiKey, headers: ignored, ...rest } = input;
  const provider = { ...rest, id: existing?.id || id(), secret: clearApiKey ? '' : apiKey ? seal(apiKey) : existing?.secret || '', headerSecret: seal(JSON.stringify(headers)) };
  if (existing) db.providers[db.providers.indexOf(existing)] = provider; else db.providers.push(provider); save(); res.json(publicProvider(provider));
});
app.post('/api/providers/:id/check', async (req, res) => { const stored = db.providers.find(p => p.id === req.params.id); if (!stored) throw new Error('模型不存在'); const p = hydrated(stored); const route = p.protocol === 'comfyui' ? '/system_stats' : ['openai', 'h3'].includes(p.protocol) ? '/models' : ''; if (!route) return res.json({ ok: true, message: '配置格式有效。通用 HTTP 没有统一探测接口，实际可用性需生成后确认。' }); await request(p, route); res.json({ ok: true, message: '服务连通；这不代表所填模型一定有生成权限。' }); });
app.delete('/api/providers/:id', (req, res) => { if (db.jobs.some(j => ['queued', 'running'].includes(j.status))) throw new Error('请等待运行中的任务结束'); db.providers = db.providers.filter(p => p.id !== req.params.id); for (const p of db.projects) { for (const key of ['plannerId', 'fl2vaId', 'ref2vaId']) if (p[key] === req.params.id) p[key] = ''; for (const s of p.shots) if (s.providerId === req.params.id) s.providerId = ''; } save(); res.json({ ok: true }); });
app.post('/api/projects/:id/jobs', (req, res) => { const p = getProject(req); const options = z.object({ type: z.enum(['plan', 'generate', 'compose', 'pipeline']), demo: z.boolean().default(false), shotId: z.string().optional(), instruction: z.string().max(6000).optional() }).parse(req.body); const { type, ...rest } = options; res.json(enqueue(p, type, rest)); });
app.post('/api/jobs/:id/cancel', (req, res) => { const job = db.jobs.find(j => j.id === req.params.id); if (!job) throw new Error('找不到任务'); cancel(job); res.json(job); });
app.get('/api/projects/:id/export', (req, res) => { const p = getProject(req); res.attachment('storyboard.json').json({ ...p, exportedAt: new Date().toISOString() }); });
if (process.argv.includes('--production')) { app.use(express.static(path.resolve('dist'))); app.get('/{*path}', (req, res) => { if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) return res.status(404).end(); res.sendFile(path.resolve('dist/index.html')); }); }
app.use((error, _req, res, _next) => { const message = error instanceof z.ZodError ? `输入格式错误：${error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}` : error.code === 'LIMIT_FILE_SIZE' ? '单个素材不能超过 200 MB' : error.message || '请求失败'; res.status(400).json({ error: message }); });
const server = app.listen(port, '127.0.0.1', () => console.log(`Frameflow API: http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.message); process.exit(1); });
