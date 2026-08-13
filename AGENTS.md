# Codex Live Remote 项目开发宪法

本文件是本项目唯一的工程约束入口。它只保留稳定的产品契约、架构决策、生命周期、工程纪律和运行事实。具体事故、排查证据与处理记录统一维护在 [`docs/known-issues/README.md`](docs/known-issues/README.md)。其他文档与本文件冲突时，以本文件为准；用户的新明确指令优先级最高。

## 1. 产品契约

- 产品是一个通用的“网络耳麦”：任何具备标准音频输入与播放能力的现代浏览器，都可以把手机或平板变成 Mac 的远程麦克风与耳机。不得将产品限定为华为浏览器或特定 PWA 容器。
- 用户连接一台 Mac 时，产品依次建立网络音频链路并启动 Codex Voice；网络耳麦是核心能力，启动 Codex Voice 是叠加其上的独立控制动作。
- 当前 MVP 只交付稳定的双向实时语音与设备连接。不得自行扩展音频转写、文字注入、Codex App Server、任务生命周期、Hooks、远程审批或其他智能体能力。
- 桌面目标是 **Codex Desktop / Codex Voice**，bundle identifier 为 `com.openai.codex`。当前应用路径 `/Volumes/storage/Applications/ChatGPT.app` 以及代码中的 GPT/ChatGPT 历史命名不改变产品目标。
- Bridge 不是智能体：不得读取 Codex 任务，不得使用 OpenAI API、Cookie 或 API Key，不得接管 Codex 账号或任务生命周期。
- 单个浏览器客户端同一时刻只连接一个目标 Mac；每台 Mac 同一时刻只保留一个有效远程媒体会话。账号可绑定并展示多台设备。

## 2. 权威架构

### 2.1 控制面

浏览器与 Mac Bridge 都主动连接阿里云 Control API；Mac 不开放入站端口。Control API 负责邮箱验证码登录、账号与设备绑定、配对码、设备在线状态、会话映射和启停指令。扫码或配对码只负责把设备绑定到已登录账号，不能替代账号认证。

### 2.2 媒体面

- 上行：浏览器麦克风 → LiveKit/WebRTC → 阿里云 SFU → Mac Bridge → CoreAudio → `BlackHole 2ch` → macOS 系统默认输入 → Codex Voice。
- 下行：Mac 系统音频 → CoreAudio process tap → Mac Bridge → LiveKit/WebRTC → 浏览器音频输出。
- Control WebSocket 与 WebRTC 媒体是两条独立链路。控制通道短暂重连不得拆除仍健康的媒体房间。
- 远程会话启用期间，下行 process tap 使用远程独占语义：音频发送到浏览器，不同时在 Mac 本地硬件重复播放。

### 2.3 运行拓扑

- 公网入口：`https://8.137.116.27:9443/gpt-live-remote`
- Control API：服务器 `127.0.0.1:8787`，systemd `gpt-live-control.service`
- Web 前端：服务器 `127.0.0.1:8790`，systemd `gpt-live-pwa.service`
- LiveKit：服务器 `127.0.0.1:7880`，经公网 `/rtc` 与已配置媒体端口提供服务
- Mac Bridge LaunchAgent：`/Users/mono01/Library/LaunchAgents/com.gpt-live-remote.bridge.plist`
- Mac Bridge 生产命令：`/Volumes/storage/home/.hermes/node/bin/node /Volumes/storage/Projects/Codex Live/apps/mac-bridge/dist/index.js`
- 服务器上的项目 Nginx 必须使用独立 access/error log；不得停止或修改阿里云上任何无关服务。

## 3. 核心技术决策

- 浏览器与公网媒体采用标准 WebRTC；LiveKit 负责房间、SFU、Opus、网络抖动与轨道管理。
- 生产实时音频链路禁止 FFmpeg、stdin/stdout PCM pipe、外部音频子进程和 Promise/`Buffer.concat` 帧队列。FFmpeg 只能用于离线诊断、录音或格式验证。
- Mac Bridge 使用 N-API 原生模块、CoreAudio AudioUnit 和固定容量 ring buffer 直接搬运 PCM。实时 callback 只允许固定内存拷贝或轻量格式转换，不得动态分配、写日志或执行异步任务。
- 手机 → Mac 使用 48 kHz mono；写入 `BlackHole 2ch` 时明确复制到设备声道。Mac → 手机使用 48 kHz stereo，LiveKit 以系统/屏幕共享音频发布，显式设置适合系统音频的 Opus bitrate，并关闭 DTX。
- process tap 必须排除 Bridge 自身的 phone playout，避免手机上行、Codex 回复或 Bridge 播放再次进入下行形成回路。
- 临时 system-capture aggregate device 每会话使用唯一 UID，原生层按本次返回的 AudioObjectID/UID 绑定，禁止按可重复的人类名称或 AVFoundation 索引选设备。启动前可清理 UID 前缀 `com.gpt-live-remote.system-capture.` 的崩溃遗留。
- 必须读取并记录真实 ASBD，包括 sample rate、Float32/Int16、interleaved/non-interleaved、channel count、bytes per frame 和 frames per packet；全链路只做一次明确的必要转换。
- Bridge 不增加 gain、AGC、降噪、回声消除、转写或其他 DSP。浏览器采集可使用浏览器标准 AEC/NS/AGC。

## 4. 业务与资源生命周期

所有资源必须有唯一所有者、明确创建点、单次幂等释放路径和可观测的终止结果。不得依靠进程退出、垃圾回收或下一次连接覆盖旧资源。

### 4.1 浏览器会话

- 一个媒体会话只拥有：一个 `LocalAudioTrack`、一个 LiveKit `Room`、一个 `AudioContext`、一个远端 audio element，以及对应 analyser、计时器和控制 WebSocket。
- 设备连接时一次性授权麦克风、创建并发布轨道。连接期间 WebRTC 房间和轨道常驻；按住说话只 `unmute`，松开只 `mute`，不得 stop、unpublish、重建轨道、重协商或重启 Bridge 输出。
- 控制 WebSocket 非终止性断开时只重连控制面。关闭码或服务器状态明确表示会话终止时，才释放媒体面。
- 明确断开、终止性 Room 关闭或服务器判定会话结束时，必须成对执行：停止 PTT → unpublish → Room disconnect → track stop → analyser disconnect → AudioContext close → audio detach → 清理 heartbeat、stats 与 reconnect timer。
- 页面刷新后先向服务器查询 active session 并恢复真实页面；不得仅依赖内存 UI 状态。设备列表刷新必须读取服务器真实设备和会话状态。

### 4.2 服务器会话

- 每台设备只允许一个有效 Bridge WebSocket；新连接替换旧连接。旧连接的迟到 `ready`/`failed` 不得复活已经停止的会话。
- 每个设备只允许一个 starting/ready 会话。新启动必须明确终止或替换旧会话，不能产生并行媒体所有者。
- Bridge 断开时，仍处于 starting/ready 的会话必须被标记 stopped。
- 手机控制连接暂时归零时保留媒体会话，进入 10 分钟恢复窗口；手机重新连接即取消回收计时。窗口到期仍无客户端时，服务器标记 stopped、通知 Bridge，并关闭该会话的剩余手机 socket。
- 显式断开不进入恢复窗口，立即向 Bridge 下发 stop；重复 stop 必须幂等。

### 4.3 Mac Bridge 会话

- 每个 `MacAudioBridge` 只属于一个 session，持有唯一 LiveKit Room/AudioStream/AudioSource/发布轨道、上下行 AudioUnit、ring buffer、process tap、临时 aggregate/helper 和系统默认设备快照。
- 启动顺序固定为：关闭旧会话 → 建立媒体与 CoreAudio → 切换系统默认输入 → 启动并验证 Codex Voice → 回报 ready。媒体未就绪不得触发 Voice。
- 停止、启动失败、LiveKit 意外断开、helper 退出、控制通道关闭、SIGINT 或 SIGTERM 都必须汇入同一幂等清理路径：停止 callback/pump → 关闭 AudioUnit/ring → 取消流与发布 → 断开 Room → 销毁 tap/aggregate/helper → 按 input → output → system output 恢复会话前系统默认设备。
- 若已尝试启动 Codex Voice 但后续步骤失败，必须回滚 Voice；正常断开和 Bridge 退出也必须关闭由该会话启动的 Voice。不得重启或退出 Codex 主应用。
- 生产环境只允许一个由 LaunchAgent 管理的直接 Node 进程。不得以 `tsx src/index.ts` 运行生产 Bridge，不得遗留 E2E、helper 或孤立子进程。

### 4.4 Codex Voice

- 用户确认的 Voice chat hotkey 是 `Control+Shift+V`。Bridge 必须通过原生 CoreGraphics HID `send-hotkey` 触发，禁止使用 AppleScript `keystroke`，禁止回退到切换 Chat、创建新任务或 `Command+N`。
- Voice 是否真正启动以 `audio-device.swift process-io com.openai.codex` 的 CoreAudio 输入状态为准，不以窗口标题、启动音、UI 波形或“是否主动打招呼”为准。
- 不得重启 Codex。只有在刷新系统音频设备缓存确有必要且用户允许时，才可单独重启 Codex Chromium AudioService helper。

## 5. 认证、安全与数据边界

- 账号使用邮箱验证码登录；只有登录账号可见其绑定设备。设备通过 Mac 显示的短期配对码/二维码绑定，配对凭证必须过期且只使用一次。
- 设备 secret、会话 token、邮箱验证码、Cookie 和授权头不得写入日志。服务端日志必须做字段脱敏。
- 公网只允许 TLS/WSS/WebRTC 安全传输；Mac 与手机均主动出站连接。服务器不得录制或持久化用户音频。
- 当前前端只展示产品必要状态；不得混入 Codex 内部事件、status complete、任务生命周期或其他会话内容。

## 6. UI 稳定契约

- 保留现有紧凑深绿色移动端结构：登录/配对、真实设备列表、连接中的语音页。除非用户明确要求，不做整体重设计。
- 语音按钮是常驻底部的圆形 floating icon button；长按区域与相关文本禁止选择。按住时三点波形必须来自同一真实输入电平，且限制最大高度。
- 图标按钮无外框、点击反馈一致、图标视觉尺寸一致，不增加单独的“启用音频”页面或按钮。
- Live 页顶部设备名称只打开在线设备 source dropdown；选择另一设备时先完整停止当前 session，再建立新 session。返回设备管理使用独立的回退按钮，不得复用设备下拉或整页跳转。
- 音频输出按钮优先调用浏览器标准 `selectAudioOutput`/`setSinkId` 选择系统暴露的扬声器、听筒或蓝牙设备；浏览器不支持时明确交由手机系统音频面板管理，禁止展示不能实际生效的伪设备选项。
- 麦克风未授权、拒绝或授权等待超时必须与媒体连接超时区分；先回收失败 session，再由新的用户手势重新请求权限，成功后创建全新的正式会话。
- 已连接设备显示“已连接”并可断开；用户主动断开不显示“连接已断开，请重新连接设备”。刷新或恢复后仍停留在与服务器真实会话相符的页面。
- 面向普通用户只显示可行动的连接/权限/播放错误，不展示内部协议、计数器或诊断噪声。

## 7. 可观测性与诊断纪律

- 每个会话在浏览器、Control API、Bridge、CoreAudio、BlackHole/Codex 边界和浏览器播放日志中使用相同 session ID。
- 上行必须可区分：PTT 与 track 状态 → outbound RTP packets/bytes → Bridge PCM frames/peak → output ring fill/underflow/overflow → AudioUnit render frames/OSStatus → BlackHole UID/ASBD/alive → Codex process input。
- 下行必须可区分：process tap UID/ASBD → capture callback frames/peak → capture ring → LiveKit submitted frames/queue → inbound RTP packets/bytes → track subscription → audio element play/blocked/error。
- 日志按有界周期输出计数器和增量，不得逐 10 ms 帧打印。设备创建、默认设备切换、OSStatus 错误、设备断开、资源销毁和系统默认恢复必须单独记录。
- 单个边界的“成功”不能证明端到端成功：进程存活、轨道存在、波形变化、`input=true`、连接音或启动音都不是对话通过的证据。
- 新问题必须先按边界定位，禁止凭 UI 文案猜测。先检索 [`docs/known-issues/README.md`](docs/known-issues/README.md)，再检查当前会话两侧计数器；只有证据相同才复用已有处理方式。

## 8. 工程与发布纪律

- 变更必须小而完整地修正一个架构边界或生命周期，不得用额外状态机、延时、重试或降噪掩盖根因，不得继续堆叠补丁。
- 修改前阅读相关资源的创建、正常结束、失败、重连、刷新和进程退出路径；新增资源时必须同时实现所有释放路径和日志。
- 保留用户已有改动，不修改无关文件。部署只重启本项目组件，禁止停止、重启或重新配置无关服务器服务与 Codex 主应用。
- 静态检查允许执行：
  - `apps/mac-bridge`: `npm run typecheck && npm run build`
  - `apps/pwa`: `npm test`
  - `services/control-api`: `npm run typecheck && npm run build`
- 除非用户当轮明确授权，不运行模拟音频、连接、Voice、端到端或主动播放测试。真实手机与 Codex 的功能验收由用户执行。
- 发布后必须检查项目服务状态、Nginx 配置语法、单一 Bridge 进程和无遗留 helper/E2E 进程。只读 HTTP/状态检查不应创建媒体会话或触发 Voice。
- 任何故障处理完成后都要更新已知故障库：写明症状、边界证据、根因、处理方式、验证级别和适用版本；构建通过不能标记为真实设备已确认。

## 9. 稳定里程碑制度

- 只有用户基于真实设备明确确认当前整体版本稳定、舒适或可作为回退点时，才能创建稳定里程碑；智能体不得仅凭构建或局部日志自行宣布稳定版本。
- 里程碑先形成一个只包含完整可运行基线的功能提交，排除本机构建产物、凭据、临时文件和无关草稿；通过本文件规定的静态检查后，为该提交创建不可移动的 annotated tag。
- 标签使用 `stable-<能力>-v<序号>-<YYYY-MM-DD>`，一经推送不得移动、删除或复用。后续稳定状态必须创建新提交和新标签。
- 每个标签在 `docs/milestones/` 建立独立记录，至少包含：完整 commit ID、tag、用户确认原话/范围、冻结能力、尚未独立验收的已知项、创建时检查和安全回退方式。里程碑说明可作为标签后的独立文档提交，标签仍固定指向功能基线。
- 创建后必须推送功能提交、里程碑文档提交和 tag，并验证远端 peeled tag 精确指向记录的 commit。只存在本机的 tag 不算完成。
- 回退前先保护工作区现有改动，再从稳定 tag 创建独立 `recovery/` 分支。禁止直接 `git reset --hard` 或覆盖用户工作；优先将当前版本与里程碑做最小差异比较并只回退引入回归的边界。
- “稳定里程碑”表示用户确认的整体基础版本可回退，不会自动把故障库中的“已实施待复验”提升为“用户已确认”。
