# Design QA

- Source visual truth: `/var/folders/gk/m7lzdn7s2dxd1qjs_f_j4b5h0000gn/T/codex-clipboard-2819e5f3-2c36-4acc-8688-391e25ef4f04.jpg`
- Source pixels: 949 × 2048 (browser chrome included)
- Implementation: `https://8.137.116.27:9443/gpt-live-remote`
- Intended viewport: 390 × 844 CSS px, DPR 1
- State: authenticated Live voice session
- Density normalization: not completed because the rendered implementation could not be captured

## Full-view comparison evidence

The source screenshot was available. The deployed implementation could not be captured: both the connected Chrome preview and the in-app preview timed out while navigating to the TLS endpoint. Server health and the production build were verified separately, but code inspection is not accepted as visual evidence.

## Focused region comparison evidence

Blocked with the full-view capture. The required header controls, live waveform, circular PTT control, and connected-device state could not be compared visually.

## Findings

- P1: Browser-rendered evidence is missing, so responsive layout and visual polish cannot be signed off.
- P1: Real microphone permission, waveform response, GPT reply playback, and disconnect interaction require a real mobile-browser session.

## Comparison history

- Pass 1: source visual opened; implementation capture timed out in the connected Chrome preview.
- Pass 2: switched to the in-app preview; navigation to the deployed TLS endpoint also timed out.
- Code/build fixes completed before capture: compact header, smaller icon-only refresh control, circular PTT control, real analyser-driven three-dot waveform, standard Web Audio playback, connected/disconnect device states, and global pressed feedback.

## Implementation checklist

- Open the deployed URL on the phone and refresh once.
- Confirm device name and icon.
- Connect, hold PTT, observe the three real audio-level bars, hear the reply, then disconnect.
- Capture the Live screen at the same state for the final visual comparison.

final result: blocked

---

# 2026-08-15 Live 音频液态球 UI 验收

## 范围

- 将 Live 页中央三点波形替换为用户提供的 WebGPU 液态球。
- 仅复用附件中的 WGSL 视觉核心，不嵌入附件的完整 HTML、事件或页面生命周期。
- 沿用现有 `waveLevels`，只把峰值映射到动画流速；不修改采集、PTT、WebRTC、LiveKit 或 Bridge。

## 源码安全审查

- 审查源：`/Volumes/storage/home/.codex/attachments/796df9dd-c16f-4389-a006-800576926059/pasted-text.txt`
- SHA-256：`c954eb1b78fa0a46121069a27a19e297c02ec32e08e0ab3e0859d62b9a305d06`
- 未发现网络请求、外部依赖、动态代码执行、DOM 注入、存储、Cookie、设备权限、剪贴板、Worker 或跨窗口通信。
- WGSL 只有一个只读 uniform binding、`vs_main` 和 `fs_main`；未使用 storage write、atomic 或 `textureStore`。
- 结论：视觉核心可复用。生产组件额外实现 React 卸载清理、WebGPU device/buffer 销毁、页面隐藏暂停和不支持 WebGPU 时的三点 fallback。

## 视觉与交互对照

- 在 390 × 844 移动视口中对原始附件与 PWA 组件进行了同屏裁切对照。
- 使用原始 WGSL 和原始 120 项 uniform seed；球体轮廓、材质、绿色区域、白色高光、色散边缘和外发光一致。
- 默认输入电平为 0 时速度保持原值 `0.66`；输入峰值经平滑映射，最大速度为 `10`。
- 默认与最大速度分别截图；最大速度下相隔 350 ms 的画面有明显、连续的流动变化，无闪烁或跳相。
- PWA 深绿色背景保持原设计，球体固定为 172 × 172 CSS px；DPR 上限为 2，避免移动端无界像素开销。

## 工程检查

- React：高频音频电平通过 ref 传给渲染循环，不引入额外 React state 更新；effect 具有完整幂等清理。
- 兼容性：WebGPU 不可用、着色器编译失败、device lost 或运行错误时回退到原三点波形，不影响语音功能。
- 可访问性：视觉指示器保持 `aria-hidden`，不新增焦点或朗读噪声。
- 浏览器日志：本地预览无 WebGPU、React 或运行时错误。

## 结论

通过。未发现 P0、P1 或 P2 视觉/交互问题。真实手机浏览器的 WebGPU 支持与长时间性能仍由用户真机验收；不支持时会安全降级，不阻塞语音。
