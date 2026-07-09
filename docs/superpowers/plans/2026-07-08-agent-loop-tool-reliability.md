# Agent 工具调用循环健壮性改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `agentLoop.ts` 把"模型正常说完"和"被截断、什么都没吐出来"混为一谈的 bug(真机复现:gpt-5.5 多步自动化任务中途完全静止),并给工具调用意愿弱的模型(gpt-5.4/gpt-5.4-mini)补上模型无关的强制性执行规范提示词。

**Architecture:** 给 `StreamChunk` 的 `done` 分支透传 `finishReason`(两个 provider 的 normalize 函数各自补齐),`agentLoop.ts` 据此区分"正常收尾"与"疑似截断的空轮",对后者做有限次数的原地重试并临时给 `system` 追加提示;临近轮数上限时同样临时给 `system` 追加提醒。`promptAssembler.ts` 新增一段与 persona 无关、始终注入(当有工具时)的"工具执行规范"小节。

**Tech Stack:** TypeScript, Vitest(既有测试框架与惯例),Electron 主进程代码(不涉及 renderer/preload)。

## Global Constraints

- 不新增依赖、不新增设置项、不改 UI。
- `system` 的临时追加内容只作用于当次发给 provider 的请求,绝不写入 `messages` 历史(避免打破 Anthropic 角色交替约束)。
- 所有改动需配套 Vitest 单测,遵循仓库现有测试文件的组织与断言风格(`toEqual`/`toContain` 为主,中文 `it()` 描述)。
- 诊断日志沿用仓库现有 `console.log/warn` 风格(无专门 logger 模块),不引入新依赖。
- 设计文档:`docs/superpowers/specs/2026-07-08-agent-loop-tool-reliability-design.md`(本计划的依据,如有疑义以其为准)。

---

### Task 1: `StreamChunk.done` 透传 `finishReason` + openai-compat provider 补齐

**Files:**
- Modify: `src/shared/llm.ts:15-19`(`StreamChunk` 类型)
- Modify: `src/main/providers/openaiCompatProvider.ts:22-51`(`normalizeOpenAiChunks`)
- Test: `src/main/providers/openaiCompatProvider.test.ts`(修改 2 处既有断言 + 新增 1 个用例)

**Interfaces:**
- Produces: `StreamChunk` 的 `done` 分支变为 `{ type: 'done'; finishReason?: string }`,供 Task 2(Anthropic provider)与 Task 3(`agentLoop.ts`)使用。

- [ ] **Step 1: 改 `StreamChunk` 类型**

`src/shared/llm.ts:15-19` 改为:

```ts
export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolUse: ToolUse }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string }
```

- [ ] **Step 2: 更新两处因 `done` 分支新增字段而需要改的既有断言**

`src/main/providers/openaiCompatProvider.test.ts:15-25`(第一个用例)改为:

```ts
  it('delta.content → text chunk,末尾补 done', async () => {
    const chunks = await collect(normalizeOpenAiChunks(feed([
      { choices: [{ delta: { content: '你好' } }] },
      { choices: [{ delta: { content: '呀' }, finish_reason: 'stop' }] }
    ])))
    expect(chunks).toEqual([
      { type: 'text', text: '你好' },
      { type: 'text', text: '呀' },
      { type: 'done', finishReason: 'stop' }
    ])
  })
```

`src/main/providers/openaiCompatProvider.test.ts:27-38`(第二个用例,`tool_calls` 聚合)改为:

```ts
  it('tool_calls 分片(id/name 先到,arguments 分批)按 index 聚合,finish_reason=tool_calls 时吐齐', async () => {
    const chunks = await collect(normalizeOpenAiChunks(feed([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"AI 新闻"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ])))
    expect(chunks).toEqual([
      { type: 'tool_use', toolUse: { id: 'call_1', name: 'web_search', input: { query: 'AI 新闻' } } },
      { type: 'done', finishReason: 'tool_calls' }
    ])
  })
```

- [ ] **Step 3: 写新增失败用例(`finish_reason` 透传到 `done`)**

在 `src/main/providers/openaiCompatProvider.test.ts` 末尾(`describe('normalizeOpenAiChunks', ...)` 块内,最后一个 `it` 之后)新增:

```ts
  it('finish_reason 透传到末尾的 done chunk(供 agentLoop 区分截断与正常收尾)', async () => {
    const chunks = await collect(normalizeOpenAiChunks(feed([
      { choices: [{ delta: {}, finish_reason: 'length' }] }
    ])))
    expect(chunks).toEqual([{ type: 'done', finishReason: 'length' }])
  })
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm vitest run src/main/providers/openaiCompatProvider.test.ts`
Expected: 新增用例 FAIL(实际 `done` chunk 不带 `finishReason`),Step 2 改过的两个用例也 FAIL(同样原因)。

- [ ] **Step 5: 实现——`normalizeOpenAiChunks` 记录并透传 `finish_reason`**

`src/main/providers/openaiCompatProvider.ts:22-51` 改为:

```ts
export async function* normalizeOpenAiChunks(parts: AsyncIterable<OpenAiChunkLike>): AsyncIterable<StreamChunk> {
  const calls = new Map<number, { id: string; name: string; args: string }>()
  let finishReason: string | undefined
  for await (const part of parts) {
    const choice = part.choices?.[0]
    if (!choice) continue
    const text = choice.delta?.content
    if (text) yield { type: 'text', text }
    for (const tc of choice.delta?.tool_calls ?? []) {
      const slot = calls.get(tc.index) ?? { id: '', name: '', args: '' }
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name = tc.function.name
      if (tc.function?.arguments) slot.args += tc.function.arguments
      calls.set(tc.index, slot)
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
    // "length" = 回复因达到 max_tokens 被截断(OpenAI 兼容端点的截断信号)。截断可能发生在
    // 工具调用参数生成到一半的时候,此时也必须把已聚合到的部分吐出——不然模型的工具调用
    // 意图会连同那部分参数一起被静默丢弃,agentLoop 那一轮直接收尾成纯文本回复,用户和
    // 模型都不知道工具从未被调用过(真机验证复现的真实 bug)。参数解析失败就回退 {},
    // 交给 registry 校验兜底报错,好过整个调用凭空消失。
    if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'length') {
      for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        let input: unknown = {}
        try { input = c.args ? JSON.parse(c.args) : {} } catch { input = {} }
        yield { type: 'tool_use', toolUse: { id: c.id, name: c.name, input } }
      }
      calls.clear()
    }
  }
  yield { type: 'done', finishReason }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run src/main/providers/openaiCompatProvider.test.ts`
Expected: 全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/shared/llm.ts src/main/providers/openaiCompatProvider.ts src/main/providers/openaiCompatProvider.test.ts
git commit -m "feat(agent): StreamChunk.done 透传 finish_reason(openai-compat)"
```

---

### Task 2: Anthropic provider 补齐 `finishReason` + 中途截断兜底 flush

**Files:**
- Modify: `src/main/providers/anthropicProvider.ts:6-37`
- Test: `src/main/providers/anthropicProvider.test.ts`(新增 2 个用例,既有用例不受影响)

**Interfaces:**
- Consumes: Task 1 的 `StreamChunk` 类型(`done` 分支带 `finishReason?: string`)。
- Produces: 同 Task 1,供 Task 3 使用;`AnthropicStreamEventLike.delta` 新增可选 `stop_reason` 字段。

- [ ] **Step 1: 扩展 `AnthropicStreamEventLike` 类型,支持 `message_delta` 事件的 `stop_reason`**

`src/main/providers/anthropicProvider.ts:6-11` 改为:

```ts
export interface AnthropicStreamEventLike {
  type: string
  content_block?: { type: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
}
```

- [ ] **Step 2: 写新增失败用例——`message_delta.stop_reason` 透传到 `done`**

在 `src/main/providers/anthropicProvider.test.ts` 的 `describe('normalizeAnthropicEvents', ...)` 块内追加:

```ts
  it('message_delta 的 stop_reason 透传到 done(max_tokens 归一为 length)', async () => {
    const chunks = await collect(normalizeAnthropicEvents(feed([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '嗯' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }
    ])))
    expect(chunks).toEqual([
      { type: 'text', text: '嗯' },
      { type: 'done', finishReason: 'length' }
    ])
  })

  it('正常结束(end_turn)时 finishReason 原样透传,不归一', async () => {
    const chunks = await collect(normalizeAnthropicEvents(feed([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ])))
    expect(chunks).toEqual([{ type: 'done', finishReason: 'end_turn' }])
  })

  it('tool_use 块中途因 max_tokens 截断(content_block_stop 未到达):流结束时兜底 flush 出已聚合的部分', async () => {
    const chunks = await collect(normalizeAnthropicEvents(feed([
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_9', name: 'type_text' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"text":"被截断的很长一段文' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }
      // 注意:没有 content_block_stop 事件——真实截断场景下它不会到来
    ])))
    expect(chunks[0].type).toBe('tool_use')
    expect((chunks[0] as { toolUse: { name: string; id: string; input: unknown } }).toolUse).toEqual({
      name: 'type_text',
      id: 'tu_9',
      input: {} // JSON 不完整(截断在字符串中间),解析失败回退 {},交给 registry 校验兜底报错
    })
    expect(chunks[chunks.length - 1]).toEqual({ type: 'done', finishReason: 'length' })
  })
```

- [ ] **Step 3: 运行测试确认新增用例失败**

Run: `pnpm vitest run src/main/providers/anthropicProvider.test.ts`
Expected: 新增 3 个用例 FAIL(当前实现既不处理 `message_delta`,也不在流结束时 flush 未闭合的 `tool_use` 块)。既有 4 个用例仍 PASS(它们的事件流不含 `message_delta`,`finishReason` 保持 `undefined`,`toEqual({ type: 'done' })` 因 `undefined` 字段被 `toEqual` 忽略而继续成立)。

- [ ] **Step 4: 实现——记录 `stop_reason` + 流结束时兜底 flush**

`src/main/providers/anthropicProvider.ts:18-37` 改为:

```ts
/**
 * 把 Anthropic 流事件归一成统一 chunk 协议:
 * tool_use 块从 content_block_start 开始聚合 input_json_delta,到 stop 才吐完整
 * ToolUse(绝不吐半截 JSON);input 解析失败时回退 {},由 registry 校验兜底。
 * message_delta.stop_reason 记录为 finishReason(max_tokens 归一为 'length',与 openai-compat
 * 的 finish_reason 语义对齐,供 agentLoop 统一判断)。若流在 tool_use 块中途因 max_tokens
 * 截断(content_block_stop 未到达),流结束时兜底 flush 已聚合到的部分——避免整个工具调用
 * 意图被静默丢弃(与 openai-compat 侧的同类截断修复对应)。
 */
export async function* normalizeAnthropicEvents(
  events: AsyncIterable<AnthropicStreamEventLike>
): AsyncIterable<StreamChunk> {
  let current: { id: string; name: string; json: string } | null = null
  let finishReason: string | undefined
  for await (const event of events) {
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      current = { id: event.content_block.id ?? '', name: event.content_block.name ?? '', json: '' }
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && current) {
      current.json += event.delta.partial_json ?? ''
    } else if (event.type === 'content_block_stop' && current) {
      let input: unknown = {}
      try { input = current.json ? JSON.parse(current.json) : {} } catch { input = {} }
      yield { type: 'tool_use', toolUse: { id: current.id, name: current.name, input } }
      current = null
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      yield { type: 'text', text: event.delta.text ?? '' }
    } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
      finishReason = event.delta.stop_reason === 'max_tokens' ? 'length' : event.delta.stop_reason
    }
  }
  if (current) {
    let input: unknown = {}
    try { input = current.json ? JSON.parse(current.json) : {} } catch { input = {} }
    yield { type: 'tool_use', toolUse: { id: current.id, name: current.name, input } }
  }
  yield { type: 'done', finishReason }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run src/main/providers/anthropicProvider.test.ts`
Expected: 全部 PASS(7 个用例)。

- [ ] **Step 6: Commit**

```bash
git add src/main/providers/anthropicProvider.ts src/main/providers/anthropicProvider.test.ts
git commit -m "fix(agent): Anthropic 流中途截断时兜底 flush 未闭合的 tool_use + 透传 finish_reason"
```

---

### Task 3: `agentLoop.ts` —— 区分截断与正常收尾、有限重试、轮次预算提醒、诊断日志

**Files:**
- Modify: `src/main/agent/agentLoop.ts`
- Test: `src/main/agent/agentLoopTools.test.ts`(新增 3 个用例)

**Interfaces:**
- Consumes: Task 1/2 产出的 `StreamChunk`(`done` 分支 `finishReason?: string`);`createFakeProvider({ script })`(已存在,`src/main/providers/fakeProvider.ts`,无需改动,`script` 里的 chunk 可以直接带 `finishReason` 字段)。
- Produces: 新增导出常量 `MAX_TRUNCATED_RETRIES`(供测试断言重试上限),`runAgent` 的公开签名 (`AgentRunOptions`/`AgentRunResult`) 不变。

- [ ] **Step 1: 写新增失败用例——截断空轮触发重试并最终成功**

在 `src/main/agent/agentLoopTools.test.ts` 的 `describe('runAgent 多轮工具循环', ...)` 块内追加(紧跟"到达轮数上限"用例之后):

```ts
  it('本轮无输出且 finishReason=length(被截断):自动重试而非静默收尾', async () => {
    const { spec, calls } = searchTool()
    const res = await runAgent({
      ...base([
        [{ type: 'done', finishReason: 'length' }],
        [tu('t1', 'AI'), done],
        [text('查到了'), done]
      ], spec),
      onText: () => {}
    })
    expect(res.error).toBeUndefined()
    expect(res.text).toBe('查到了')
    expect(calls).toEqual([{ query: 'AI' }])
  })

  it('截断重试次数耗尽后:不再无限重试,按空文本正常收尾', async () => {
    const { spec, calls } = searchTool()
    const truncatedRounds = Array.from(
      { length: MAX_TRUNCATED_RETRIES + 2 },
      () => [{ type: 'done', finishReason: 'length' } as StreamChunk]
    )
    const res = await runAgent({ ...base(truncatedRounds, spec), maxToolRounds: 20, onText: () => {} })
    expect(res.error).toBeUndefined()
    expect(res.text).toBe('')
    expect(calls).toEqual([])
  })

  it('临近轮数上限时,发给 provider 的 system 里追加轮次预算提醒(不写入 messages 历史)', async () => {
    const { spec } = searchTool()
    const seenSystems: string[] = []
    const provider = {
      async *streamChat(req: { system: string }): AsyncIterable<StreamChunk> {
        seenSystems.push(req.system)
        yield { type: 'tool_use', toolUse: { id: `t${seenSystems.length}`, name: 'search', input: { query: 'q' } } }
        yield { type: 'done' }
      }
    }
    await runAgent({
      provider,
      registry: createToolRegistry([spec]),
      system: 'BASE',
      messages: [{ role: 'user', content: 'hi' }],
      maxToolRounds: 3,
      maxOutputTokens: 100,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      onText: () => {}
    })
    expect(seenSystems[0]).toBe('BASE')
    expect(seenSystems[1]).not.toBe('BASE')
    expect(seenSystems[1]).toContain('轮')
    expect(seenSystems[2]).toContain('轮')
  })
```

- [ ] **Step 2: 在测试文件顶部加上新用到的导入**

`src/main/agent/agentLoopTools.test.ts:1-6` 的 import 行改为(新增 `MAX_TRUNCATED_RETRIES`):

```ts
import { describe, it, expect } from 'vitest'
import { runAgent, MAX_TOOL_ROUNDS, MAX_TRUNCATED_RETRIES } from './agentLoop'
import { createFakeProvider } from '../providers/fakeProvider'
import { createToolRegistry } from '../tools/toolRegistry'
import type { ToolSpec } from '../tools/toolSpec'
import type { StreamChunk } from '@shared/llm'
```

- [ ] **Step 3: 运行测试确认新增用例失败**

Run: `pnpm vitest run src/main/agent/agentLoopTools.test.ts`
Expected: 编译期即报 `MAX_TRUNCATED_RETRIES` 不存在(`agentLoop.ts` 未导出);先跳过编译错误看逻辑失败可临时把该导入行注释掉 dry-run,或直接进入 Step 4 实现后一次性验证。此步骤只需确认："在实现之前,这些用例不可能通过"这一预期成立即可,不强求单独跑出一次编译错误的日志。

- [ ] **Step 4: 实现——`agentLoop.ts` 完整改动**

`src/main/agent/agentLoop.ts` 整体改为:

```ts
import type { LlmProvider } from '../providers/llmProvider'
import type { AgentMessage, ToolUse } from '@shared/llm'
import type { ToolRegistry } from '../tools/toolRegistry'

/** §5.6 硬循环上限:单次请求最多工具调用轮数 */
export const MAX_TOOL_ROUNDS = 6
/** 单次请求中,"被截断导致本轮无文本无工具调用"这种疑似异常情况最多原地重试几次,防止病态反复截断吃光轮次预算 */
export const MAX_TRUNCATED_RETRIES = 3
/** 临近 maxRounds 时,提前几轮开始在 system 里追加预算提醒 */
const ROUND_BUDGET_WARN_THRESHOLD = 2

const TRUNCATED_RETRY_NUDGE =
  '\n\n(系统提示:你上一轮回复被截断且没有产生任何输出,请直接调用工具继续任务,不要输出多余的思考过程。)'

function roundBudgetWarning(roundsLeftIncludingThis: number): string {
  return `\n\n(系统提示:本次任务你还剩 ${roundsLeftIncludingThis} 轮工具调用机会,请尽快完成当前动作或总结目前进度。)`
}

export interface AgentRunOptions {
  provider: LlmProvider
  system: string
  messages: AgentMessage[]
  registry?: ToolRegistry
  maxToolRounds?: number
  maxOutputTokens: number
  /** 每轮 provider 调用的超时(工具执行不计入,由取消信号兜底) */
  timeoutMs: number
  signal: AbortSignal
  onText: (text: string) => void
  onStatus?: (text: string) => void
}

export interface AgentRunResult { text: string; error?: string; canceled?: boolean }

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  if (opts.signal.aborted) return { text: '', canceled: true }

  const tools = opts.registry?.defs()
  const maxRounds = opts.maxToolRounds ?? MAX_TOOL_ROUNDS
  const messages: AgentMessage[] = [...opts.messages]
  let text = ''
  let truncatedRetries = 0
  let pendingRetryNudge = ''

  for (let round = 1; round <= maxRounds; round++) {
    // system 的临时追加只作用于这一次请求,绝不写回 messages 历史(避免打破 Anthropic
    // 要求 user/assistant 角色交替的约束——tool_result 批次本身就会映射成一条 user 消息,
    // 再插一条独立的 user 消息有连续同角色的风险)。
    let systemThisRound = opts.system + pendingRetryNudge
    pendingRetryNudge = ''
    const roundsLeftIncludingThis = maxRounds - round + 1
    if (roundsLeftIncludingThis <= ROUND_BUDGET_WARN_THRESHOLD) {
      systemThisRound += roundBudgetWarning(roundsLeftIncludingThis)
    }

    // 每轮独立的超时/取消桥接(沿用 MVP-03 的模式:外部 signal + 定时器 → 内部 abort)
    const internal = new AbortController()
    const onExternalAbort = (): void => internal.abort()
    opts.signal.addEventListener('abort', onExternalAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; internal.abort() }, opts.timeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onExternalAbort)
    }

    const toolUses: ToolUse[] = []
    let roundText = ''
    let finishReason: string | undefined
    try {
      for await (const chunk of opts.provider.streamChat({
        system: systemThisRound,
        messages,
        tools,
        maxOutputTokens: opts.maxOutputTokens,
        signal: internal.signal
      })) {
        // 取消/超时后立即停手,不再向 UI 推送被弃回复的文本(真实 SDK 不一定及时中止流)
        if (internal.signal.aborted) break
        if (chunk.type === 'text') { roundText += chunk.text; text += chunk.text; opts.onText(chunk.text) }
        else if (chunk.type === 'tool_use') toolUses.push(chunk.toolUse)
        else if (chunk.type === 'error') { cleanup(); return { text, error: chunk.message } }
        else if (chunk.type === 'done') { finishReason = chunk.finishReason; break }
      }
    } catch (err) {
      cleanup()
      if (opts.signal.aborted && !timedOut) return { text, canceled: true }
      return { text, error: timedOut ? '响应超时' : String((err as Error)?.message ?? err) }
    }
    cleanup()
    if (opts.signal.aborted && !timedOut) return { text, canceled: true }
    if (timedOut) return { text, error: '响应超时' }

    console.log(
      `[agentLoop] round ${round}/${maxRounds} finishReason=${finishReason ?? 'n/a'} toolUses=${toolUses.length} textLen=${roundText.length}`
    )

    // 纯文本收尾:正常结束。但 finishReason==='length' 且本轮既无文本也无工具调用时,
    // 大概率是推理/输出预算在生成可见内容前就被耗尽(真机复现:gpt-5.5 多步任务中途
    // 完全静止),而不是模型真的"正常说完了"——原地重试而不是当作收尾直接返回。
    if (toolUses.length === 0) {
      const looksTruncatedEmpty = finishReason === 'length' && roundText.trim() === ''
      if (looksTruncatedEmpty && truncatedRetries < MAX_TRUNCATED_RETRIES) {
        truncatedRetries++
        pendingRetryNudge = TRUNCATED_RETRY_NUDGE
        continue
      }
      return { text }
    }
    if (!opts.registry) return { text, error: '模型请求调用工具,但当前没有可用工具' }

    // 回灌顺序约束(anthropic):先一组 assistant tool_use,再一组 tool_result,同序配对。
    // 本轮已流出的文本挂在第一条 assistant_tool_use 上(mapper 会合并成一条消息)。
    toolUses.forEach((tu, i) => {
      messages.push({ role: 'assistant_tool_use', text: i === 0 && roundText ? roundText : undefined, toolUse: tu })
    })
    for (const tu of toolUses) {
      if (opts.signal.aborted) return { text, canceled: true }
      const r = await opts.registry.run(tu.name, tu.input, { signal: opts.signal, onStatus: opts.onStatus })
      if (opts.signal.aborted) return { text, canceled: true }
      messages.push({ role: 'tool_result', toolUseId: tu.id, content: r.content, isError: r.isError, images: r.images })
    }
  }

  return { text, error: '工具调用轮数达到上限,已停止;先基于目前查到的内容回复吧' }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run src/main/agent/agentLoopTools.test.ts src/main/agent/agentLoop.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: 跑一遍全量单测,确认没有连带破坏其它文件**

Run: `pnpm vitest run`
Expected: 全部 PASS(尤其关注 `chat.test.ts`,它间接经过 `agentLoop.ts`)。

- [ ] **Step 7: Commit**

```bash
git add src/main/agent/agentLoop.ts src/main/agent/agentLoopTools.test.ts
git commit -m "fix(agent): 区分截断空轮与正常收尾,有限重试 + 轮次预算提醒 + 诊断日志"
```

---

### Task 4: `promptAssembler.ts` 工具执行规范小节 + `chat.ts` 接入(含 token 预算上调)

**Files:**
- Modify: `src/main/agent/promptAssembler.ts`
- Modify: `src/main/shell/chat.ts:33`(常量)、`src/main/shell/chat.ts:220`(调用点)
- Test: `src/main/agent/promptAssembler.test.ts`(新增 1 个 describe 块,2 个用例)

**Interfaces:**
- Produces: `assemblePrompt(persona, transcript, skills?, memory?, nowMs?, hasTools?)`——新增第 6 个可选参数 `hasTools: boolean`(默认 `false`)。`chat.ts` 的 `runQuickAction` 分支(`chat.ts:124`)只传 `(persona, opts.memory.messages())` 两个参数,其余(含新参数)吃默认值,不用改动。

- [ ] **Step 1: 写新增失败用例**

在 `src/main/agent/promptAssembler.test.ts` 末尾追加:

```ts
describe('工具执行规范注入', () => {
  it('hasTools=true 时 system 含"工具执行规范"小节', () => {
    const { system } = assemblePrompt(persona, [], [], undefined, undefined, true)
    expect(system).toContain('# 工具执行规范')
  })

  it('hasTools 缺省(false)时不出现该小节', () => {
    const { system } = assemblePrompt(persona, [])
    expect(system).not.toContain('工具执行规范')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/agent/promptAssembler.test.ts`
Expected: 第一个新用例 FAIL(`assemblePrompt` 目前只接受 5 个参数,且不产出该小节)。

- [ ] **Step 3: 实现——`promptAssembler.ts` 改动**

`src/main/agent/promptAssembler.ts` 整体改为:

```ts
import type { ChatMessage } from '@shared/ipc'
import type { ChatTurn } from '@shared/llm'
import type { PersonaBlocks } from '../persona/personaLoader'
import type { SkillMeta } from '../skills/skillLoader'

export interface AssembledPrompt { system: string; messages: ChatTurn[] }

/** 召回的记忆上下文;memoryManager.RecallResult 结构兼容 */
export interface MemoryContext { facts: string[]; summary?: string }

export const WINDOW_TURNS = 12

function skillsSection(skills: SkillMeta[]): string {
  if (skills.length === 0) return ''
  return (
    '\n\n# 可用技能\n' +
    '你有以下技能;当用户的请求匹配某个技能的用途时,先用 read_skill 工具读取它的完整说明再照做:\n' +
    skills.map((s) => `- ${s.name}:${s.description}`).join('\n')
  )
}

/**
 * 模型无关的 agentic 执行硬规矩,不依赖各宠物 persona.md 的散文式文案——弱模型(工具调用
 * 意愿弱)也能靠这段结构化指令得到约束,而不是完全指望人设文本里恰好提到类似要求。
 * 只在确实有工具可用时注入(无工具的场景,如剪贴板加工快捷指令,注入这段没有意义)。
 */
function toolExecutionSection(hasTools: boolean): string {
  if (!hasTools) return ''
  return (
    '\n\n# 工具执行规范\n' +
    '1. 需要执行动作时必须真正调用工具,不能只用文字描述"我将要……"却不实际调用。\n' +
    '2. 有视觉反馈的动作(点击/输入等)前后配合 take_screenshot 验证执行结果。\n' +
    '3. 任务未完成不要提前结束回复;只有需要用户确认或介入时,才可以用文字说明并停下来等待。'
  )
}

/** §5.4:[人设分块]+[召回的长期记忆]+[工作记忆摘要],记忆为空时对应小节整体省略 */
function memorySection(memory?: MemoryContext): string {
  if (!memory) return ''
  let out = ''
  if (memory.facts.length > 0) {
    out +=
      '\n\n# 关于用户的记忆\n以下是你之前记住的关于用户的事实,回答时自然地用上,不要生硬复述:\n' +
      memory.facts.map((f) => `- ${f}`).join('\n')
  }
  if (memory.summary) out += `\n\n# 上次对话摘要\n${memory.summary}`
  return out
}

function timeSection(nowMs?: number): string {
  if (nowMs === undefined) return ''
  return (
    '# 当前时间\n现在是 ' + new Date(nowMs).toLocaleString('zh-CN') +
    '。当用户说"X分钟后/今天下午3点"等相对时间时,据此换算成绝对时间再调用工具。\n\n'
  )
}

export function assemblePrompt(
  persona: PersonaBlocks,
  transcript: ChatMessage[],
  skills: SkillMeta[] = [],
  memory?: MemoryContext,
  nowMs?: number,
  hasTools = false
): AssembledPrompt {
  const system =
    timeSection(nowMs) +
    [persona.persona, persona.voice, persona.behavior, persona.tools]
      .filter((s) => s.trim().length > 0)
      .join('\n\n') +
    toolExecutionSection(hasTools) +
    skillsSection(skills) +
    memorySection(memory)

  let window = transcript.slice(-WINDOW_TURNS)
  while (window.length > 0 && window[0].role !== 'user') window = window.slice(1)
  const messages: ChatTurn[] = window.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text
  }))
  return { system, messages }
}
```

- [ ] **Step 4: 运行测试确认新增用例通过,既有用例未受影响**

Run: `pnpm vitest run src/main/agent/promptAssembler.test.ts src/main/agent/promptAssemblerSkills.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: `chat.ts` 接入 `hasTools` + 上调 desktopControl 输出 token 预算**

`src/main/shell/chat.ts:26-33` 改为:

```ts
const TIMEOUT_MS = 60000
const MAX_OUTPUT_TOKENS = 1024
// 桌面控制开启时提高单轮输出 token 上限:宠物人设旁白 + 工具调用参数(尤其
// take_screenshot 之后的分析文字、type_text 的长文本)容易一起挤爆默认的 1024,
// 真机验证复现过:回复被截断导致工具调用的 JSON 参数不完整,模型"有输入的意图
// 但从未真正调用成功"——见 messageMapping/agentLoop 对截断的兜底(该兜底防止静默
// 失败,但更大的预算能从源头降低触发概率)。推理模型(如 gpt-5.5)的内部思考也计入
// 输出预算,4096 偏紧、容易在生成可见内容前就被截断,调到 8192。
const DESKTOP_CONTROL_MAX_OUTPUT_TOKENS = 8192
```

`src/main/shell/chat.ts:220` 这一行:

```ts
        const { system, messages } = assemblePrompt(persona, opts.memory.messages(), opts.skills.list(), recalled, Date.now())
```

改为(第 6 个参数用当轮实际工具列表长度判断,而不是硬编码 `true`,保持对未来"工具列表可能为空"场景的正确性):

```ts
        const { system, messages } = assemblePrompt(
          persona,
          opts.memory.messages(),
          opts.skills.list(),
          recalled,
          Date.now(),
          tools.length > 0
        )
```

- [ ] **Step 6: 运行 chat.ts 相关测试确认未破坏既有行为**

Run: `pnpm vitest run src/main/shell/chat.test.ts`
Expected: 全部 PASS(尤其 `src/main/shell/chat.test.ts:206-224` 两个关于 `maxOutputTokens` 的用例,断言的是 `toBeGreaterThan(1024)` / `toBe(1024)`,不依赖具体数值,8192 不会破坏它们)。

- [ ] **Step 7: 跑一遍全量单测 + typecheck,确认整体无回归**

Run: `pnpm typecheck && pnpm vitest run`
Expected: 全部 PASS。

- [ ] **Step 8: Commit**

```bash
git add src/main/agent/promptAssembler.ts src/main/agent/promptAssembler.test.ts src/main/shell/chat.ts
git commit -m "feat(agent): 注入模型无关的工具执行规范提示词 + 桌面控制输出 token 预算上调到 8192"
```

---

### Task 5(真机验证,非自动化任务,人工执行)

自动化测试无法覆盖真实模型行为。此任务不产出代码提交,只在实施完 Task 1-4 后,由人工在真实 Windows 环境下验证:

- [ ] 开启 `desktopControl`,依次用 gpt-5.4-mini / gpt-5.4 / gpt-5.5 三个模型跑「打开浏览器,转到 bilibili 的网页」。
- [ ] 用 gpt-5.5 额外跑一个步骤更多的自动化任务(至少 5-6 步),观察是否还会"完全静止";若命中过截断重试分支,检查控制台 `[agentLoop]` 日志确认 `finishReason=length` 且触发了重试、重试后是否成功续上。
- [ ] 观察 gpt-5.4 / gpt-5.4-mini 在新增"工具执行规范"提示词下,是否比改动前更愿意持续调用工具完成多步任务(不要求 100%,只需有可观察的改善)。
- [ ] 若真机验证发现新问题,回到 brainstorming 流程另开一轮设计,不在本计划内直接改代码。
