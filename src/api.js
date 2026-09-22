export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' }, body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '请求失败'); return data;
}
export const statusLabel = { draft: '待生成', queued: '排队中', generating: '生成中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
export const typeLabel = { plan: 'Agent 分镜规划', generate: '分镜生成', compose: '视频合成', pipeline: '自动制片' };
export const roleLabel = { character: '角色参考', scene: '场景参考', first: '首帧', last: '尾帧', voice: '音色参考', motion: '动作参考' };
