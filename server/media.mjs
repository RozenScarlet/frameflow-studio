import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mediaRoot, localFile, id } from './store.mjs';
export const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
export function run(binary, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, signal }); let output = '', errors = '';
    child.stdout.on('data', d => { output = (output + d).slice(-1000000); });
    child.stderr.on('data', d => { errors = (errors + d).slice(-6000); });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${path.basename(binary)} 执行失败 (${code}): ${errors.slice(-1800)}`)));
  });
}
export async function probe(file, signal) { return JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], signal)); }
export async function health() { try { await run(ffmpeg, ['-version']); await run(ffprobe, ['-version']); return true; } catch { return false; } }
export async function assetData(asset) { const data = await fs.readFile(localFile(asset.url)); if (data.length > 24 * 1024 * 1024) throw new Error('单个内嵌素材不能超过 24 MB，请使用 URL 模式或 ComfyUI 上传'); return `data:${asset.mime};base64,${data.toString('base64')}`; }
export async function analyzeMedia(asset, signal) {
  if (asset.kind === 'image') return [{ type: 'image_url', image_url: { url: await assetData(asset) } }];
  const source = localFile(asset.url);
  if (asset.kind === 'audio') {
    const temp = path.join(mediaRoot, `${id()}.wav`);
    try { await run(ffmpeg, ['-y', '-i', source, '-t', '30', '-ar', '24000', '-ac', '1', temp], signal); return [{ type: 'input_audio', input_audio: { data: (await fs.readFile(temp)).toString('base64'), format: 'wav' } }]; } finally { await fs.rm(temp, { force: true }); }
  }
  const info = await probe(source, signal); const duration = Number(info.format.duration) || 3; const parts = [];
  for (const fraction of [0.05, 0.5, 0.9]) {
    const temp = path.join(mediaRoot, `${id()}.jpg`);
    try { await run(ffmpeg, ['-y', '-ss', String(duration * fraction), '-i', source, '-frames:v', '1', '-vf', 'scale=640:-2', temp], signal); parts.push({ type: 'text', text: `视频 ${asset.name}，时间 ${(duration * fraction).toFixed(1)} 秒` }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${(await fs.readFile(temp)).toString('base64')}` } }); } finally { await fs.rm(temp, { force: true }); }
  }
  return parts;
}
export async function makeDemo(shot, index, signal) {
  const filename = `${id()}.mp4`; const colors = ['0x314052', '0x58434a', '0x3f4b45', '0x5b4b3b'];
  await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=${colors[index % 4]}:s=960x540:r=24`, '-f', 'lavfi', '-i', `sine=frequency=${220 + index * 55}:sample_rate=48000`, '-t', String(shot.duration), '-vf', `drawgrid=w=120:h=90:t=1:c=white@0.08,drawtext=text='DEMO  /  SHOT ${index + 1}':fontcolor=white:fontsize=38:x=(w-tw)/2:y=(h-th)/2`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-af', 'volume=0.06', '-movflags', '+faststart', path.join(mediaRoot, filename)], signal);
  return `/media/${filename}`;
}
export async function compose(project, signal, progress) {
  if (!project.shots.length || project.shots.some(s => s.status !== 'completed' || !s.videoUrl)) throw new Error('所有分镜完成后才能合成');
  const [width, height] = project.aspectRatio === '9:16' ? [720, 1280] : project.aspectRatio === '1:1' ? [960, 960] : [1280, 720];
  const temps = []; const normalized = []; const token = id();
  try {
    for (let i = 0; i < project.shots.length; i++) {
      signal.throwIfAborted(); const shot = project.shots[i]; const source = localFile(shot.videoUrl); const info = await probe(source, signal);
      const dest = path.join(mediaRoot, `${token}-${i}.mp4`); temps.push(dest);
      const inputs = ['-i', source]; let audioIndex = '0:a:0';
      if (shot.audioUrl) { inputs.push('-i', localFile(shot.audioUrl)); audioIndex = '1:a:0'; }
      else if (!info.streams.some(s => s.codec_type === 'audio')) { inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'); audioIndex = '1:a:0'; }
      await run(ffmpeg, ['-y', ...inputs, '-map', '0:v:0', '-map', audioIndex, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=${shot.duration}`, '-af', 'aresample=48000,apad', '-t', String(shot.duration), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', dest], signal);
      normalized.push(dest); progress(Math.round(((i + 1) / (project.shots.length + 1)) * 100), `已统一第 ${i + 1} 镜的画幅、帧率与音轨`);
    }
    const list = path.join(mediaRoot, `${token}.txt`); temps.push(list); await fs.writeFile(list, normalized.map(p => `file '${path.basename(p)}'`).join('\n'));
    const filename = `${id()}.mp4`;
    await run(ffmpeg, ['-y', '-f', 'concat', '-safe', '1', '-i', list, '-c', 'copy', '-movflags', '+faststart', path.join(mediaRoot, filename)], signal);
    const srtName = filename.replace('.mp4', '.srt'); let offset = 0; const subtitles = [];
    const stamp = value => new Date(Math.round(value * 1000)).toISOString().slice(11, 23).replace('.', ',');
    project.shots.forEach(s => { if (s.dialogue) subtitles.push(`${subtitles.length + 1}\n${stamp(offset)} --> ${stamp(offset + s.duration)}\n${s.dialogue}\n`); offset += s.duration; });
    await fs.writeFile(path.join(mediaRoot, srtName), subtitles.join('\n'));
    return { url: `/media/${filename}`, subtitleUrl: `/media/${srtName}`, duration: offset, demo: project.shots.some(s => s.demo), createdAt: new Date().toISOString() };
  } finally { await Promise.all(temps.map(p => fs.rm(p, { force: true }).catch(() => {}))); }
}
