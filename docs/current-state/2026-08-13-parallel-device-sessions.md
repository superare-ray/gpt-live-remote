# 2026-08-13 多设备并行会话模型

## 用户确认的业务语义

- 点击设备 B 后立即留在 Live 页面并把顶部目标改为 B，状态先显示“正在连接”；不等待 A 停止，也不返回设备管理页。
- A 的 LiveKit Room、Bridge 媒体和 Codex Voice 保持，但手机对 A 上行 mute、下行 unsubscribe。手机只与当前选择的 B 交换音频。
- B 上行 publication 和下行 subscription 都就绪后才显示音频“已连接”；Codex Voice ready 后才显示 PTT。若 Voice 已经有真实 CoreAudio 输入，Bridge 不重复发送快捷键。
- B 网络异常时只要用户仍停留在 B 的 Live 页就原地自动重连；用户主动断开、离开 Live、权限失败和空闲回收均不自动重连。
- 每台设备从创建或最近一次用户 `ptt_unmuted` 起独立计算15分钟空闲时间，到期后停止该设备会话。
- B 连接失败时仍停留在 B 页显示失败，不自动退回 A。

## 实现边界

### PWA

- 新增 `DeviceSessionRuntime`，按设备封装 Room、LocalAudioTrack、远端 publication/audio element、AudioContext/analyser、control socket、stats 和清理路径。
- 切到后台的 runtime 保留房间与控制面，但同时 mute 本地轨道、unsubscribe 远端 publication 并暂停播放；切回时只恢复该 runtime。
- 页面刷新从 Control API 获取全部活动会话，只按 `localStorage` 记录的最后 Live 设备恢复前台媒体。其他设备仍由服务器和 Bridge 保持，选中时以新 token 加入。
- 设备管理可编辑显示名称，并在手机、Pad、MacBook、Mac mini 四种展示图标中选择；该字段不改变 Bridge 凭据或真实硬件。

### Control API

- 删除账号级唯一索引，改用 `remote_sessions_one_active_per_device`。同账号不同设备可并存，同设备的创建请求幂等复用现有会话。
- `GET /api/v1/sessions/active` 返回账号下全部活动会话及各自新的 phone token，同时保留单 `session` 字段作为部署切换兼容。
- 新增 `last_voice_at`；`ptt_unmuted` 更新该值并重新安排15分钟回收。控制 socket 断开或设备切换不重置空闲时间。
- LiveKit token 仍按 session UUID room 与发布 source 隔离，避免多设备 room 之间串流。
- 新增账号内设备资料 PATCH，仅允许修改名称和四种展示 kind。

### Mac Bridge

- `startAndVerifyVoice` 检测到 Codex 已有真实输入时直接返回 ready，不发送快捷键、不先关闭再重开。
- 每台 Mac 仍只允许一个 Bridge session；本次并行是账号跨设备并行，不允许同一 Bridge 多 session。

## 验证状态

- PWA lint/build：通过。
- Control API typecheck/build：通过。
- Mac Bridge typecheck、原生模块 build：通过。
- 未主动创建媒体会话、未触发 Codex Voice；多设备前后台 RTP、15分钟回收、网络重连和 Voice 复用等待用户真机验证。

## 回退

用户确认的稳定基线仍是 `stable-network-headset-v1-2026-08-13`。本轮变更尚未被用户提升为稳定里程碑；如出现回归，先保护当前工作并按边界比较 PWA runtime、Control 会话索引/计时器和 Bridge Voice 复用三部分，禁止直接重置整个仓库。
