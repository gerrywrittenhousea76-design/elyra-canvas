# 可替换的模型 API

画布工具栏 → **API 设置**，分别配置 Agent 规划、图片生成与编辑、视频生成。每组有自己的协议、基础地址、模型、密钥、显示名称和预算占用。可在高级设置中指定密钥环境变量、认证方式、文件上传地址和视频结果域名。

保存只进行本地校验，不发起生成或探测请求。**重启本机服务后生效**；页面会同时显示当前生效的服务和待生效提示。现有画布、图片素材、视频素材及版本不随配置改变。

## 使用者接入步骤

1. 以 Node.js 22+ 运行项目：`npm install`，然后 `npm run dev`。正常服务默认地址为 `http://127.0.0.1:4175/#/workspace`。
2. 打开 API 设置，选择与供应商文档一致的协议。
3. 填写基础地址（例如 `https://api.example.com/v1`）、供应商实际模型 ID、API Key。不同角色可以使用不同供应商。
4. 如选择 EvoLink 异步任务协议，参考图上传地址要填到 `/api/v1`，服务会追加 `/files/upload/stream`。视频结果域名填实际文件 CDN 主机。
5. 根据供应商价格设置每次调用预算占用，保存后停止并重新运行本机服务。保存不证明供应商可用；用一项小任务验证真实账号权限和模型能力。

`npm run preview` 在 4318 端口运行**演练模式**。即使有已保存密钥，也禁止真实模型调用；本轮预览保持此模式。

已有工程按浏览器来源地址保存。如果要继续使用 4318 端口上的工程，先停止演练服务，再用 `PORT=4318 npm run dev` 启动正常服务，并使用同一浏览器和地址；不要切换端口后误以为原工程丢失。


## 内置协议与能力边界

| 角色 | 协议 | 实际请求与要求 |
| --- | --- | --- |
| Agent 规划 | `anthropic-messages` | `/messages`，支持 Anthropic 工具调用；可选 Bearer 或 x-api-key 认证 |
| Agent 规划 | `openai-chat` | `/chat/completions`，支持 function tools、强制 tool_choice；严格验证返回计划 |
| 图片 | `evolink` | `/images/generations` + `/tasks/{id}`；参考图先走配置的文件上传接口 |
| 图片 | `openai-images` | `/images/generations` JSON；`/images/edits` multipart；解析单张 b64_json 或 URL 结果 |
| 视频 | `evolink` | `/videos/generations` + `/tasks/{id}`；当前业务为单图生成 4 秒、横版或竖版 MP4 |

OpenAI Images 适配器要求模型支持 `model/prompt/size/quality/n` 和图片编辑。画布比例映射为 1024×1024、1536×1024、1024×1536；不是全部比例精确还原。不同兼容服务的模型支持范围可能不同。OpenAI 视频、Gemini 原生等其他协议目前需要自行注册适配器，不能仅改地址就假定兼容。

协议参考：[OpenAI Chat](https://developers.openai.com/api/reference/resources/chat)、[OpenAI Images](https://developers.openai.com/api/reference/resources/images)。本轮使用固定协议响应和真实 PNG 解码验证适配层，没有发起真实付费调用。

## 密钥与生效规则

- 服务端配置位于 `.elyra-runtime/provider-settings.json`，原子写入，文件权限 0600；已排除 Git 和前端文件服务。它是本机私有配置文件，不是加密保险箱，不要分享整个运行目录。
- GET 设置接口只返回 `hasKey`，不返回密钥；密钥不进入 localStorage、IndexedDB、工程导出或模型错误返回。密码输入框留空保留原配置；“清除已保存的密钥”同时解除环境变量引用。
- 更换协议、地址或认证方式时，页面清除旧密钥及旧环境变量引用。服务端也会清除跨目的地继承的密钥；需要重新指定新服务凭据。
- 运行中的适配器使用启动时的配置。EvoLink 兼容任务 ID 绑定服务地址、模型和账号；换配置后不能将旧任务转交新服务。已下载素材继续可用。升级前旧格式待运行任务须在原服务完成，不会冒险跨服务恢复。
- OpenAI 同步图片任务的临时结果保留在本进程内一小时；服务重启后不会重新提交旧任务。已经保存到本地工程的素材不受影响。
- 开发服务仅面向本机单用户。公开部署或多人共享前仍需账号权限、独立凭据存储和部署级访问控制。

也可使用环境变量初始化（已有保存文件优先）：

```sh
export ELYRA_PLANNER_PROTOCOL=openai-chat
export ELYRA_PLANNER_BASE_URL=https://api.example.com/v1
export ELYRA_PLANNER_MODEL=your-tool-capable-model
export ELYRA_PLANNER_KEY_ENV=MY_PLANNER_API_KEY
export MY_PLANNER_API_KEY=your-key
npm run dev
```

三个前缀分别为 `ELYRA_PLANNER_`、`ELYRA_IMAGE_`、`ELYRA_VIDEO_`；支持后缀 `PROTOCOL`、`LABEL`、`BASE_URL`、`FILES_BASE_URL`、`MODEL`、`AUTH`、`KEY_ENV`、`RESERVATION_USD`、`RESULT_HOSTS`。`RESULT_HOSTS` 为逗号分隔域名；环境变量密钥引用名称以 `_API_KEY` 结尾。不要使用 `VITE_` 保存密钥。旧 `EVOLINK_API_KEY` 仍是默认配置的凭据来源。

## 添加新协议

扩展入口 `server/provider-plugins.mjs`。注册可信服务端工厂，启动后自动出现在对应角色的协议菜单中：

```js
import { createMyImageAdapter } from './my-image-adapter.mjs';
export const providerPlugins = {
  planner: {},
  image: { 'my-image-api': createMyImageAdapter },
  video: {},
};
```

工厂接收 `{ settings, readKey, fetchImpl, namespace }`。调用前使用 `await readKey()`；请求使用提供的 `fetchImpl`，这样演练模式仍禁止网络调用。禁止从浏览器输入模块路径或执行脚本。

图片/视频适配器返回 `{ client, resolveResult }`：

- `client.createImageJob`、`createImageEditJob`、`createUploadedReferenceEditJob` 或 `createVideoJob`：按所支持角色实现，返回 `{ id: 'task-unified-...', status: 'pending' }`。
- `client.uploadReferenceImage({buffer,mimeType,filename,signal})`：返回服务端私有 `{fileUrl,httpStatus,retryCount}`。无单独上传接口时可像 OpenAI 适配器那样暂存净化后的字节，在生成接口直接提交。
- `client.getTask(id,{signal})`：返回相同 ID 与 `pending/processing/completed/failed` 状态，不能向前端透传密钥或原始响应。
- `resolveResult(task,options)`：图片应复用 `sanitizeProviderResultImage` 或 `resolveProviderResultImage`，返回验证后的 PNG 字节、尺寸、哈希；视频需验证 MP4 容器和当前 4 秒/尺寸边界，返回字节与元数据。
- 外部任务标识需绑定 `namespace`，防止用户切换账号或供应商后错误恢复。不要对不确定是否已提交成功的生成请求自动重试。

规划适配器返回 `{createClient(options)}`，客户端实现 `createPlan(input)`、`getBudgetStatus()`，保持现有 Intent/Plan schema、操作白名单、请求授权和账本约束。内置 `createPlannerAdapter` 展示了两个不同传输协议如何复用同一计划校验层。

旧前端 provider ID 保留为兼容的业务槽位 ID，实际目的地由角色配置决定。无需迁移 Asset、Version、Job 或 CanvasObject。更换服务不修改这些数据。

## 验收与费用

`server/provider-adapters.test.mjs` 覆盖私密存储、跨地址密钥清除、配置冲突、协议请求映射、真实 PNG 解码与本地结果、重复提交拦截、错误响应清理、旧任务隔离、自定义协议注册及同源写入。

每次调用预算占用是操作者配置的保守记录，不是供应商账单。规划使用此数值计入账本，不再把其他模型按旧 Claude 单价估算；图片/视频和前端发送授权也使用各自配置值。总里程碑上限仍是 5 美元。实际供应商扣费仍取决于供应商计价；不得将本地预算记录视为远端硬限额。
