# dsh-worktable 工作台

> DeepSeek Harness（DSH）侧边栏的 **agent 级项目容器** —— 一个把「项目、会话、窗口、产物」收进同一个抽屉的工作台插件。
> 本仓库同时是 **ACE workbench** 的载体：ACE 那份说明保留在 [`README.ace.md`](./README.ace.md)。

## 这是什么

工作台把 DSH 侧边栏变成一层「应用抽屉」：每个项目 = 一张卡片，点开就是一套**可自由分栏的工作区**（左栏/顶行/主行 + 右侧对话），窗口里可以放网页、动画站、资源管理器、终端、控制室看板、地球旅行、数字人……项目与对话绑定，agent 的产出可以自动挂进指定窗口。

**纯增量插件**：不替换、不禁用任何官方插件，所有状态只写 localStorage。

## 安装

```sh
dsh plugin --profile web add github:Hans-ux-pang/deepseek-harness-ACG-workstation
```

装完**重启 dsh web** 并刷新页面（bundle 层在启动时组合）。

## 主要功能

| 能力 | 说明 |
|---|---|
| 分栏工作区 | 顶行 / 左栏 / 主行 / 聊天窗自由组合，分隔线可拖，布局按项目持久化 |
| 项目卡片 | 侧栏卡片 = 项目入口；图标、名称、排序、隐藏、快捷方式可管理 |
| 对话绑定 | 项目 ↔ 会话绑定；打开项目自动切到它的对话，切走 = 自动关项目 |
| 项目文件夹 | 新建项目强制指定父目录，agent 产出落进项目文件夹 |
| 自动挂载 | agent 写完 `widget-result.json`，产物自动挂进对应窗口（锁定窗格，不丢不乱） |
| 控制室 | 卡片网格看板：每张卡显示状态三色光效（待机/工作/完成/待决）、运行时长、最近消息 |
| 内置窗口 | 浏览器 / 动画 / 资源管理器 / 源代码管理 / 任务 / 终端 / 控制室 / 地球旅行 / 数字人 |
| 数字人 🎙 | 形象（内置 6 条素材，可换媒体库素材）、待机/思考/说话状态、7 组声线朗读、语音对话（说话即打断）、悬浮小窗（可拖可缩） |
| 原生皮肤 | `template/dshell.css` 设计系统，供 agent 生成的 HTML 直接引用 |
| 影视壁纸 / 动效 | 视频壁纸多档码率 + Range 流、极光/星云/蝶翼等可关的动效层 |

## 目录

```
.                     插件包根（package.json / cordis.patch.yml / dsh.plugin.json）
├─ src/index.ts       服务端：健康路由、文件/目录/git/终端/壁纸媒体/数字人清单与语音合成
├─ src/client/        客户端：分栏引擎、控制室、资源管理器、终端、地球、数字人…
├─ lib/               构建产物（lib/index.js + lib/client.js，随包分发）
├─ template/          原生皮肤模板（dshell.css / dshell.html）
└─ data/              地球海岸线与地点数据
```

## 开发

```sh
cd .            # 仓库根即插件包
npm install
npm run build   # lib/index.js + lib/client.js
npm run check   # 语法自检
npm run test:gate   # 客户端工厂求值门禁（10 例）
npm run pack    # 发布打包：结构断言 + 独立目录安装 + 双资产哈希
```

## 平台与边界

- **Windows 为完整验证平台**；macOS 为实验性（路径代码已跨平台，未真机端到端）。
- 数字人的**形象素材不进包**：放在 `<DSH_HOME>/worktable-media/dh-*.mp4`，随机器安装。
- 数字人语音：朗读主路径 = **宿主本机语音合成**（Windows SAPI → WAV），浏览器语音仅兜底；
  语音输入用宿主内置识别（零安装、零模型）。**不含**麦克风 VAD / 口型生成 / 声音克隆。

## 许可证

MIT（见 [LICENSE](./LICENSE)）。
