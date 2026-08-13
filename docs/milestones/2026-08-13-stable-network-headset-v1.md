# 稳定里程碑：Network Headset V1

## 回退标识

- 日期：2026-08-13（Asia/Shanghai）
- 稳定提交：`dfb619e0ebe7b98850c4ea92aeac3b62cccc4aaa`
- 短提交：`dfb619e`
- Git 标签：`stable-network-headset-v1-2026-08-13`
- 提交标题：`Milestone: stable network headset baseline`

标签固定指向上述提交，不得移动或复用。未来的稳定版本必须创建新提交和新标签。

## 用户确认的基线

用户在真实设备使用后确认：“现在这个版本的基础功能已经很舒服了”，并要求将其作为后续出现回归时的稳定回退点。

本里程碑冻结以下整体状态：

- 通用浏览器可访问公网前端、登录/配对、查看真实设备并连接或断开目标 Mac。
- 浏览器作为网络耳麦，通过常驻 WebRTC/LiveKit 会话向 Mac 提供麦克风，并接收 Mac 系统音频。
- Mac Bridge 使用原生 CoreAudio、AudioUnit 与 ring buffer；生产实时路径不再依赖 FFmpeg。
- 连接动作建立媒体链路并通过 `Control+Shift+V` 启动 Codex Voice；断开动作关闭该会话的媒体与 Voice 并清理资源。
- 前端保持已确认的紧凑语音交互结构、圆形 PTT、设备真实状态和刷新恢复逻辑。
- Nginx 公网子路径同时支持带或不带尾斜杠，避免 308 循环。
- 项目资源生命周期、可观测性约束和已知故障流程已经写入项目宪法与故障库。

“稳定”表示这是用户确认舒适、可作为回退点的基础功能组合，不表示 [`../known-issues/README.md`](../known-issues/README.md) 中所有“已实施待复验”项目都已经独立验收。

## 创建里程碑时的检查

以下静态检查均通过，且没有建立媒体会话、触发 Codex Voice 或播放模拟音频：

- `apps/mac-bridge`: `npm run typecheck && npm run build`
- `apps/pwa`: `npm test`
- `services/control-api`: `npm run typecheck && npm run build`
- 公网页面带/不带尾斜杠均为 HTTP 200、0 次重定向；核心前端资源为 HTTP 200。

## 安全回退方式

先保存当前未提交改动，再从稳定标签创建独立恢复分支：

```bash
git switch -c recovery/stable-network-headset-v1 stable-network-headset-v1-2026-08-13
```

不要为了回退直接执行 `git reset --hard`，也不要覆盖用户未提交的工作。确认恢复分支后，按 `AGENTS.md` 的静态检查和发布纪律重新构建、部署项目组件；不得重启 Codex 主应用或服务器上的无关服务。

## 回归比较规则

出现新问题时先检索已知故障库，再将当前版本与此标签比较：

```bash
git diff stable-network-headset-v1-2026-08-13...HEAD
```

优先定位引入回归的最小边界，不应直接丢弃稳定里程碑之后的全部改动。
