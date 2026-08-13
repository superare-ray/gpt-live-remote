# 2026-08-13 稳定基线后同步与变更对比

## 对比基线

- 稳定标签：`stable-network-headset-v1-2026-08-13`
- 稳定 commit：`dfb619e0ebe7b98850c4ea92aeac3b62cccc4aaa`
- 同步前仓库 HEAD：`4862c7fba332b3329842b753d32316327abb86f4`
- 本文只记录可由 Git、线上源码校验和、服务状态、Control 数据库或已完成任务记录证明的事实。没有执行媒体连接、模拟音频或 Codex Voice 测试。

## 状态总表

| 范围 | 当前状态 | 部署/保存状态 | 验证级别 |
| --- | --- | --- | --- |
| 稳定网络耳麦基线 | 原生 CoreAudio + BlackHole + LiveKit 双向语音 | 已提交、已打稳定标签、已部署 | 用户曾确认整体基础功能“已经很舒服” |
| PWA 最新交互 | 设备卡返回 Live、居中电平、精简 PTT、移除回复状态、下行静音、移除无效输出选择 | 线上与本地 `page.tsx`/`globals.css` SHA-256 完全一致 | 构建通过、HTTP 200；本轮交互仍待真机确认 |
| 账号级媒体隔离 | 一个账号一个媒体租约；切换设备先停止旧 Bridge；LiveKit 角色/source 隔离 | Control API 已部署；同步时已从线上权威源码回写本地 | 用户已确认多设备/音频链路稳定 |
| Mono Bridge | `工作室 MacMini Mono01`，完整 Voice 模式 | LaunchAgent 单一生产进程；Control 在线 | 进程/控制边界确认，本轮未触发 Voice |
| Raymond Bridge | `工作室 Mac mini Raymond`，完整 Voice 模式 | `MEDIA_ONLY_MODE=false`；第二台 Mac 已注册、绑定并重新在线 | 单一进程、Control 在线且重载后无 `session.start`；未触发 Voice |
| 已知故障 | KI-001 至 KI-015 | 已统一写入故障库 | 各条按“用户确认/边界确认/待复验/待修复”独立标记 |

## 相对稳定基线的用户可见 PWA 变化

1. Live 页返回设备管理的按钮固定在最左侧；设备名称区域只负责设备 source 下拉。
2. 设备列表中点击当前已连接设备的卡片会回到现有 Live 会话；点击另一台在线设备会发起设备切换。设备右侧仍保留连接/断开操作。
3. 三点音频指示器固定在视口中心，并使用真实 analyser 电平；不再把布局或推断的“回复中”状态当作音频反馈。
4. PTT 可见文案只保留“按住说话”与“正在发送”，不再显示“GPT 正在回复”。
5. 顶部保留下行 Volume2/VolumeX 静音/恢复。该操作只控制浏览器播放，不销毁远端轨道或房间。
6. 删除 `selectAudioOutput`/`setSinkId`、输出设备标签、选择状态及失败提示。手机扬声器、听筒与蓝牙的路由由系统控制，前端不再展示无法可靠执行的伪切换入口。

## 多设备与会话路由变化

稳定基线的 Control API 只会停止“同一目标设备”的旧会话。线上曾出现 Raymond 数据库会话已 stopped、但其 Bridge 未收到 `session.stop`，旧 LiveKit 管线继续参与音频；再连接 Mono 后形成跨设备泄漏。

当前已部署逻辑：

- 一个账号最多存在一个 `starting`/`ready`/`stopping` 媒体租约。
- 新会话创建前，Control API 会关闭旧手机控制 socket，向每个旧会话记录的准确 Bridge 发送停止指令并等待确认。
- 旧会话未完全释放时，新会话返回 409，不签发新房间 token。
- SQLite 部分唯一索引 `remote_sessions_one_active_per_user` 阻止并发创建第二个账号租约。
- LiveKit token 固定到 session UUID room；phone 只发布 `MICROPHONE`，Bridge 只发布 `SCREEN_SHARE_AUDIO`，双方禁止 data publication。
- 设备发现和账号设备列表不变，仍可同时展示多台在线 Mac。

## Mac Bridge 与第二台设备

- Bridge 代码相对稳定基线没有新增媒体实现差异；第二台设备是同一 Bridge 构建的独立部署与配置。
- Mono 使用完整模式：媒体就绪后按既有规则触发 Codex Voice。
- Raymond 原用于媒体隔离测试的 `MEDIA_ONLY_MODE=true` 已在用户确认链路稳定后改为 `false`。其 LaunchAgent 路径为 `/Users/raymond/Library/LaunchAgents/com.gpt-live-remote.bridge.plist`；仅该 job 被重载，PID 由 17927 更新为 18143。
- Raymond 曾发生 Control WebSocket 1006 后 Node 进程仍存活但无 TCP socket的问题。只重启该机 Bridge LaunchAgent 后恢复单进程和在线状态；代码层自动恢复尚未实现，见 KI-015。
- 两台 Bridge 当前均为完整 Voice 模式。服务器能证明设备注册和在线，但设备协议不包含 `MEDIA_ONLY_MODE`，因此运行模式仍无法由 Control API 独立审计，是明确的可观测性风险。

## 运维与部署变化

- Control API 线上源码和构建已更新，只重启 `gpt-live-control.service`；未修改 PWA、LiveKit、Nginx 或无关服务。
- PWA 线上只同步 `page.tsx` 与 `globals.css`，随后只重启 `gpt-live-pwa.service`。
- 同步核对时，公网 `/gpt-live-remote` 返回 HTTP 200 且无重定向；PWA 两个源码文件与本地完全同哈希。
- 本次同步没有重启服务器服务、Bridge 或 Codex，也没有创建新媒体会话。

## 已部署、仅本地与未跟踪内容

### 已部署且已回写本地

- PWA 最新交互的两个源码文件。
- Control API 账号级单租约与 LiveKit 权限隔离源码。
- AGENTS 开发宪法及 KI-014/KI-015 故障边界说明。

### 同步前已提交、且晚于稳定标签

- `2e881be`：Live 设备与音频控制改进。
- `4862c7f`：Live 返回按钮移到最左侧。

### 与本轮同步无关、继续保留的未跟踪内容

- `design/`
- `docs/NETWORK_HEADSET_ARCHITECTURE.md`
- `docs/NETWORK_HEADSET_ARCHITECTURE_副本.md`
- `docs/NETWORK_HEADSET_MVP.md`

这些文件没有参与部署或本轮提交范围，不得据此推断线上行为。

## 仍待真实设备验证

1. 设备列表点击当前连接设备返回 Live、返回按钮、设备下拉、居中三点、精简 PTT 和下行静音在目标手机浏览器的全部细节交互。
2. PWA 刷新/恢复、权限拒绝后重新授权、多轮 PTT 与长连接的既有待复验项。
3. Raymond 改为完整 Voice 模式后的首次真实连接与 Voice 启停；配置重载本身只做了非媒体边界验证。

## 回归风险

- Raymond 的 WebSocket 1006 自愈尚未实现；进程“活着但无连接”时 LaunchAgent 不会自动恢复。
- `MEDIA_ONLY_MODE` 未在设备注册/心跳中上报，Control 端无法独立证明两台当前都处于完整模式。
- 账号切换逻辑为了避免串流会等待旧 Bridge 最多约 12 秒；旧 Bridge 无法确认停止时会明确拒绝新连接。这是安全失败，不应改成绕过停止直接连接。
- 静态构建、HTTP 200、在线状态和哈希一致都不代表多设备真实音频已经通过，稳定标签仍只代表用户此前确认的基线范围。
