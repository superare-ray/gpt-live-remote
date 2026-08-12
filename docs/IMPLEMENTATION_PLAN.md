# GPT-Live Remote 实施方案

## 1. 项目目标与边界

本项目让华为手机远程使用 Mac 上已经登录的 ChatGPT Desktop GPT-Live。手机负责账号登录、配对、选择 Mac、按住说话、接收语音及可选文字交互；GPT-Live 账号、智能能力以及 ChatGPT Desktop 与 Codex Desktop 的官方连接继续留在 Mac。PWA 自己的邮箱账号只用于保护设备列表和远程控制权限，不等同于 ChatGPT/OpenAI 账号。

明确边界：

- 不调用 OpenAI API，不读取 Cookie，不保存 OpenAI API Key。
- Bridge 不是 Agent，不读取 Codex 任务或生命周期。
- Mac 不开放入站端口，也不创建传统反向 tunnel。
- Mac Bridge 和手机 PWA 都主动连接阿里云。
- 阿里云负责 HTTPS、WSS 控制、设备存在状态、会话映射和 WebRTC 媒体转发。
- MVP 不录音，不在服务器保存音频。

## 2. 总体架构

```text
华为手机 PWA
  ├─ HTTPS/WSS：配对、设备列表、控制、状态
  └─ WebRTC：麦克风上行、GPT-Live 音频下行
                 │
                 ▼
阿里云
  ├─ Caddy：TLS 与反向代理
  ├─ Control API：登录、配对、设备、会话、WSS
  ├─ PostgreSQL：用户、登录会话、设备与绑定关系
  ├─ Redis：邮箱验证码、在线状态、临时配对、事件分发
  └─ LiveKit SFU/TURN：真正经服务器转发的音频
                 │
                 ▼
Mac GPT-Live Remote Bridge
  ├─ 主动 WSS 长连接与健康心跳
  ├─ LiveKit WebRTC 音频参与者
  ├─ CoreAudio/AVAudioEngine 音频桥
  ├─ BlackHole 双链路
  └─ 激活 ChatGPT Desktop 并触发 Voice 快捷键
                 │
                 ▼
ChatGPT Desktop GPT-Live
```

## 3. 推荐项目结构

采用一个 monorepo：

```text
apps/
  mac-bridge/             Swift/SwiftUI macOS App
  pwa/                    React + TypeScript + Vite PWA
services/
  control-api/            Node.js LTS + TypeScript + Fastify
packages/
  protocol/               OpenAPI、JSON Schema、事件类型
  ui-tokens/              PWA 设计令牌
infra/
  docker-compose.yml
  caddy/
  livekit/
  postgres/
  redis/
docs/
UI Refs/
```

### Mac Bridge

- Swift + SwiftUI/AppKit，做成菜单栏 App，同时提供设置窗口。
- `URLSessionWebSocketTask` 维护控制 WSS。
- LiveKit Swift SDK 负责 WebRTC 房间与音频轨道。
- AVAudioEngine/CoreAudio 负责虚拟声卡输入输出。
- `AutoAudioConfigurator` 按 CoreAudio UID 自动识别、分配和测试两条虚拟音频链路，并尽可能自动配置 ChatGPT 的音频设备。
- Keychain 保存设备私钥与服务器会话凭据。
- Core Image 生成二维码。
- NSWorkspace 激活 ChatGPT Desktop；CGEvent/Accessibility 触发用户已配置的 Voice 快捷键。
- `VoiceStateProbe` 通过 macOS Accessibility 读取 ChatGPT Voice UI 的状态切换；不以音频能量判断 Voice 是否启动。
- Developer ID 签名和 notarization 作为发布要求；早期本机原型可先使用开发签名。

### 手机 PWA

- React + TypeScript + Vite，Workbox/PWA manifest。
- 适配华为浏览器，最低触控区域 44px，并处理安全区。
- LiveKit Web SDK 负责麦克风轨道和远端音频。
- Web Audio `AnalyserNode` 驱动声波动画。
- 使用 Pointer Events 实现按住说话：`pointerdown` 开麦，`pointerup/pointercancel` 关麦。
- 首次连接动作同时完成麦克风授权和音频自动播放解锁。
- 如果浏览器支持 `selectAudioOutput/setSinkId`，允许网页选择输出；否则调用系统默认输出，由手机系统切换扬声器或蓝牙耳机。

### 阿里云服务

- Caddy 终止 TLS，提供 HTTPS 与 WSS。
- Fastify API 提供配对、设备、会话和 Bridge WSS。
- PostgreSQL 保存长期数据。
- Redis 保存短期配对码、presence、会话锁和 pub/sub。
- 自托管 LiveKit 负责 SFU 和 TURN。MiroTalk 可以用于早期媒体验证，但不直接采用其会议 UI；业务代码通过 Media Adapter 隔离，未来仍可更换媒体实现。

## 4. 不使用传统 tunnel

“连接 Mac”由两条主动出站连接构成：

1. Bridge 启动后主动连接 `wss://api.example.com/bridge`，每 15 秒发送心跳。
2. 会话开始后，Bridge 主动加入 `wss://rtc.example.com` 对应的 WebRTC 房间。

Mac 防火墙无需开放入站端口。服务器通过已经存在的 WSS 连接下发 `session.start`，而不是反向访问 Mac。

## 5. 账号登录与扫码配对

登录与配对是两个独立的安全层：

- **邮箱验证码登录**回答“当前访问者是谁”，保护设备列表、控制 API 和 WSS。
- **Mac 二维码配对**回答“这个账号是否被允许绑定这台 Mac”。扫码不是登录方式，也不会绕过账号鉴权。

仅知道域名、IP 地址或打开 PWA 的陌生人只能看到登录页。未登录请求访问 `devices`、`sessions` 或控制 WSS 时一律返回未授权；设备查询始终按当前 `user_id` 做服务端过滤，客户端传入的 `deviceId` 不能替代所有权检查。

### 邮箱验证码登录

1. 用户输入邮箱；PWA 调用 `POST /v1/auth/email/start`。
2. API 规范化邮箱地址，生成六位验证码，TTL 10 分钟，只允许使用一次；Redis 只保存验证码的带盐哈希。
3. 通过阿里云 Direct Mail 的事务邮件能力发送验证码，邮件只包含验证码、有效时间和安全提示，不发送可被转发后直接登录的长期链接。
4. 用户在同一页面提交验证码到 `POST /v1/auth/email/verify`。
5. 验证成功后，首次使用该邮箱就创建用户；已有邮箱则恢复原账号。
6. API 设置 `Secure + HttpOnly + SameSite` 会话 Cookie，登录会话使用滚动过期并支持服务端撤销。建议普通会话 30 天，敏感操作要求近期重新验证。

防滥用规则：

- 同一邮箱 60 秒内不能重复发送；按邮箱、IP 和设备指纹做小时级限流。
- 每个验证码最多尝试 5 次；成功或超限后立即失效。
- 无论邮箱是否已注册，接口返回相同文案和近似响应时间，避免枚举账号。
- 服务端不在日志中写入完整邮箱或验证码；邮件服务密钥只放服务器 secret。
- 不使用 IP 地址作为账号或长期信任依据，因为手机会在 Wi-Fi 和蜂窝网络之间切换。

### 首次绑定 Mac

1. 用户必须先完成邮箱登录；未登录时扫码会先进入登录页，登录完成后继续原配对流程。
2. Mac Bridge 在本地 Keychain 创建并保存设备密钥对。
3. Bridge 向服务器申请一次性 pairing session。
4. 服务器返回 192-bit 随机配对码，TTL 120 秒，只允许使用一次；服务器只保存其哈希。
5. Mac 弹出二维码。二维码内容类似：

   `https://app.example.com/pair#code=<one-time-code>`

   使用 URL fragment，避免配对码进入普通 Web 访问日志和 Referer。

6. 用户可直接用华为系统相机扫码并打开 PWA；也可以先打开 PWA，再使用网页扫描器。网页扫描器不能只依赖实验性的 `BarcodeDetector`，需要带 ZXing 类库回退。
7. PWA 提交一次性配对码；服务器把待绑定账号、Mac 和 pairing session 关联起来。
8. Mac 弹出确认：“允许账号 m***@example.com 绑定工作室 MacBook Pro？”并与手机显示同一组六位确认码。
9. 用户在 Mac 确认后，服务器建立 `user_id ↔ mac_device_id` 所有权关系；二维码立即失效。

### 后续访问与设备更换

- 首次配对成功后，Mac 归属到该邮箱账号。后续手机会话仍有效时，打开 PWA 就直接看到设备列表，不需要重新扫码。
- Cookie 过期、退出登录或换浏览器后，只需再次使用同一邮箱验证码登录，便可恢复该账号下的设备列表。
- 新浏览器首次发起远程控制属于敏感操作：默认要求验证码登录发生在最近 15 分钟内；后续可增加“受信任浏览器”管理。
- 清除浏览器数据不会删除服务器上的 Mac 绑定。主动解除绑定、转移 Mac 所有权或删除账号时才需要重新扫码。
- 一台 Mac 同一时间只能有一个所有者。转移给另一账号前，原账号必须解除绑定，或在 Mac Bridge 本机执行“重置所有权”。
- 二维码中不包含登录会话、长期访问令牌、服务器密钥或 LiveKit 密钥。

### 为什么首版不采用微信或手机验证码

- 网站微信登录不是零配置能力，需要在微信开放平台创建/配置网站应用并取得 AppID、AppSecret 和回调域名；它可以作为以后新增的 OAuth 身份提供方，但不应阻塞首版。
- 手机验证码需要额外的短信服务、签名/模板管理、成本和更严格的发送风控，同时会收集电话号码。
- 邮箱验证码不需要用户维护密码，部署复杂度较低，也方便未来把微信登录绑定到同一个内部 `user_id`。

## 6. 设备列表与连接状态

### Bridge 心跳

心跳建议每 15 秒一次，包含：

- `deviceId`、设备名称、Bridge 版本、macOS 版本。
- ChatGPT Desktop 是否安装、是否运行。
- 两个指定虚拟音频设备是否存在。
- 麦克风、Accessibility/Automation 权限是否可用。
- 当前会话、CPU 与音频 underrun 摘要。

服务器在 45 秒未收到心跳后把设备标记为离线。

### 健康层级

- `server_online`：PWA 可访问 API/WSS。
- `bridge_online`：Bridge 心跳正常。
- `audio_ready`：两个虚拟设备可打开并通过本地静音/电平检查。
- `desktop_ready`：ChatGPT Desktop 存在，快捷键权限已配置。
- `media_ready`：手机和 Bridge 均加入媒体房间，双方音频轨道已建立，Bridge 本地音频引擎已启动。
- `voice_ui_active`：触发快捷键后，ChatGPT Accessibility 树出现经过当前版本实机标定的 Voice-active UI 状态。
- `session_ready`：`media_ready && voice_ui_active`。GPT-Live 不会主动打招呼，因此不要求出现非静音音频。

设备列表只显示对用户有意义的 `在线 / 离线 / Bridge 未就绪`。详细原因放入连接失败后的恢复提示，不把诊断信息堆在主列表。

## 7. 点击“连接设备”的时序

1. PWA 调用 `POST /v1/sessions`，携带 `deviceId` 和幂等键。
2. 按钮原位变为单个 spinner，禁止重复点击；不打开新页面。
3. API 验证手机与 Mac 的绑定关系，创建 session 和 LiveKit room。
4. API 生成两个短 TTL 的房间凭据，分别给手机和 Bridge。
5. API 通过 Bridge WSS 下发 `session.start`。
6. 手机与 Bridge 加入房间；Bridge 先打开两条本地音频链路。
7. Bridge 回传 `media.ready` 后，激活 ChatGPT Desktop 并触发 Voice 快捷键。
8. Bridge 的 `VoiceStateProbe` 轮询 ChatGPT Accessibility 树，等待已标定的 Voice-active UI 状态出现。
9. `media_ready` 与 `voice_ui_active` 同时成立后，API 发出 `session.ready`，PWA 直接进入 Live 语音页。

建议总超时 15 秒。失败时按钮恢复，并显示一个简短原因和“重试”；同一个幂等键不能重复启动桌面 Voice。

### Voice 启动状态的标定与判定

音频能量不能用于首次启动判定：GPT-Live 连通后不会主动说话，正常静默会被误判为失败。ChatGPT 的音频服务进程是否存在也不能作为判据，因为桌面应用可能在没有 Voice 会话时就常驻音频服务。

实现 `VoiceStateProbe`：

1. 在本地诊断模式记录手动启动 Voice 前后的 Accessibility 树差异，只收集元素的 `role`、`identifier`、`title`、`description`、`value` 和层级，不截取或上传聊天内容。
2. 在当前 ChatGPT 版本、中文/英文界面下各重复启动和退出至少 5 次，找出稳定的 Voice-active 与 Voice-inactive 标识。
3. 优先使用稳定的 `AXIdentifier`；没有稳定 identifier 时，使用 role 与本地化标题/描述组合，并把选择器按 ChatGPT 版本存入本地配置。
4. 触发快捷键后轮询最多 8 秒；稳定状态连续出现两次才回传 `voice_ui_active`，避免窗口动画造成瞬时误判。
5. Voice-active 标识消失时回传 `voice_ui_inactive`。网络恢复不得再次触发快捷键，除非状态机已经确认原 Voice UI 退出。

若 ChatGPT 某个版本不再暴露可稳定读取的 Accessibility 状态，Bridge 必须报告 `desktop_state_unverified`，不能用固定延时或静音音频冒充成功。此时允许用户在 Mac Bridge 诊断页重新标定选择器。

音频能量仅用于会话建立后的声波动画与质量遥测：用户开口或 GPT-Live 真正回复时才会有非静音能量，但它不参与 `session.ready`。

## 8. 双 BlackHole 音频路由

使用两个不同的虚拟音频设备，角色严格隔离：

```text
手机麦克风
  → WebRTC/SFU
  → Bridge 远端音频解码
  → 虚拟设备 A 输出
  → ChatGPT Desktop 麦克风输入

ChatGPT Desktop 语音输出
  → 虚拟设备 B
  → Bridge 捕获
  → WebRTC/SFU
  → 手机扬声器/蓝牙耳机
```

可用 BlackHole 2ch 和 BlackHole 16ch 分别承担两个角色，避免同名设备混淆，但这些技术名称不直接暴露给普通用户。首次设置采用“自动配置音频”：

1. `AutoAudioConfigurator` 枚举 CoreAudio 设备，优先按稳定的设备 UID、制造商和通道数识别两套 BlackHole，不依赖用户可见名称或列表顺序。
2. Bridge 在内部固定分配角色：一套承载“手机到 ChatGPT”，另一套承载“ChatGPT 到手机”。用户界面只显示“远程音频”，不要求理解输入、输出或虚拟声卡。
3. Bridge 通过 ChatGPT Accessibility 界面自动尝试把麦克风和扬声器分别设置到对应设备，并读取设置结果做确认。
4. Bridge 自动执行静音电平、时钟、采样率和回路检测；两端误用同一设备时禁止进入 ready。
5. 成功后只显示“远程音频已就绪”，以后设备重启或顺序变化时按 UID 自动恢复。

不通过修改 macOS 全局默认输入/输出设备来实现自动化，因为这会影响其他应用，而且 ChatGPT 是否持续跟随系统默认值并不稳定。

自动配置存在两个受系统约束的例外：

- 首次安装 BlackHole 属于系统级音频驱动安装，需要用户在 macOS 中明确批准并输入管理员凭据；Bridge 可以检测、下载/打开受信任的安装包和复检，但不能静默安装。
- 如果某个 ChatGPT 版本不再暴露可操作的音频选择控件，Bridge 才显示一次性的图形化引导，并高亮用户需要点击的具体选项；不显示“GPT 输入设备/GPT 输出设备”这类技术文案。完成一次后保存并自动复检。

手机上行建议启用回声消除与降噪；Mac 发布 GPT 合成语音时关闭过度降噪和自动增益。

### 本机与远端在同一会话中共存

ChatGPT 始终连接固定的两条虚拟音频端点，不因用户从远端回到 Mac 而切换设备或重启 Voice。Bridge 在虚拟端点外侧充当透明路由器：

```text
手机麦克风 ─┐
            ├─ InputArbiter / Mixer → ChatGPT 固定虚拟麦克风
Mac 本机麦克风 ─┘

ChatGPT 固定虚拟输出 → Bridge ─┬─→ 手机 WebRTC
                               └─→ Mac 当前扬声器/耳机
```

具体行为：

- Bridge 自动跟随 macOS 当前物理麦克风和输出设备；用户从 MacBook 扬声器切换到 AirPods 时，ChatGPT 内部设置保持不变。
- 手机使用显式“按住说话”。`remote_ptt=true` 时远端输入独占，Bridge 暂时关闭本机输入，避免两路语音叠加。
- 手机松开后，如果 Mac 菜单栏中的“本机参与当前会话”已经开启，本机麦克风恢复，用户可以直接在电脑前说下一句。
- “本机参与”是隐私开关而不是音频设备选择。远程启动会话时默认关闭，防止无人值守的 Mac 把房间环境声送入 GPT；用户回到 Mac 后可一键开启，也可配置本机按住说话快捷键。
- GPT-Live 返回音频可同时发送到手机与 Mac 当前输出设备。手机或 Mac 可以单独关闭本地播放，不影响另一端。
- 若手机和本机同时请求发言，默认远端 PTT 优先；后续可增加 first-speaker-wins，但 MVP 使用显式优先级保证行为确定。
- Mac 使用外放时，Bridge 使用 GPT 输出作为回声参考做 AEC；MVP 同时在 GPT 播放期间对本机麦克风做衰减。需要自然打断能力时优先使用耳机。

AVAudioEngine 负责物理输入、远端 PCM、虚拟输出和本地监听的实时图；AVAudioMixerNode 将多路输入合成单路，并统一采样率和声道。路由改变只重建 Bridge 的相关节点，不重建 LiveKit 房间或 ChatGPT Voice 会话。

## 9. Live 语音交互

- 进入语音页时，麦克风默认关闭。
- 按住“按住说话”时只启用/取消静音现有音轨，不重复建房。
- 松开、触摸取消、页面失焦、来电或网络切换都强制结束本次上行。
- 用户说话时声波读取本地轨道电平。
- GPT-Live 回复时同一个声波读取远端轨道电平，并将状态切为“GPT-Live 正在回复”。
- 本机启用“参与当前会话”后，手机 PTT 和本机发言由 `InputArbiter` 在同一 GPT-Live 会话内交替路由，不触发新的 Voice 快捷键。
- 音频输出优先使用浏览器标准输出选择能力；华为浏览器不支持时，显示“跟随系统”，由系统音频面板切换手机扬声器或蓝牙耳机。

## 10. 文字模式的真实实现边界

ChatGPT Desktop 没有本项目可以依赖的公开文字桥接接口。如果继续坚持“不使用 OpenAI API/Cookie、不抓取 ChatGPT UI”，推荐把文字模式实现为同一语音会话的文本适配层：

1. 手机文字通过 WSS/DataChannel 发给 Bridge。
2. Bridge 使用 macOS 本地 TTS 将文字合成为 PCM，并写入虚拟设备 A。
3. GPT-Live 按语音请求处理。
4. GPT-Live 的返回音频正常传回手机。
5. Bridge 同时使用本地 Speech/可选本地转写模型生成文字气泡。

优点是仍不接触账号、Cookie 或 Codex；缺点是返回文字是音频转写，可能有识别误差。

如果要求“完全准确的原始文字回复”，就必须额外选择以下一种方案，不能假装现有桌面应用天然支持：

- 显式授权的 macOS Accessibility UI 适配器，输入和读取 ChatGPT 界面；升级后可能失效。
- 未来使用官方可用的 App Server/API 作为独立文字入口。

MVP 默认先完成完整语音闭环，再加入 TTS/本地转写文字适配层。

## 11. API 与事件草案

### HTTP

- `GET /healthz`：进程存活。
- `GET /readyz`：数据库、Redis、LiveKit 是否可用。
- `POST /v1/auth/email/start`：发送邮箱登录验证码。
- `POST /v1/auth/email/verify`：验证验证码并创建登录会话。
- `POST /v1/auth/logout`：撤销当前登录会话。
- `GET /v1/auth/me`：返回当前账号的最小信息。
- `POST /v1/pairing/sessions`：Bridge 创建二维码配对会话。
- `POST /v1/pairing/exchange`：手机提交一次性码。
- `POST /v1/pairing/approve`：Mac 批准手机。
- `GET /v1/devices`：获取已绑定设备列表与 presence。
- `POST /v1/sessions`：创建远程会话。
- `DELETE /v1/sessions/:id`：结束远程会话。

### Bridge WSS 事件

- `bridge.hello`
- `bridge.heartbeat`
- `pairing.pending`
- `pairing.approved`
- `session.start`
- `session.cancel`
- `session.ready`
- `session.failed`

所有控制命令都带 `commandId`、`sessionId`、时间戳和 ACK；重发不能产生第二次 Voice 快捷键。

## 12. 阿里云部署建议

初始单用户/少量设备可从一台 Ubuntu ECS 开始，建议：

- 4 vCPU、8 GB RAM。
- 固定公网 IPv4/EIP。
- 至少 10–20 Mbps 公网带宽，音频场景优先关注稳定性而非峰值 CPU。
- Docker Compose 部署 Caddy、API、PostgreSQL、Redis、LiveKit。
- 数据库、Redis、LiveKit 管理端口不暴露公网。

域名建议：

- `app.example.com`：PWA 与 API。
- `rtc.example.com`：LiveKit WSS。
- `turn.example.com`：TURN/TLS。

安全组需要按最终 LiveKit 配置开放：

- TCP 80、443。
- TCP 7881（WebRTC TCP fallback）。
- UDP 3478（TURN/UDP）。
- UDP 50000–60000（默认 WebRTC UDP 范围），或评估 LiveKit UDP mux 后缩小范围。
- SSH 仅允许管理员固定 IP，不向 `0.0.0.0/0` 开放。

LiveKit 信令放在可信 CA 证书的 WSS 后；TURN/TLS 使用独立域名和证书。LiveKit 房间凭据只由服务端生成，TTL 尽量短。

如果 ECS 在中国大陆，公开网站/App 上线前需要处理 ICP 等备案要求；香港或海外节点不需要大陆 ICP，但需要结合目标网络质量实测。

## 13. 数据与安全

- PWA 登录账号与 ChatGPT/OpenAI 账号完全独立；服务端不接触 ChatGPT 凭据。
- Mac 私钥只存 Keychain；PWA 登录会话使用 Secure、HttpOnly、SameSite Cookie，不把长期 bearer token 放入 Local Storage。
- 所有设备列表、会话创建和 WSS 订阅都在服务端同时校验 `session.user_id` 与设备所有权；知道 URL、IP 或 `deviceId` 不能读取或控制设备。
- 邮箱验证码短时、一次性、带尝试次数和发送频率限制；只保存哈希。
- 配对码随机、短时、一次性、服务端只存哈希。
- PWA 只能看到与其绑定的设备。
- LiveKit token 不下发长期权限，不允许任意房间名。
- 设备删除会撤销绑定和活跃会话。
- 不录音；日志只保留事件、错误码、延迟和匿名化媒体质量指标。
- 控制 API、Bridge 和 PWA 全程使用 TLS/WSS；WebRTC 使用 DTLS-SRTP。
- 服务端密钥放 `.env`/secret manager，不提交 Git。

## 14. 实施顺序与验收

### 阶段 A：仓库与服务器骨架

- 建 monorepo、协议包、Docker Compose、TLS、API、PostgreSQL、Redis、LiveKit。
- 验收：`healthz/readyz` 正常，测试房间可从两个浏览器传输音频。

### 阶段 B：邮箱登录、Mac Bridge 与扫码配对

- 邮箱验证码登录、菜单栏 App、Keychain 设备身份、WSS 心跳、二维码和 Mac 确认。
- 验收：匿名用户看不到任何设备；同一邮箱重新登录后恢复已绑定 Mac；其他账号不可枚举或控制该设备；二维码过期或二次使用失败。

### 阶段 C：设备列表与会话调度

- PWA 设备列表、在线状态、连接按钮 spinner、幂等会话控制。
- 验收：在线/离线在 45 秒内正确更新；重复点击不会创建重复会话。

### 阶段 D：WebRTC 与双 BlackHole

- Bridge 加入房间、双向音频、`AutoAudioConfigurator`、`InputArbiter`、本地监听、Accessibility 自动配置和电平测试。
- 验收：安装驱动后的用户无需理解或手动选择输入/输出设备；重启和设备顺序变化后仍能自动恢复。手机远端说完后可在不切换 ChatGPT 设备、不重启 Voice 的情况下由 Mac 本机继续说，GPT 输出同时可达两端；两端输入不会意外叠加或形成自激回路。

### 阶段 E：GPT-Live 启动闭环

- 媒体 ready 后激活 ChatGPT、触发 Voice 快捷键，并用 `VoiceStateProbe` 确认 Voice UI 已进入 active 状态。
- 验收：在 GPT-Live 启动后保持静默的情况下仍能正确进入语音页；未进入 Voice UI 时不能误报 ready。随后用户按住说话，真实 GPT-Live 能听到手机并回传语音。

### 阶段 F：语音 UI 与网络恢复

- 按住说话、声波、系统/蓝牙输出、Wi-Fi/蜂窝切换重连。
- 验收：断网重连不重复启动桌面 Voice；松手和页面失焦不会遗留开麦。

### 阶段 G：文字适配层

- 手机文字、Mac 本地 TTS、返回音频转写。
- 验收：输入文字可驱动同一 GPT-Live 会话，并在手机显示可接受的转写结果。

### 阶段 H：打包与安全加固

- Developer ID、notarization、自动更新策略、限流、审计、备份与恢复。

## 15. 开工前需要的资源

服务器侧：

- 阿里云地域、中国大陆/香港/海外节点。
- ECS 系统、CPU、内存、EIP 和公网带宽。
- 一个可控制 DNS 的域名。
- 安全组修改权限。
- SSH 公钥方式的 sudo 用户；不要在聊天中发送密码或私钥。

Mac 侧：

- macOS 版本、Mac 型号和 Apple Silicon/Intel。
- ChatGPT Desktop 版本与已配置的 Voice 全局快捷键。
- 当前是否已经安装 BlackHole，以及可见设备名称。
- 是否有 Apple Developer ID；没有也不影响先做本机原型。

产品决策：

- 首版文字模式是否接受“本地 TTS + 返回音频转写”。
- 第一批需要支持的 Mac 数量和手机数量。
- 用于登录的事务邮件发信子域名，例如 `auth.example.com`，以及阿里云 Direct Mail 配置权限。
- ECS 地域确定后，再决定是否使用大陆备案域名或香港/海外域名。
