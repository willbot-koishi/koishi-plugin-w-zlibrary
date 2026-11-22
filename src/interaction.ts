import { Context, h, type Fragment, type Session } from 'koishi'

type Send = (session: Session, content: Fragment) => Promise<string[]>
const yes = '✅'
const no = '❌'
const searching = '🔍'
const downloading = '⏳'
const uploading = '📤'

export function reactionId(platform: string, emoji: string) {
  // NapCat expects a decimal Unicode scalar, unlike Discord's literal emoji.
  return platform === 'onebot' ? `emoji|${emoji.codePointAt(0)}` : emoji
}

export function createInteractions(ctx: Context, send: Send, formatError: (error: unknown) => string, useReactions: boolean) {
  const prompts = new Map<string, { userId: string, answer: (keepWaiting: boolean) => void }>()
  const activeWaits = new Set<() => void>()
  let disposed = false
  const key = (session: Session, messageId: string) => JSON.stringify([session.sid, session.channelId, messageId])
  const log = (stage: string, error: unknown) => ctx.logger.warn('%s failed:\n%s', stage, formatError(error))
  const react = async (session: Session, messageId: string | undefined, emoji: string) => {
    if (!useReactions || disposed || !session.channelId || !messageId) return false
    try {
      await session.bot.createReaction(session.channelId, messageId, reactionId(session.platform, emoji))
      return true
    } catch (error) { log('zlib.interaction: add reaction', error); return false }
  }
  const mark = async (session: Session, emoji: string, fallback: string) => {
    let added = await react(session, session.messageId, emoji)
    if (!added && !disposed) {
      try { await send(session, h('as-forward', { level: 'never' }, fallback)) }
      catch (error) { log('zlib.interaction: send status', error) }
    }
    return async () => {
      if (!added) return
      added = false
      try {
        await session.bot.deleteReaction(session.channelId!, session.messageId!, reactionId(session.platform, emoji))
      } catch (error) { log('zlib.interaction: remove reaction', error) }
    }
  }
  ctx.on('reaction-added', (session) => {
    if (!useReactions || !session.messageId || session.userId === session.selfId) return
    const prompt = prompts.get(key(session, session.messageId))
    if (!prompt || prompt.userId !== session.userId) return
    // The current Discord adapter stores Unicode reactions in content rather
    // than event.emoji. Keep the fallback scoped to that adapter.
    const emoji = session.event.emoji?.id ?? (session.platform === 'discord' ? session.content : undefined)
    for (const [choice, accepted] of [[yes, true], [no, false]] as const) {
      const id = reactionId(session.platform, choice)
      if (emoji === id || (session.platform === 'onebot' && emoji === id.slice('emoji|'.length))) {
        prompt.answer(accepted)
        return
      }
    }
  })
  ctx.on('dispose', () => {
    disposed = true
    for (const close of activeWaits) close()
  })
  return {
    search: (session: Session) => mark(session, searching, '已开始搜索，请稍候……'),
    download: (session: Session) => mark(session, downloading, '正在下载书籍，请稍候……'),
    upload: (session: Session) => mark(session, uploading, '正在上传书籍，请稍候……'),
    wait(session: Session, controller: AbortController, delay: number) {
      let active = true
      let cancelStart: (() => void) | undefined
      let cancelExpiry: (() => void) | undefined
      let disposeText: (() => void) | undefined
      const keys: string[] = []
      const close = () => {
        if (!active) return
        active = false
        cancelStart?.()
        cancelExpiry?.()
        disposeText?.()
        for (const id of keys) prompts.delete(id)
        activeWaits.delete(close)
        controller.signal.removeEventListener('abort', close)
      }
      const answer = (keepWaiting: boolean) => {
        if (!active) return
        // Consume synchronously; a second reaction cannot reverse the choice.
        close()
        if (!keepWaiting) controller.abort()
      }
      const ask = async () => {
        try {
          const expiry = session.app.koishi.config.delay.prompt
          const instruction = useReactions
            ? '请查询者跟贴 ✅ 继续、❌ 取消；reaction 不可用时可回复 y / n。'
            : '请查询者回复 y / yes 继续，n / no / 取消终止。'
          const ids = await send(session, h('as-forward', { level: 'never' },
            `下载已超过 ${delay / 1000} 秒，是否继续等待？${instruction}${expiry / 1000} 秒内未回应则取消。`))
          if (!active) return
          for (const id of useReactions ? ids : []) {
            const promptKey = key(session, id)
            keys.push(promptKey)
            prompts.set(promptKey, { userId: session.userId!, answer })
          }
          cancelExpiry = ctx.setTimeout(() => answer(false), expiry)
          const seeded = useReactions ? await Promise.all(ids.flatMap(id => [react(session, id, yes), react(session, id, no)])) : []
          if (!active || (seeded.length && seeded.every(Boolean))) return
          // Use text when reactions are disabled or unavailable.
          disposeText = session.middleware((reply, next) => {
            if (reply.sid !== session.sid || reply.elements?.some(element => element.type !== 'text')) return next()
            const input = reply.content?.trim() ?? ''
            if (!/^(?:y|yes|n|no|取消)$/i.test(input)) return next()
            answer(/^(?:y|yes)$/i.test(input))
          })
        } catch (error) {
          if (!active) return
          log('zlib.interaction: ask to continue', error)
          answer(false)
        }
      }
      activeWaits.add(close)
      if (disposed || controller.signal.aborted) {
        close()
        return close
      }
      controller.signal.addEventListener('abort', close, { once: true })
      cancelStart = ctx.setTimeout(() => { if (active) void ask() }, delay)
      return close
    },
  }
}
