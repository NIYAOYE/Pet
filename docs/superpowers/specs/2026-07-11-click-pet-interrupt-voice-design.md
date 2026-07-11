# 点击宠物打断语音 — 设计

> 2026-07-11 与用户 brainstorming 定下。承接 `docs/superpowers/specs/2026-07-09-gsv-tts-lite-voice-integration-design.md`
> 的 GSV-TTS-Lite 配音功能——真机验收时用户发现语音说到一半没有办法打断,只能靠发下一条消息隐式打断。

## 背景

现状梳理:

- **已有的隐式打断**:发送新消息时(`messageSent` 事件)会调用 `pcmPlayer.stop()` 停掉正在播放的语音
  (`src/renderer/main.ts:22-23`)。
- **完整但未接线的打断链路**:`IPC.CANCEL_CHAT` → `chat.cancel()` → 同时中止 LLM 流式生成、
  `voiceProvider.stop()`(中止在途语音合成)、`VOICE_PLAYBACK_STOP`(停播放)。但渲染层没有任何 UI
  调用这条链路——`preload` 暴露的 `voiceApi.stop()`/`chatApi.cancel()` 目前都是没人调用的死代码路径。
- 用户想要的是"点击宠物打断正在播放的语音",不需要连带打断整条回复的生成。

## 需求(brainstorming 定下)

- **触发方式**:点击宠物本体(单击或双击均可,不区分),只要正在播放语音就打断。
- **打断范围**:只停止音频播放,不影响 LLM 文字生成/气泡框文字——效果与现有 `messageSent` 时的打断
  完全一致,复用同一个 `pcmPlayer.stop()`,不涉及 `voiceProvider.stop()`/`CANCEL_CHAT` 那条更重的
  "取消整条回复"链路。
- 点击的两种既有语义(单击开/关对话框、双击 poke 反应)保持不变,打断只是在原有点击处理流程最前面
  多做一步。

## 实现

`src/renderer/main.ts` 的 `mouseup` 事件处理里,"非拖拽点击"分支(`else` 分支,约第 80-88 行)最前面
加一行 `pcmPlayer.stop()`,无条件执行——不需要额外判断"当前是否正在说话",因为 `pcmPlayer.stop()`
在没有音频播放时本身就是空操作(`src/renderer/voice/pcmPlayer.ts:36-39`:内部 `sources` 数组为空时
循环体不执行,函数直接返回)。之后照常走原有的单击/双击判定逻辑,不受影响。

**为什么点击天然只命中宠物本体**:透明宠物窗口靠 `player.isPetPixel()` 控制
`setIgnoreMouseEvents`(`main.ts:69`),点在透明区域的鼠标事件本来就穿透到窗口下方的其它程序,
不会触发 canvas 的 `mousedown`/`mouseup`——不需要额外判断"点击位置是否落在宠物身上"。

## 不做的事

- 不新增 IPC 通道,不碰后端 `voiceProvider.stop()`/`IPC.CANCEL_CHAT`(那条链路语义是"取消整条回复",
  比"只打断语音"重,本次不涉及,也不清理这条目前未接线的死代码——超出本次范围)。
- 不加打断时的视觉/音效反馈,保持最小改动。
- 不新增专门的停止按钮或快捷键(brainstorming 时明确选择了"点击宠物本体"这一种触发方式)。

## 测试

这是 DOM 事件绑定的 renderer 交互代码,项目里同类交互(如 `spritePlayer.ts` 的播放控制)靠
`pnpm dev`/`pnpm preview` 真机验证,不强求 Vitest 覆盖点击手势本身。`pcmPlayer.stop()`
是否已有测试覆盖其幂等性,在实施计划里确认;若没有,顺带补一个。
