# Frameflow · Agent 剧漫视频工作台

本地运行的完整工作台：**创作需求 → Responses 多模态理解 → 分镜与提示词 → MiniMax H3 / 自定义模型 → 带音轨 MP4 成片**。

## 启动

需要 Node.js 22+、FFmpeg 和 FFprobe，并将两者加入 PATH。

```powershell
git clone https://github.com/RozenScarlet/frameflow-studio.git
cd frameflow-studio
npm ci
npm run dev
```

也可以运行 `./start.ps1`。页面为 **http://127.0.0.1:5178**，本地 API 和素材服务为 **http://127.0.0.1:4387**。

```powershell
# 单进程运行构建版
npm run build
npm start
# 浏览 http://127.0.0.1:4387
```

服务只监听本机，不是已部署的多人在线服务。没有下载或启动 H3 权重，也没有预填任何真实密钥。

## 连接模型

在「模型」中添加配置，然后回「创作」为作品选择理解模型、FL2VA 与 REF2VA 模型并保存。

### 导演 Agent：OpenAI Responses API

- Base URL 填含 API 前缀的地址，例如 `http://127.0.0.1:8000/v1` 或自有网关地址。
- 请求路径默认为 `/responses`，Model ID 填网关实际支持的多模态模型。
- 使用 `instructions`、`input`、`input_text`、`input_image`，`store: false`、`stream: false`。
- 从 `output[].content[].type=output_text` 提取结果，允许 `reasoning` 与 `message` 混合输出，也兼容顶层 `output_text`。
- JSON 输出模式默认关闭；支持 `text.format` 的服务可在配置中开启。额外参数可填写 `reasoning`、`max_output_tokens` 等服务实际支持的字段。
- 图片以 Data URL 输入；每段参考视频提取 3 个关键帧。音频作为 REF2VA 的生成参考，**不声称通用 Responses 理解模型听过音频**。每次最多分析前 12 个素材。
- Agent 给出角色一致性设定、每镜画面、运镜、时长、声音、对白、完整提示词、素材绑定与调度理由；后端验证结构和素材 ID 后执行。

### 优先：MiniMax H3 本地 API

内置两个预设：

| 模式 | 默认 Base URL | 所需服务 |
| --- | --- | --- |
| FL2VA | `http://127.0.0.1:30010/v1` | H3 的 FL2VA 分区，含文生视频 |
| REF2VA | `http://127.0.0.1:30011/v1` | H3 的 REF2VA 分区 |

按 H3 官方 SGLang 服务合同实现：

1. `POST /v1/videos` 提交 `task`、`prompt`、`conditions`、`target`、`seed`。
2. `GET /v1/videos/{id}` 轮询任务状态。
3. 完成后 `GET /v1/videos/{id}/content` 下载带原生音频的视频。

无首尾图时自动用 `task: t2va`；有图片时用 `fl2va`，首帧 `frame_index: 0`、尾帧 `-1`；参考生成用 `ref2va`，传递 `image`、`video`、`audio` 类型以及 `reference` 角色。

预设为同机服务通过 `http://127.0.0.1:4387/media/...` 读取素材。H3 若在容器、WSL 或另一台机器，必须填写**H3 能访问的素材根地址**，或确认服务支持 Data URL 后切换；本工作台不会擅自开放公网或局域网监听。也可以自行建立只转发 `/media` 的代理。工作台只负责调用已部署的 H3，服务端实际加载什么权重由你的推理服务决定。

H3 单镜校验 4–15 秒；REF2VA 校验图片最多 9 张、视频/音频各最多 3 段、总文件最多 12 个，以及时长约束。同一 H3/ComfyUI 配置串行推理，减少同一 GPU 的并发压力。不同服务可以并行。

### 任意模型：可配置 HTTP 适配器

“任意”指不绑定模型厂商，可配置符合 JSON 提交/状态轮询/下载模式的接口；**不表示未知协议可免配置自动识别**。自定义签名、WebSocket 专有协议或非 JSON 提交，需要增加对应适配器。

支持提交路径、轮询路径、可选结果路径、任意 JSON 请求模板、响应字段映射、鉴权头、素材 Data URL/HTTP URL、完成/失败状态、轮询间隔与超时。

```json
{
  "model": "{{model}}",
  "prompt": "{{prompt}}",
  "duration": "{{duration}}",
  "first_frame": "{{firstFrame}}",
  "last_frame": "{{lastFrame}}",
  "images": "{{referenceImages}}",
  "videos": "{{referenceVideos}}",
  "audio": "{{referenceAudios}}"
}
```

整个字符串为模板变量时保留原类型（数字、数组等）；支持 `{{referenceImages.0}}`。字段路径用 `data.id`、`data.output.video_url`、`outputs[0].url`；轮询路径支持 `{{jobId}}`。输出视频和独立音轨地址必须是可下载 HTTP(S) URL。模板只做变量替换，不执行 JavaScript。

### ComfyUI

导入 **API 格式** workflow（非画布格式），把输入节点中的值替换为模板变量。素材默认经 `/upload/image` 上传，模板得到上传后的文件名；自定义媒体上传节点可根据实际工作流扩展适配器。使用 `/prompt`、`/history/{id}` 与 `/view` 获取结果。工作流必须配置能返回 MP4/WebM 等视频文件的保存节点；带音频视频需要在 workflow 中正确合入音轨。

## 使用

1. 写故事、选风格/比例/目标时长。
2. 素材库上传角色图、首尾帧、动作片段或音色参考。
3. 选择已配置的理解与生成模型，点击「让 Agent 规划分镜」。
4. 选中镜头，编辑提示词、声音、对白、时长、模型与素材引用。点击「保存修改」；更改生成内容会让该镜重新进入待生成状态。
5. 「全部生成」只处理未完成镜头；每镜也可单独重新生成。任务页显示步骤、失败与远端 ID。
6. 全部分镜完成后合成 MP4；或者从需求直接「一键成片」。支持下载独立 SRT 与完整分镜 JSON。

合成会统一 24 fps、画幅、H.264/AAC 双声道参数；短视频补末帧，长视频按分镜时长裁剪，无音轨片段补静音。保留模型原生对白/配乐；不会凭空生成额外 TTS 或 BGM。字幕根据每镜对白覆盖该镜时段，导出独立 SRT，不是逐字强制对齐或烧录字幕。

「演示全流程」使用固定示例剧本与 FFmpeg 生成的 **DEMO 测试画面**，无需模型，验证整个队列、视频生成文件、预览和合成链路；不代表真正的 AI 剧漫画面，也不会按自由输入理解需求。

## 数据、失败与恢复

- `.data/studio.json` 保存作品、素材引用、模型配置和任务记录，原子写入。
- `.data/media/` 保存原始素材、每镜视频、成片和字幕。移除作品引用不会删除原文件；目前无自动清理。
- API Key 与自定义 Headers 使用 AES-256-GCM 本地加密，密钥位于 `.data/secret.key`；备份要同时保留数据与此文件。拥有本机文件权限的用户仍可解密，这不是独立密钥管理服务。
- 密钥不返回浏览器、不会进入导出的分镜 JSON；所有本地运行数据均已被 `.gitignore` 排除。
- 同一作品只允许运行一个任务；成功镜头会在其他镜头失败时保留。
- 取消会停止本地请求、轮询与 FFmpeg，**不保证供应商或 ComfyUI 远端任务停止**；远端 ID 会保留。重试前检查供应商状态，以免重复推理/计费。
- 服务重启将运行中任务标记为“已中断”，不会自动重提到模型；不支持跨服务重启无缝恢复轮询。
- 这是单用户本地工作台。无账户/团队/计费模块，不应直接当作公网多租户服务。

## 结构与验证

```text
src/                  React 创作、素材、模型与任务界面
server/agent.mjs       Responses 理解与分镜规划
server/providers.mjs   H3 / 通用 HTTP / ComfyUI 适配器
server/jobs.mjs        编排、并发、取消、进度、失败处理
server/media.mjs       素材理解预处理、FFmpeg 合成、SRT
server/store.mjs       本地持久化
server/secrets.mjs     本地凭据加密
```

本次已通过生产构建、浏览器操作、模拟 Responses/H3/HTTP 的完整集成验证和真实 FFmpeg 合成；验证摘要见 [docs/verification.md](docs/verification.md)。**尚未连接真实 H3 GPU 服务或真实 Responses 服务**，因此没有真实模型质量、耗时或成本数据。ComfyUI 适配器仍需实际 workflow 联调。

## 合同来源

- [OpenAI Responses 官方快速入门](https://developers.openai.com/api/docs/quickstart)
- [MiniMax H3 官方模型与请求脚本](https://huggingface.co/MiniMaxAI/MiniMax-H3)
- [SGLang MiniMax H3 本地接口](https://docs.sglang.io/cookbook/diffusion/MiniMax/MiniMax-H3)
- [ComfyUI Server Routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [FFmpeg 官方合成说明](https://ffmpeg.org/faq.html#How-can-I-concatenate-video-files_003f)
