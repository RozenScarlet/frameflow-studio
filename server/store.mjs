import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const root = path.resolve(process.env.DATA_DIR || '.data');
export const mediaRoot = path.join(root, 'media');
fs.mkdirSync(mediaRoot, { recursive: true });
const dbFile = path.join(root, 'studio.json');
export const id = () => randomUUID();
export function newProject(name = '未命名作品') {
  return { id: id(), name, brief: '', style: '电影感日系动画', aspectRatio: '16:9', targetDuration: 24, plannerId: '', fl2vaId: '', ref2vaId: '', shots: [], assets: [], characters: [], messages: [], output: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
export const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : { projects: [], providers: [], jobs: [] };
if (!db.projects.length) {
  const project = newProject('雨停之前');
  project.brief = '做一部 24 秒的日系动画短片。雨夜的旧书店即将关门，一位带着红伞的少女收到十年前的自己寄来的信。她循着信里的地址走过霓虹街道，在天台看见雨停后的第一道曙光。温柔、悬疑，最后留一点希望。保持少女的脸、短发和红伞一致，加入雨声与克制的钢琴声。';
  db.projects.push(project);
}
for (const job of db.jobs) if (['queued', 'running'].includes(job.status)) { job.status = 'interrupted'; job.error = '服务重启，任务已中断。请检查远端任务后重试。'; }
for (const project of db.projects) for (const shot of project.shots) if (['queued', 'generating'].includes(shot.status)) { shot.status = 'interrupted'; shot.error = '服务重启后中断'; }
export function save() { const tmp = `${dbFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, dbFile); }
export function touch(project) { project.updatedAt = new Date().toISOString(); save(); }
export function localFile(url) {
  if (typeof url !== 'string' || !/^\/media\/[a-zA-Z0-9_.-]+$/.test(url)) throw new Error('不是有效的本地素材地址');
  return path.join(mediaRoot, url.slice(7));
}
save();
