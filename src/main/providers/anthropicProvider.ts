import Anthropic from '@anthropic-ai/sdk'
import type { LlmProvider, StreamChatRequest } from './llmProvider'
import type { StreamChunk } from '@shared/llm'
import { toAnthropicMessages, type AnthropicMessageLike } from './messageMapping'

const EPHEMERAL = { type: 'ephemeral' as const }

/**
 * Anthropic 的 prompt caching 不是自动的,必须显式打 cache_control 断点,否则多轮
 * 工具循环每一轮都全价重发全部历史。断点两处:system 块(缓存 tools+persona 前缀)、
 * 最后一条消息的最后一个块(缓存整段对话,供下一轮增量复用)。纯函数,便于单测;
 * 输入是 toAnthropicMessages 的新鲜产物,原地修改无副作用外泄。
 */
export function withCacheBreakpoints(
  system: string,
  messages: AnthropicMessageLike[]
): { system: string | Array<Record<string, unknown>>; messages: AnthropicMessageLike[] } {
  const sys = system
    ? [{ type: 'text', text: system, cache_control: EPHEMERAL }]
    : system
  const last = messages[messages.length - 1]
  if (last) {
    if (typeof last.content === 'string') {
      if (last.content) last.content = [{ type: 'text', text: last.content, cache_control: EPHEMERAL }]
    } else if (last.content.length > 0) {
      last.content[last.content.length - 1].cache_control = EPHEMERAL
    }
  }
  return { system: sys, messages }
}

/** SDK 流事件的结构化最小集(供归一化与测试;真实事件结构兼容此形状) */
export interface AnthropicStreamEventLike {
  type: string
  content_block?: { type: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
}

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

export function createAnthropicProvider(opts: { apiKey: string; baseURL?: string; model: string }): LlmProvider {
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL })
  return {
    async *streamChat(req: StreamChatRequest): AsyncIterable<StreamChunk> {
      try {
        const { system, messages } = withCacheBreakpoints(req.system, toAnthropicMessages(req.messages))
        // 最后一个工具定义也打断点:agentLoop 在临近轮数上限时会改 system,此时
        // system 断点失效,但 tools 前缀仍可命中缓存
        const tools = req.tools?.map((t, i) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
          ...(i === req.tools!.length - 1 ? { cache_control: EPHEMERAL } : {})
        }))
        const stream = client.messages.stream(
          {
            model: opts.model,
            max_tokens: req.maxOutputTokens,
            system: system as never,
            messages: messages as never,
            ...(tools && tools.length > 0 ? { tools: tools as never } : {})
          },
          { signal: req.signal }
        )
        yield* normalizeAnthropicEvents(stream as AsyncIterable<AnthropicStreamEventLike>)
      } catch (err) {
        if (req.signal.aborted) return
        yield { type: 'error', message: String((err as Error)?.message ?? err) }
      }
    }
  }
}
