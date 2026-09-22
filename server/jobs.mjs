import { db, id, save, touch } from './store.mjs';
import { hydrated } from './secrets.mjs';
import { generate } from './providers.mjs';
import { demoPlan, planStoryboard } from './agent.mjs';
import { compose, makeDemo, probe } from './media.mjs';
import { localFile } from './store.mjs';
const controllers = new Map(); let workers = 0;
const pending = [];
const providerSlots = new Map();
async function withProviderSlot(provider, signal, fn) {
  // Local inference is serialized to avoid loading competing jobs into one GPU.
  const limit = ['h3', 'comfyui'].includes(provider.protocol) ? 1 : 2;
  while ((providerSlots.get(provider.id) || 0) >= limit) {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 250); const abort = () => { clearTimeout(timer); reject(signal.reason); }; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
  }
  signal.throwIfAborted(); providerSlots.set(provider.id, (providerSlots.get(provider.id) || 0) + 1);
  try { return await fn(); } finally { providerSlots.set(provider.id, (providerSlots.get(provider.id) || 1) - 1); }
}
export function busy(projectId) { return db.jobs.some(j => j.projectId === projectId && ['queued', 'running'].includes(j.status)); }
function providerFor(id, kind) { const p = db.providers.find(p => p.id === id && p.kind === kind); if (!p) throw new Error(kind === 'planner' ? '请先在模型接入中配置并选择多模态理解模型' : '请为此分镜选择视频模型'); return hydrated(p); }
export function enqueue(project, type, options = {}) {
  if (busy(project.id)) throw new Error('该作品已有运行中的任务，请等待完成或取消');
  const job = { id: id(), projectId: project.id, type, options, status: 'queued', progress: 0, logs: [], createdAt: new Date().toISOString() };
  db.jobs.unshift(job); save(); pending.push(job); queueMicrotask(pump); return job;
}
function pump() { while (workers < 2 && pending.length) { const job = pending.shift(); if (job.status !== 'queued') continue; workers++; execute(job).finally(() => { workers--; pump(); }); } }
export function cancel(job) {
  if (!['queued', 'running'].includes(job.status)) return;
  if (job.status === 'queued') { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); save(); }
  else { job.cancelRequested = true; controllers.get(job.id)?.abort(new Error('用户取消任务')); save(); }
}
async function execute(job) {
  const controller = new AbortController(); controllers.set(job.id, controller); const signal = controller.signal;
  const project = db.projects.find(p => p.id === job.projectId);
  const log = text => { job.logs.push({ time: new Date().toISOString(), text }); job.logs = job.logs.slice(-150); save(); };
  const progress = (value, text) => { job.progress = value; if (text) log(text); else save(); };
  job.status = 'running'; job.startedAt = new Date().toISOString(); save();
  try {
    if (['plan', 'pipeline'].includes(job.type)) {
      log(job.options.demo ? '加载固定示例分镜（不会调用 AI）' : '正在理解需求与参考素材');
      const plan = job.options.demo ? demoPlan(project) : await planStoryboard(project, providerFor(project.plannerId, 'planner'), signal, log, job.options.instruction || '');
      signal.throwIfAborted(); project.shots = plan.shots; project.characters = plan.characters; project.output = null;
      project.messages.push({ id: id(), role: 'assistant', content: plan.summary, at: new Date().toISOString(), demo: Boolean(job.options.demo) });
      if (project.messages.length > 50) project.messages.splice(0, project.messages.length - 50);
      log(`已生成 ${plan.shots.length} 个分镜及独立音画提示词`); touch(project);
    }
    if (['generate', 'pipeline'].includes(job.type)) {
      const shots = job.options.shotId ? project.shots.filter(s => s.id === job.options.shotId) : project.shots.filter(s => s.status !== 'completed');
      if (!project.shots.length || (job.options.shotId && !shots.length)) throw new Error('请先生成分镜');
      const errors = []; let done = 0;
      for (const shot of shots) { shot.status = 'queued'; shot.error = null; } save();
      // Two independent shots can run concurrently; mutations stay on Node's event loop.
      const work = [...shots];
      await Promise.all(Array.from({ length: Math.min(2, work.length) }, async () => {
        while (work.length && !signal.aborted) {
          const shot = work.shift(); shot.status = 'generating'; shot.remoteJobId = null; save();
          try {
            const index = project.shots.indexOf(shot); log(`第 ${index + 1} 镜：${job.options.demo ? '生成 DEMO 测试画面' : `使用 ${shot.mode}`}`);
            const provider = job.options.demo ? null : providerFor(shot.providerId || (shot.mode === 'REF2VA' ? project.ref2vaId : project.fl2vaId), 'video');
            const result = job.options.demo ? { videoUrl: await makeDemo(shot, index, signal), audioUrl: null } : await withProviderSlot(provider, signal, () => generate(provider, project, shot, signal, text => log(`第 ${index + 1} 镜 · ${text}`), remoteId => { shot.remoteJobId = remoteId; save(); }));
            const info = await probe(localFile(result.videoUrl), signal);
            if (!info.streams.some(s => s.codec_type === 'video')) throw new Error('模型返回的文件没有有效视频流');
            signal.throwIfAborted(); Object.assign(shot, result, { status: 'completed', demo: Boolean(job.options.demo), error: null }); project.output = null;
            log(`第 ${index + 1} 镜已下载并验证视频流`);
          } catch (error) { shot.status = signal.aborted ? 'cancelled' : 'failed'; shot.error = error.message; errors.push(error.message); log(`${shot.title}：${error.message}`); }
          finally { done++; progress(Math.round(done / Math.max(shots.length, 1) * 90)); touch(project); }
        }
      }));
      signal.throwIfAborted();
      if (errors.length) throw new Error(`${errors.length} 个分镜失败，已保留成功片段。${errors[0]}`);
    }
    if (job.type === 'compose' || job.type === 'pipeline') {
      log('合成 MP4：统一画幅、帧率、时长，保留原生音轨');
      const output = await compose(project, signal, progress); signal.throwIfAborted(); project.output = output; touch(project); log('成片与独立 SRT 字幕已导出');
    }
    job.status = 'completed'; job.progress = 100;
  } catch (error) { job.status = signal.aborted ? 'cancelled' : 'failed'; job.error = error.message; log(error.message); }
  finally {
    for (const shot of project?.shots || []) if (['queued', 'generating'].includes(shot.status)) shot.status = signal.aborted ? 'cancelled' : 'failed';
    job.finishedAt = new Date().toISOString(); controllers.delete(job.id); save();
  }
}
