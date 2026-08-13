# Codex Live Remote 已知故障库

本目录记录可复用的故障知识，不承担产品与架构定义；权威工程约束见根目录 [`AGENTS.md`](../../AGENTS.md)。每次出现新问题时，必须先按症状、边界和日志关键词检索本文件，再决定是否复用已有处理。

## 状态定义

- **用户已确认**：用户在真实手机、真实网络和 Codex Voice 中确认结果。
- **边界已确认**：通过不创建媒体会话的静态检查、日志或 HTTP/进程边界检查确认；不代表端到端语音通过。
- **已实施待复验**：代码或配置已部署，但用户尚未完成真实设备复验。
- **已知待修复**：根因和临时恢复方式已确认，但代码层仍缺少可靠自愈。
- **诊断规则**：已经确认的事实或排查约束，不代表一个独立修复。

构建、typecheck、进程存活、UI 波形、连接音和模拟音频都不得提升为“用户已确认”。

## 快速索引

| ID | 症状 | 根因边界 | 状态 |
| --- | --- | --- | --- |
| KI-001 | 网页提示重定向次数过多 | Nginx ↔ 前端规范路径 | 边界已确认 |
| KI-002 | Voice 快捷键触发后仍无 Codex 输入 | Bridge → Codex Voice | 边界已确认 |
| KI-003 | 没有主动问候，被误判为未连接 | Voice 状态判定 | 诊断规则 |
| KI-004 | 有效音频爆裂、失真，静音干净 | 旧 FFmpeg/设备身份/队列链路 | 用户已确认改善 |
| KI-005 | 初始音后下行不再返回 | CoreAudio capture → LiveKit | 已实施待复验 |
| KI-006 | 手机与 Mac 同时播放同一声音 | process tap 本地播放语义 | 已实施待复验 |
| KI-007 | 断开重连后按住说话无波形/无上行 | 浏览器 track 生命周期 | 已实施待复验 |
| KI-008 | 刷新后页面卡住、回设备页或状态错误 | 页面恢复/控制与媒体生命周期 | 已实施待复验 |
| KI-009 | 第一段能传，间隔后第二段不能传 | PTT 错误销毁或重建轨道 | 已实施待复验 |
| KI-010 | 本人声音回到手机，Codex 被自身回复干扰 | Bridge playout 被 system tap 回采 | 已实施待复验 |
| KI-011 | 看似 E2E 通过，真实设备却未收到回复 | 把连接音当作回复 | 诊断规则 |
| KI-012 | 多个 Bridge、aggregate 或 helper 遗留 | 资源所有权与退出路径 | 已实施待复验 |
| KI-013 | 忘记授权麦克风时只显示连接超时 | 浏览器权限 → 媒体创建 | 已实施待复验 |
| KI-014 | 切换 Mac 后两台设备仍参与收发音频 | 设备会话隔离与前台媒体选择 | 已实施待复验 |
| KI-015 | Bridge 进程存活但设备长期显示离线 | Control WebSocket 1006 后未自愈 | 已知待修复 |
| KI-016 | 蓝牙断开后声音落到听筒且很小 | 移动系统通信音频路由 | 平台能力边界 |
| KI-017 | 切换设备必须先停旧设备，且跳离 Live 页 | PWA 单例媒体 runtime/账号单租约 | 已实施待复验 |
| KI-018 | dropdown 不切页、切回不重启 Voice、设备按钮常驻 loading、静音无效 | PWA 前台切换 / Voice 复核 / 播放状态 | 已实施待复验 |

## KI-001：子路径发生 308 重定向循环

**症状**

- 手机和电脑访问 `https://8.137.116.27:9443/gpt-live-remote` 时提示“重定向的次数过多”。
- 不带尾斜杠返回到带尾斜杠；带尾斜杠又返回到不带尾斜杠。

**证据与根因**

- Nginx 的 exact location 曾执行 `return 308 /gpt-live-remote/`。
- 当前 vinext 前端对 `/gpt-live-remote/` 返回 `Location: /gpt-live-remote`，且实际页面由上游根路径 `/` 提供。
- 两层同时规范化路径造成永久循环；仅删除一侧重定向会进一步暴露 404。

**处理方式**

- Nginx 同时接受带和不带尾斜杠的公网路径，并在反向代理时去除 `/gpt-live-remote` 前缀交给 `127.0.0.1:8790/`。
- 保留 `/gpt-live-remote/api/` 的 Control API 专用 location，不得让它落入前端代理。
- 修改后先执行 `nginx -t`，再 reload，仅更新项目 vhost。

**验证**

- 2026-08-13：公网带/不带尾斜杠均为 HTTP 200、0 次重定向；核心 `/_next` JS 为 HTTP 200。状态为“边界已确认”，等待用户再次确认手机实际加载。

## KI-002：Voice 快捷键没有打开 Codex 输入

**症状**

- WebRTC、BlackHole 和 Bridge 已就绪，但连接最终失败或出现 `voice_audio_input_unverified`。

**根因**

- AppleScript 发送 `Control+Shift+V` 没有触发 Codex 的全局 Voice chat hotkey。

**已确认处理**

- 使用 `audio-device.swift send-hotkey v control,shift` 通过 CoreGraphics HID 发送按键。
- 用户已确认真实快捷键为 `Control+Shift+V`；不是 `Command+Control+V`。
- 通过 `audio-device.swift process-io com.openai.codex` 验证输入状态，失败时精确报告，不得切换到 Chat 作为回退。

## KI-003：Codex 未主动说话不代表未连接

Codex Voice 连接后不保证主动打招呼。不得等待“真实音频活动”判断启动成功；应检查 Codex CoreAudio process input、LiveKit 房间和各音频边界计数器。启动音、连接音也不是助手回复。

## KI-004：旧实时链路在有声时爆裂、失真和 noise

**症状与证据**

- 静音完全干净，一旦出现有效音频就明显爆裂、失真或夹杂 noise。
- 旧下行包含 CoreAudio aggregate → AVFoundation/FFmpeg → 任意 stdout chunk → `Buffer.concat` → Promise 队列 → LiveKit，并且曾存在两个同名 aggregate，按名称/index 可能选中旧设备。

**已确认处理**

- 生产上下行移除 FFmpeg，改用原生 CoreAudio callback、固定 ring buffer 和进程内一次格式转换。
- aggregate 使用唯一 UID，原生层按 UID/AudioObjectID 绑定；下行保持 48 kHz stereo，并显式设置 Opus bitrate 与 `dtx=false`。
- 不添加降噪或 gain 掩盖格式、时钟和设备身份问题。

**验证**

- 用户真实听感确认“声音音质好太多了，之前各种 noise”。该确认仅覆盖音质明显改善，不代表重连、长连接和双向语音全部通过。

## KI-005：只听到初始连接音，后续无返回音频

**可能命中的已实施根因**

- capture pump 在 `AudioSource` 尚未就绪时提前永久退出，后续即使 CoreAudio 已有帧也不再提交 LiveKit。

**已实施处理**

- capture pump 在 source 暂未就绪时等待并继续；会话关闭才退出。
- 下行单独使用 48 kHz stereo，记录 capture frames/peak、ring、submitted frames、浏览器 inbound RTP 和 playback。

**复验要求**

- 必须由同一 session ID 证明 capture callback 有非静音帧、LiveKit submitted 增长、浏览器 inbound RTP 增长并实际播放。用户尚未复验，不得标记完成。

## KI-006：Mac 与手机重复播放同一系统音频

**根因与处理**

- process tap 采用未静音语义时，系统音频既走本地设备又走远端。远程耳麦模式改为 `.mutedWhenTapped`，连接期间只由浏览器输出；断开后销毁 tap 并恢复原系统输出。

**状态**

- 已实施，等待用户真实设备复验。

## KI-007：断开重连后麦克风轨道失效

**症状**

- 远端断开再连接后，长按按钮没有三点波形，Bridge 收到静音或 track 已 muted/ended；强刷后又可能无法连接。

**处理方式**

- 仅在同一健康媒体会话内复用一条 track 并执行 mute/unmute。
- 终止性断开必须 stop 旧 track；新 session 必须重新调用 `createLocalAudioTrack`，不得复用上一 session 的 `MediaStreamTrack`。
- 控制 WebSocket 短断只重连控制面，不能清理健康 Room。

**状态**

- 生命周期已实施，等待真实断开→重连→多轮 PTT 复验。

## KI-008：刷新导致页面状态错误或持续 loading

**处理方式**

- 页面启动时从服务器读取 active session 与真实设备状态；有活动会话则恢复沟通页，没有才显示设备列表。
- 服务器保留每台设备的独立会话，并按创建或最近一次用户 `ptt_unmuted` 后15分钟回收；刷新只恢复最后一个 Live 目标的前台媒体，其他会话保持后台。
- 终止性控制关闭码才拆媒体；普通网络闪断仅重连控制 socket。

**状态**

- 已实施待复验。若表现为“网页无法打开/重定向过多”，先查 KI-001，不要归入会话恢复。

## KI-009：第一段上行成功，间隔后第二段静音

**根因模式与处理**

- 松开 PTT 曾停止采集、轨道或发布，第二次需要重协商且容易失效。
- 正确模型是在设备连接期间永久保持 Room、publication 和 Bridge PCM 搬运；PTT 只 mute/unmute。Bridge 不判断句首句尾。

**状态**

- 已实施待真实多轮和间隔复验。

## KI-010：手机听见自己，或 Codex 被自己的回复干扰

**根因与处理**

- system process tap 若包含 Bridge 自身 phone playout，会把手机上行再次发回手机；Codex 回复也可能形成回路。
- 创建 tap 时排除 Bridge 自身进程，且浏览器本地 analyser 只测量、不接 `AudioContext.destination`。

**状态**

- 已实施待复验。不要通过 AGC/降噪压制回路。

## KI-011：连接音造成端到端假阳性

2026-08-13 一次模拟运行把约 `-8.3 dBFS` 的返回当成助手回复，后来被真实设备观察推翻。以后返回观察窗口必须从用户有效上行开始，并结合助手实际响应时序；连接前或连接瞬间的提示音全部排除。E2E 工具、进程存活和音量峰值不能单独作为验收。

## KI-012：会话后遗留进程、tap 或 aggregate

**风险模式**

- 通过 `tsx` 启动生产 Bridge 会产生多层或孤立进程。
- 崩溃或不完整 teardown 可能遗留 aggregate、helper、默认音频设备和旧 Bridge socket，下一次会话连接到错误资源。

**处理方式**

- 生产只由 LaunchAgent 启动一个直接 Node `dist/index.js` 进程；服务器新 Bridge socket 替换旧 socket。
- 每个 `MacAudioBridge` 资源只归属一个 session，所有失败和退出信号汇入幂等 `close()`。
- 每次创建唯一 aggregate UID；启动前只清理项目 UID 前缀的遗留；销毁后记录设备已不存在，并恢复会话前系统默认设备。

**状态**

- 进程单实例与清理逻辑已实施；长连接、异常退出和连续重连仍需用户真实复验。

## KI-013：麦克风未授权被误报为连接超时

**症状与根因**

- 用户连接设备时没有处理或拒绝浏览器麦克风授权，`createLocalAudioTrack` 最终只显示“麦克风连接超时”，无法直接恢复。
- 权限等待、权限拒绝和真正的 WebRTC 连接超时被压缩成了同一个错误。

**处理方式**

- 单独识别 `NotAllowedError`、`SecurityError` 与麦克风创建超时，先停止本次服务器会话并完整清理媒体资源。
- 显示麦克风授权弹层，由新的用户点击手势再次调用 `getUserMedia`；成功后立即停止该探测流，再创建全新的正式媒体会话。
- 若浏览器已永久阻止网站权限，明确引导用户从网站权限中允许，不循环创建会话。

**状态**

- 已实施待真实权限拒绝→重新授权→连接复验。

## KI-014：切换 Mac 后旧设备仍参与双向音频

**症状与证据**

- 从 Raymond 切换到 Mono 后，数据库中的 Raymond 会话虽已标记 stopped，但旧 Raymond Bridge 没有收到 `session.stop`，旧 LiveKit room 与发布/订阅管线仍存活。
- 旧实现只按目标 `device_id` 结束会话，账号绑定的另一台 Mac 因而可以继续参与媒体，造成上下行跨设备泄漏。

**已实施处理**

- 第一阶段曾用账号级单租约彻底停止旧设备，并由用户确认解决了跨房间泄漏；后续产品目标明确要求多设备会话并存，因此该策略已被有意替换，不能再恢复账号级唯一索引。
- 当前 Control API 使用 `remote_sessions_one_active_per_device`，每台 Mac 最多一个会话；不同设备可并存。LiveKit token 继续锁定 session UUID 房间和角色：phone 只可发布 `MICROPHONE`，Bridge 只可发布 `SCREEN_SHARE_AUDIO`。
- PWA 为每台设备持有独立 runtime，但任一时刻只有 Live 页选中的设备允许手机上行 unmute 和下行 subscribe；切到后台的设备必须同时 mute/unsubscribe，防止此前的双向串流重新出现。

**验证**

- 2026-08-13：用户确认旧账号级单租约版本解决了串流，但随后明确改变产品语义为多设备后台并存、手机前台独占。
- 新的 per-device + foreground-only 实现已通过静态检查，仍需用户在 Mono/Raymond 真机切换时确认：A 保持会话但 RTP 上下行暂停，B 独占手机音频。

## KI-015：Bridge 进程存活但 Control WebSocket 已死亡

**症状与证据**

- `工作室 Mac mini Raymond` 曾显示不可用；LaunchAgent 与 Node PID 均存活，但进程没有 TCP socket，日志最后事件为 Control WebSocket `1006`。
- 因主进程未退出，LaunchAgent 不会重新拉起它；这不是前端版本不同步。

**当前恢复方式**

- 仅在对应 Mac 上执行该 Bridge LaunchAgent 的 `kickstart -k`。2026-08-13 的操作恢复了单一 Node 进程、到 `8.137.116.27:9443` 的 ESTABLISHED 连接及设备注册；`MEDIA_ONLY_MODE=true` 保持不变，未触发 Voice。
- 用户确认多设备链路稳定后，Raymond 的 `MEDIA_ONLY_MODE` 已独立改为 `false` 并只重载该 Bridge；该配置变更没有创建媒体会话或触发 Voice，也不改变本条尚未修复的 1006 自愈缺口。

**未完成项**

- Bridge 尚未实现 Control WebSocket 1006 后的进程内有界重连或明确退出交给 LaunchAgent 自愈。再次出现时先检查 PID、TCP socket 与最后关闭码，禁止通过重启服务器或 Codex 掩盖。

## KI-016：蓝牙断开后返回音频落到听筒

**症状与边界证据**

- PWA Live 会话中断开蓝牙耳机后，返回音频没有继续走手机扬声器，而是落到听筒/receiver，音量明显变小。
- 当前前端把 LiveKit 远端轨道直接附加到一个 `HTMLAudioElement`，明确设置 `volume=1`，没有 gain、压低音量或指定 sink。静音/恢复只改变 media element 的 muted/play 状态。
- 结合上行麦克风仍常驻，最符合证据的边界是手机系统/浏览器把 WebRTC 作为通信音频；蓝牙通信设备消失后，系统默认回退到了内置听筒，而不是媒体扬声器。该结论是根据代码与真机现象做出的路由推断，不是音频 PCM/LiveKit 增益故障。

**PWA 能做与不能做的事**

- 可监听 `navigator.mediaDevices.devicechange`（若浏览器实现）并检测设备变化；可在用户手势下重新 `play()`，解决暂停/自动播放阻止，但这不会保证改变系统物理路由。
- 只有实现 Audio Output Devices API 的浏览器，才能在用户手势下通过 `selectAudioOutput` + `setSinkId` 选择已授权输出。目标 Android/Huawei 移动浏览器没有可依赖的跨浏览器支持，且该 API 本身也要求用户选择，不能作为“每次自动回扬声器”的保证。
- 不得通过停止常驻麦克风、重建 Room 或伪造扬声器菜单绕过；这会破坏网络耳麦生命周期，且仍不能保证系统路由。

**可行处理**

- PWA：检测到设备变化后，若输出选择 API 确实存在，可由一次明确用户点击调用系统选择器；否则显示“请在手机系统音频输出中选择本机扬声器”的可行动提示。恢复播放按钮只负责 `play()`，不得声称会切换扬声器。
- 系统兜底：用户从手机控制中心/当前音频输出面板选择“本机/手机扬声器”；不同系统入口名称可能不同。
- 若产品要求蓝牙每次断开后无用户操作地可靠切到扬声器，需要 Android/HarmonyOS 原生客户端监听音频设备变化，并使用平台通信设备路由 API选择内置扬声器。通用 PWA 无法提供该保证。

**状态**

- 2026-08-13：根因边界与平台能力已确认；尚未实现 PWA 的设备变化提示，也未建立原生客户端。

## KI-017：切换设备会先停止旧设备并离开 Live 页

**症状与根因**

- 旧 PWA 只有一组全局 Room、mic track、audio element、control socket 和 analyser；`connectDevice(B)` 必须先调用 `stopCurrentSession(A)` 与 `disconnectMedia()`。
- Control API 同时使用账号级唯一租约，新建 B 前会等待 A Bridge 完整停止。因此前端无法立即显示 B，也无法保留 A 的 Codex Voice。

**已实施处理**

- 每台设备使用独立 `DeviceSessionRuntime`，资源、回调、计时器和清理路径按 device/session 所有；切换不会覆盖另一设备引用。
- 点击 B 立即留在 Live 页并显示 B“正在连接”；A 只 mute 本地 publication、unsubscribe 远端 publication、暂停 audio element，Room/Bridge/Codex Voice 保持。
- B 只有上行 publication 与下行 subscription 都就绪才显示音频已连接；Codex Voice ready 后才出现 PTT。B 网络失败停留原页并自动重连；明确断开、离开 Live、权限失败和空闲超时不触发自动重连。
- Control API 改为每设备唯一会话并幂等复用已存在会话；`ptt_unmuted` 刷新独立15分钟语音空闲期限。
- Bridge 检测到 Codex Voice 已有真实输入时直接复用，不再先关闭后重新触发快捷键。

**验证**

- PWA lint/build、Control API typecheck/build、Mac Bridge typecheck/native build 均通过。尚未执行媒体或 Voice 测试，等待用户在两台真实 Mac 与手机上复验。

## KI-018：多设备 dropdown、Voice 恢复、设备 spinner 与静音状态不收敛

**症状**

- Live 页点击另一台 Mac 后 dropdown 仍展开，没有立即显示目标设备。
- 用户在 Mac 上手动关闭 Codex Voice，切回该设备后页面长期显示“正在连接”，Bridge 没有重新启动 Voice。
- 返回设备管理页后，已有 session 的“断开连接”按钮持续显示 loading。
- 点击下行静音后仍能听到远端声音；同 session 遥测持续显示 `playback.muted=false`。

**边界证据与根因**

- `connectDevice` 在更新 active device 与关闭 dropdown 前 `await` 旧 runtime 的 `setForeground(false)`；其中远端 unsubscribe 是网络异步操作，阻塞了本应同步发生的 UI 选择。
- 服务器 session 的 `ready` 只代表首次启动已验证。用户在桌面手动关闭 Voice 不会终止 WebRTC，切回旧 runtime 时原实现没有重新检查 `process-io`，因此错误复用旧 ready。
- 后台 runtime 按设计 unsubscribe 下行，内部 `mediaStatus` 会回到 `connecting`；设备列表把这个媒体细节优先于已存在的服务器 session，错误显示 spinner。
- 静音只修改 audio element 的 `muted` 属性，轨道 attach/恢复播放路径可能覆盖它；真实遥测没有出现 muted 状态。

**已实施处理**

- 点击设备先同步关闭 dropdown、更新 active device/Live UI，再并行调用旧 runtime 后台化和新 runtime 连接；不再等待旧 unsubscribe 才切 UI。
- 增加 `POST /sessions/:id/ensure-voice` 与 Bridge `session.ensure_voice`。切回已存在 runtime 时先隐藏 PTT，Bridge 用 CoreAudio process input 幂等复核；已开启则不发送快捷键，已关闭才启动，确认后恢复 PTT。
- 设备管理以活动 session 判定“已连接”；只有不存在 session 的设备才可因 `mediaStatus=connecting` 显示连接 spinner。
- 下行静音改为对当前远端 audio element 同时 `muted=true` 与 `pause()`；恢复时才 `play()`，所有 attach/foreground 路径读取同一个持久状态。

**验证**

- 静态检查通过；尚未执行媒体、Voice 或真机交互测试，等待用户在 Mono、Raymond 与手机上复验。

## KI-019：切回后台设备时报 `Cannot read properties of undefined (reading 'catch')`

**症状**

- 从另一台设备切回 Mono01 时，前端抛出 `Cannot read properties of undefined (reading 'catch')`。
- Codex Voice 在 Mac 上仍保持打开，但 Live 页没有恢复按住说话按钮。

**边界证据与根因**

- 故障发生在 PWA 将后台 runtime 重新设为前台时，不在 Control API、Bridge 或 Codex Voice 边界。
- LiveKit `RemoteTrackPublication.setSubscribed(boolean)` 是同步返回 `void` 的 API。前端错误地在返回值上调用 `.catch()`；切换时执行远端音轨 unsubscribe/subscribe，因而读取 `undefined.catch`。
- 异常中止了后续 `ensure-voice` 和 `voiceReady=true`，所以即使 Mac 上 Voice 仍打开，PTT 也会被隐藏。

**已实施处理**

- 远端音轨订阅切换统一改为同步调用；同步异常由正确的上层失败路径处理。
- 两处不应阻塞 UI 的后台化调用显式持有 runtime，并只在真实 Promise 上处理 rejection，避免可选链与 Promise 语义混用。
- `resumePlayback()` 在恢复前重新确认远端 track 已附着到实际 audio element；刷新恢复后若浏览器阻止自动播放，Live 页下一次正常用户手势会直接恢复该 element，不增加额外“启用音频”按钮。

**验证**

- PWA lint 与 production build 通过；尚待用户在 Mono/Raymond 真机往返切换复验。

## 新故障登记流程

1. 用用户可见症状和日志关键词检索本文件；优先匹配相同故障边界，不只匹配相似文案。
2. 用同一 session ID 找出最后一个有数据的边界和第一个无数据的边界。
3. 只有证据与既有条目一致时才复用处理；否则新增 ID，禁止把新问题硬塞进旧结论。
4. 记录：发生时间、版本/commit（如有）、真实设备与网络、症状、两侧计数器、根因、最小处理和回滚方式。
5. 部署后先标记“已实施待复验”。用户真实设备确认后，才能改为“用户已确认”；HTTP、进程、静态构建等只能改为“边界已确认”。
6. 若处理失效，在原条目追加反证并降级状态，不得保留虚假的“已确认”。
