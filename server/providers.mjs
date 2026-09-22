import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mediaRoot, localFile, id } from './store.mjs';
import { assetData } from './media.mjs';

export function at(object, route) { return route ? route.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((v, k) => v?.[k], object) : undefined; }
export function template(value, context) {
  if (Array.isArray(value)) return value.map(v => template(v, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, template(v, context)]));
  if (typeof value !== 'string') return value;
  const match = value.match(/^\{\{([\w.]+)\}\}$/);
  if (match) { const v = at(context, match[1]); if (v === undefined) throw new Error(`模板变量不存在：${match[1]}`); return v; }
  return value.replace(/\{\{([\w.]+)\}\}/g, (_, key) => { const v = at(context, key); if (v === undefined) throw new Error(`模板变量不存在：${key}`); return String(v); });
}
export function endpoint(provider, route = '') {
  const base = new URL(provider.baseUrl.endsWith('/') ? provider.baseUrl : `${provider.baseUrl}/`);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('接口地址必须是 HTTP(S)，凭据请填在密钥字段');
  const url = new URL(route.replace(/^\//, ''), base);
  if (url.origin !== base.origin) throw new Error('接口路径不能指向另一个主机');
  return url.toString();
}
export async function request(provider, route, { body, method = body ? 'POST' : 'GET', signal } = {}) {
  const headers = { ...provider.headers };
  if (provider.apiKey) headers[provider.authHeader || 'Authorization'] = `${provider.authPrefix ?? 'Bearer '}${provider.apiKey}`;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
  const response = await fetch(endpoint(provider, route), { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: combined, redirect: 'error' });
  if (!response.ok) throw new Error(`${provider.name} 返回 HTTP ${response.status}，请检查接口路径、授权和请求模板`);
  try { return await response.json(); } catch { throw new Error(`${provider.name} 未返回 JSON`); }
}
async function download(url, signal, extension = '.mp4') {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('模型输出必须是 HTTP(S) 文件地址');
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]) });
  if (!response.ok) throw new Error(`下载生成结果失败：HTTP ${response.status}`);
  const filename = `${id()}${extension}`; const dest = path.join(mediaRoot, filename); const handle = await fs.open(dest, 'w'); let bytes = 0;
  try { for await (const chunk of response.body) { signal.throwIfAborted(); bytes += chunk.length; if (bytes > 1024 * 1024 * 1024) throw new Error('生成文件超过 1 GB'); await handle.write(chunk); } }
  catch (error) { await handle.close(); await fs.rm(dest, { force: true }); throw error; }
  await handle.close(); if (!bytes) { await fs.rm(dest, { force: true }); throw new Error('生成文件为空'); } return `/media/${filename}`;
}
async function assetValue(provider, asset, signal) {
  if (!asset) return '';
  if (provider.protocol === 'comfyui') {
    const form = new FormData(); form.append('image', new Blob([await fs.readFile(localFile(asset.url))], { type: asset.mime }), path.basename(localFile(asset.url))); form.append('overwrite', 'false');
    const result = await request(provider, provider.uploadPath || '/upload/image', { body: form, signal });
    if (!result.name) throw new Error('ComfyUI 上传响应缺少 name');
    return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
  }
  if (provider.assetEncoding === 'url') {
    if (!provider.publicMediaBaseUrl) throw new Error('URL 素材模式需要可被模型服务访问的媒体根地址');
    return new URL(asset.url, provider.publicMediaBaseUrl).toString();
  }
  return assetData(asset);
}
export async function generate(provider, project, shot, signal, log, onRemote) {
  if (!provider.capabilities.includes(shot.mode)) throw new Error(`${provider.name} 不支持 ${shot.mode}`);
  if (provider.protocol === 'h3') return h3Generate(provider, project, shot, signal, log, onRemote);
  const selected = shot.referenceIds.map(id => project.assets.find(a => a.id === id)).filter(Boolean);
  const first = project.assets.find(a => a.id === shot.firstFrameId); const last = project.assets.find(a => a.id === shot.lastFrameId);
  if (shot.mode === 'REF2VA' && !selected.length) throw new Error('REF2VA 需要至少一个参考素材，请在分镜详情中选择');
  const context = { model: provider.model, prompt: generationPrompt(shot), negativePrompt: shot.negativePrompt || '', duration: shot.duration, aspectRatio: project.aspectRatio, seed: shot.seed ?? Math.floor(Math.random() * 2147483647), firstFrame: await assetValue(provider, first, signal), lastFrame: await assetValue(provider, last, signal), referenceImages: [], referenceVideos: [], referenceAudios: [], shotId: shot.id };
  for (const asset of selected) context[{ image: 'referenceImages', video: 'referenceVideos', audio: 'referenceAudios' }[asset.kind]].push(await assetValue(provider, asset, signal));
  if (provider.protocol === 'comfyui') return comfyGenerate(provider, context, signal, log, onRemote);
  const body = template(provider.bodyTemplate, context);
  let response = await request(provider, provider.submitPath, { body, signal });
  const map = provider.responseMap; let video = at(response, map.videoUrl); const jobId = at(response, map.jobId);
  if (jobId !== undefined && jobId !== null) onRemote(String(jobId));
  if (!video) {
    if (!jobId || !provider.pollPath) throw new Error('响应中没有视频地址或任务 ID，请核对响应映射与轮询路径');
    log(`远端任务已提交：${jobId}`);
    const until = Date.now() + (provider.timeoutSeconds || 1800) * 1000;
    while (Date.now() < until) {
      await delay((provider.pollIntervalSeconds || 5) * 1000, undefined, { signal });
      response = await request(provider, template(provider.pollPath, { jobId: encodeURIComponent(String(jobId)) }), { signal });
      const status = String(at(response, map.status) ?? '').toLowerCase();
      if ((map.failureValues || ['failed', 'error', 'cancelled']).includes(status)) throw new Error(`远端生成失败（${status}），可在供应商控制台查看原因`);
      video = at(response, map.videoUrl);
      if (video || (map.successValues || ['completed', 'succeeded', 'success']).includes(status)) break;
    }
    if (!video && provider.resultPath) { response = await request(provider, template(provider.resultPath, { jobId: encodeURIComponent(String(jobId)) }), { signal }); video = at(response, map.videoUrl); }
    if (!video) throw new Error('轮询超时或成功响应缺少视频地址；远端任务 ID 已保留，请先检查以避免重复扣费');
  }
  log('正在下载视频与原生音轨');
  const audio = at(response, map.audioUrl);
  return { videoUrl: await download(String(video), signal), audioUrl: audio ? await download(String(audio), signal, '.audio') : null };
}
async function h3Generate(provider, project, shot, signal, log, onRemote) {
  if (shot.duration < 4 || shot.duration > 15) throw new Error('MiniMax H3 单镜时长应为 4–15 秒');
  const selected = shot.referenceIds.map(id => project.assets.find(a => a.id === id)).filter(Boolean);
  const conditions = [];
  if (shot.mode === 'REF2VA') {
    if (!selected.length || selected.length > 12) throw new Error('H3 REF2VA 需要 1–12 个参考素材');
    for (const [kind, max] of [['image', 9], ['video', 3], ['audio', 3]]) {
      const assets = selected.filter(a => a.kind === kind); if (assets.length > max) throw new Error(`H3 ${kind} 参考最多 ${max} 个`);
      if (kind !== 'image' && (assets.some(a => !a.duration || a.duration < 2 || a.duration > 15) || assets.reduce((n, a) => n + a.duration, 0) > 15)) throw new Error(`H3 ${kind} 参考每段应为 2–15 秒，同类总时长最多 15 秒`);
    }
    for (const asset of selected) conditions.push({ type: asset.kind, uri: await assetValue(provider, asset, signal), role: 'reference' });
  } else {
    for (const [assetId, frameIndex] of [[shot.firstFrameId, 0], [shot.lastFrameId, -1]]) {
      if (assetId) { const asset = project.assets.find(a => a.id === assetId); if (!asset || asset.kind !== 'image') throw new Error('H3 首尾帧必须是图片'); conditions.push({ type: 'image', uri: await assetValue(provider, asset, signal), role: 'keyframe', frame_index: frameIndex }); }
    }
  }
  const body = { ...provider.extraBody, ...(provider.model ? { model: provider.model } : {}), task: shot.mode === 'FL2VA' && !conditions.length ? 't2va' : shot.mode.toLowerCase(), prompt: generationPrompt(shot), conditions, target: { short_edge: 768, ...provider.extraBody?.target, aspect_ratio: project.aspectRatio, duration_seconds: shot.duration }, seed: shot.seed ?? 0 };
  const result = await request(provider, '/videos', { body, signal });
  if (!result.id) throw new Error('H3 本地服务没有返回视频任务 ID'); onRemote(result.id); log(`H3 本地任务：${result.id}`);
  const until = Date.now() + (provider.timeoutSeconds || 1800) * 1000;
  while (Date.now() < until) {
    await delay((provider.pollIntervalSeconds || 3) * 1000, undefined, { signal });
    const resultStatus = await request(provider, `/videos/${encodeURIComponent(result.id)}`, { signal });
    if (['failed', 'error', 'cancelled'].includes(resultStatus.status)) throw new Error(`H3 生成失败：${resultStatus.status}`);
    if (resultStatus.status !== 'completed') continue;
    log('H3 生成完成，下载带原生音频的视频');
    const headers = { ...provider.headers }; if (provider.apiKey) headers[provider.authHeader || 'Authorization'] = `${provider.authPrefix ?? 'Bearer '}${provider.apiKey}`;
    const response = await fetch(endpoint(provider, `/videos/${encodeURIComponent(result.id)}/content`), { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]), redirect: 'error' });
    if (!response.ok) throw new Error(`H3 视频下载失败：HTTP ${response.status}`);
    const filename = `${id()}.mp4`; const dest = path.join(mediaRoot, filename); const handle = await fs.open(dest, 'w'); let bytes = 0;
    try { for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 1024 ** 3) throw new Error('视频超过 1 GB'); await handle.write(chunk); } }
    catch (error) { await handle.close(); await fs.rm(dest, { force: true }); throw error; }
    await handle.close(); return { videoUrl: `/media/${filename}`, audioUrl: null };
  }
  throw new Error('H3 本地任务超时，远端任务 ID 已保留，请检查服务状态');
}
function generationPrompt(shot) { return [shot.prompt, shot.sound && `Sound design (final direction): ${shot.sound}`, shot.dialogue && `Spoken dialogue (final direction): <d>[Chinese]${shot.dialogue}</d>`].filter(Boolean).join('\n\n'); }
async function comfyGenerate(provider, context, signal, log, onRemote) {
  if (!provider.bodyTemplate || !Object.keys(provider.bodyTemplate).length) throw new Error('请导入 ComfyUI API 格式 workflow，并将输入字段替换为模板变量');
  const workflow = template(provider.bodyTemplate, context);
  const result = await request(provider, '/prompt', { body: { prompt: workflow, client_id: id() }, signal });
  if (!result.prompt_id) throw new Error('ComfyUI 未接受工作流，请检查节点与模型安装情况');
  onRemote(result.prompt_id); log(`ComfyUI 排队中：${result.prompt_id}`);
  const until = Date.now() + (provider.timeoutSeconds || 1800) * 1000;
  while (Date.now() < until) {
    await delay((provider.pollIntervalSeconds || 3) * 1000, undefined, { signal });
    const history = await request(provider, `/history/${encodeURIComponent(result.prompt_id)}`, { signal }); const entry = history[result.prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new Error('ComfyUI 节点执行失败，请查看 ComfyUI 控制台');
    const outputs = Object.values(entry.outputs || {}).flatMap(o => [...(o.videos || []), ...(o.gifs || []), ...(o.images || [])]);
    const video = outputs.find(o => /\.(mp4|webm|mov|mkv)$/i.test(o.filename));
    if (video) {
      const view = `/view?${new URLSearchParams({ filename: video.filename, subfolder: video.subfolder || '', type: video.type || 'output' })}`;
      // Fetch through the configured origin with its credentials, never through a model-supplied host.
      const headers = { ...provider.headers }; if (provider.apiKey) headers[provider.authHeader || 'Authorization'] = `${provider.authPrefix ?? 'Bearer '}${provider.apiKey}`;
      const res = await fetch(endpoint(provider, view), { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]), redirect: 'error' });
      if (!res.ok) throw new Error(`ComfyUI 文件下载失败：${res.status}`);
      const filename = `${id()}${path.extname(video.filename)}`; const dest = path.join(mediaRoot, filename); const file = await fs.open(dest, 'w'); let total = 0;
      try { for await (const chunk of res.body) { total += chunk.length; if (total > 1024 ** 3) throw new Error('视频超过 1 GB'); await file.write(chunk); } } finally { await file.close(); }
      return { videoUrl: `/media/${filename}`, audioUrl: null };
    }
    if (entry.status?.completed) throw new Error('ComfyUI 已完成，但没有 MP4/WebM 输出，请增加保存视频节点');
  }
  throw new Error('ComfyUI 等待超时；远端任务仍可能运行，请检查后重试');
}
