import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, h, HTTP, Logger, type Plugin } from 'koishi'
import memory from '@koishijs/plugin-database-memory'
import Mock from '@koishijs/plugin-mock'
import * as plugin from '../src'
import * as forward from 'koishi-plugin-w-as-forward'
import { bookPath, ZLibraryClient } from '../src/client'
import { downloadFile } from '../src/download'

const origin = 'https://zlibrary.invalid'
const detail = '/book/12345/abc123/alice.html'
const opaque = '/book/AbC123def9/alice.html'
const fileUrl = 'https://files.example.invalid/alice.pdf?ticket=private-ticket'
const coverUrl = 'https://covers.example.invalid/alice.jpg'
const payload = Buffer.from('%PDF-1.4\n% public-domain test fixture\n%%EOF\n')
const book = {
  id: 12345, hash: 'abc123', title: 'Alice in Wonderland', author: 'Lewis Carroll',
  year: 1865, language: 'English', extension: 'pdf', filesize: payload.length, filesizeString: '1 KB',
  interestScore: '4.6', qualityScore: '4', href: `https://another-alias.invalid${opaque}`,
  cover: coverUrl,
}
const cookie = 'remix_userid=42; remix_userkey=test-session-key; cf_clearance=private-browser-cookie'

async function fixture(t: TestContext, options: {
  config?: Partial<plugin.Config>
  mode?: 'ok' | 'empty' | 'html' | 'unauthorized' | 'quota' | 'no-link' | 'disallowed' | 'bad-file' | 'headerless-html'
  search?: (query: string) => typeof book[] | Promise<typeof book[]>
  file?: (init: RequestInit, url: URL) => Promise<Response>
  cover?: (url: string) => Promise<{ url: string }>
  upload?: () => Promise<void>
  reaction?: (emoji: string) => Promise<void>
  promptTimeout?: number
} = {}) {
  const ctx = new Context({ delay: { message: 0, character: 0, prompt: options.promptTimeout ?? 100 } })
  const calls: Array<{ url: URL, init: RequestInit }> = []
  const uploads: Array<{ blob: Blob, info: Record<string, unknown> }> = []
  const coverUploads: Array<{ url: string, info: Record<string, unknown> }> = []
  const deleted: string[] = []
  const logs: string[] = []
  const reactions: Array<{ action: 'add' | 'remove', channelId: string, messageId: string, emoji: string }> = []
  const sent: Array<{ id: string, channelId: string, content: string }> = []
  let prompted!: () => void
  const promptReady = new Promise<void>(resolve => { prompted = resolve })
  const logTarget: Logger.Target = { record: record => {
    if (record.name === 'w-zlibrary') logs.push(record.content)
  } }
  Logger.targets.push(logTarget)
  t.after(() => { Logger.targets.splice(Logger.targets.indexOf(logTarget), 1) })
  t.mock.method(globalThis, 'fetch', async (value: URL, init: RequestInit) => {
    const url = new URL(value)
    calls.push({ url, init })
    if (url.hostname !== 'zlibrary.invalid') {
      assert.equal(new Headers(init.headers).get('cookie'), null)
      assert.equal(new Headers(init.headers).get('remix-userkey'), null)
      if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: fileUrl } })
      if (options.file) return options.file(init, url)
      if (options.mode === 'bad-file') return new Response('<html>Login required</html>', { headers: { 'content-type': 'text/html' } })
      if (options.mode === 'headerless-html') return new Response('<html>Login required</html>', { headers: { 'content-type': 'application/octet-stream' } })
      return new Response(payload, { headers: { 'content-type': 'application/pdf' } })
    }
    const headers = new Headers(init.headers)
    assert.equal(headers.get('cookie'), 'remix_userid=42; remix_userkey=test-session-key')
    assert.equal(headers.get('remix-userid'), '42')
    assert.equal(headers.get('remix-userkey'), 'test-session-key')
    assert.equal(headers.get('user-agent'), 'undici')
    assert.equal(init.redirect, 'error')
    if (options.mode === 'html') return new Response('<html>Browser challenge</html>', { headers: { 'content-type': 'text/html' } })
    if (options.mode === 'unauthorized') return new Response('{}', { status: 401 })
    let data: unknown
    if (url.pathname === '/eapi/user/profile') data = { user: { id: 42, name: 'test-account', downloads_today: options.mode === 'quota' ? 20 : 0, downloads_limit: 20 } }
    else if (url.pathname === '/eapi/book/search') data = {
      books: options.search ? await options.search((init.body as URLSearchParams).get('message')!) : options.mode === 'empty' ? [] : [book],
      pagination: { total_pages: 7 },
    }
    else if (url.pathname.endsWith('/file')) data = { file: options.mode === 'no-link' ? {} : { allowDownload: options.mode === 'disallowed' ? false : true, downloadLink: fileUrl } }
    else if (url.pathname.startsWith('/eapi/book/')) data = { book }
    else throw new Error(`Unexpected fixture route: ${url.pathname}`)
    return Response.json({ success: 1, ...data as object })
  })
  ctx.plugin(HTTP)
  t.mock.method(ctx.http, 'isLocal', async (value: string) => ['127.0.0.1', '[::1]', 'localhost'].includes(new URL(value).hostname))
  ctx.plugin(memory as unknown as Plugin.Constructor)
  ctx.set('assetsPro', {
    async uploadFromUrl(url: string, info: Record<string, unknown>) {
      coverUploads.push({ url, info })
      return options.cover ? options.cover(url) : { id: 'fixture-cover', url: 'https://assets.invalid/fixture-cover' }
    },
    async uploadFromFile(blob: Blob, info: Record<string, unknown>) {
      uploads.push({ blob, info })
      await options.upload?.()
      return { id: 'fixture-asset', url: 'https://assets.invalid/fixture-asset' }
    },
    async delete(id: string) { deleted.push(id); return true },
  } as unknown as Context['assetsPro'])
  const mock = ctx.plugin(Mock as Plugin.Constructor)
  ctx.plugin(forward)
  const fork = ctx.plugin(plugin, plugin.Config({ domain: 'zlibrary.invalid', cookie,
    pageSize: 30, reactionInteraction: true, selectionTimeout: 120_000, downloadTimeout: 60_000, maxFileSize: 100 * 1024 * 1024, ...options.config }))
  t.after(async () => { mock.dispose(); await ctx.stop() })
  await ctx.start()
  const bot = ctx.bots[0]
  const originalSend = bot.sendMessage.bind(bot)
  t.mock.method(bot, 'sendMessage', async (...args: Parameters<typeof bot.sendMessage>) => {
    const ids = await originalSend(...args)
    const result = ids.length ? ids : [`sent-${sent.length + 1}`]
    sent.push({ id: result[0], channelId: args[0], content: h.normalize(args[1]).join('') })
    return result
  })
  bot.createReaction = async (channelId: string, messageId: string, emoji: string) => {
    if (options.reaction) await options.reaction(emoji)
    reactions.push({ action: 'add', channelId, messageId, emoji })
    if (emoji === '❌' || emoji === 'emoji|10060') prompted()
  }
  bot.deleteReaction = async (channelId: string, messageId: string, emoji: string) => {
    reactions.push({ action: 'remove', channelId, messageId, emoji })
  }
  await ctx.mock.initUser('tester', 4)
  const react = (messageId: string, emoji: string, options: { userId?: string, channelId?: string, selfId?: string, platform?: string, content?: string } = {}) => {
    const session = ctx.mock.session({
      type: 'reaction-added', platform: options.platform ?? 'mock', selfId: options.selfId ?? bot.selfId,
      user: { id: options.userId ?? 'tester' }, channel: { id: options.channelId ?? 'private:tester', type: 1 },
      message: { id: messageId, content: options.content }, emoji: emoji ? { id: emoji } : undefined,
    })
    ctx.emit(session, 'reaction-added', session)
  }
  return { ctx, client: ctx.mock.client('tester'), calls, uploads, coverUploads, deleted, fork, logs, reactions, sent, react, promptReady }
}

test('accepts legacy numeric/hash and new opaque website links without trusting their host', () => {
  assert.equal(bookPath(detail, origin), '/eapi/book/12345/abc123')
  assert.equal(bookPath(`https://another.invalid${opaque}`, origin), '/eapi/book/AbC123def9')
  for (const url of ['/s/search', '/book/12345', '/book/12345/name.html', 'https://[']) {
    assert.throws(() => bookPath(url, origin), /详情链接/)
  }
})

test('searches via eAPI with options after multiword keywords, and reads real account quota', async (t) => {
  const { client, calls } = await fixture(t)
  await client.shouldReply('zlib.state', /已登录：test-account，今日已用 0\/20/)
  const replies = await client.receive('zlib.search Alice in Wonderland -p 2')
  assert.match(replies.join(''), /Alice in Wonderland[\s\S]*Lewis Carroll/)
  const query = calls.find(call => call.url.pathname === '/eapi/book/search')!
  assert.equal(query.init.method, 'POST')
  const form = query.init.body as URLSearchParams
  assert.equal(form.get('message'), 'Alice in Wonderland')
  assert.equal(form.get('page'), '2')
  assert.equal(form.get('limit'), '30')
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/file')).length, 0)
})

test('acknowledges the search before the results arrive without sending progress text', { timeout: 5000 }, async (t) => {
  let release!: (books: typeof book[]) => void
  let started!: () => void
  const gate = new Promise<typeof book[]>(resolve => { release = resolve })
  const searching = new Promise<void>(resolve => { started = resolve })
  t.after(() => release([]))
  const { client, reactions, sent } = await fixture(t, { search: () => { started(); return gate } })
  const result = client.receive('zlib.search Alice')
  await searching
  assert.equal(reactions[0].emoji, '🔍')
  assert.equal(reactions[0].action, 'add')
  assert.equal(sent.length, 0)
  release([book])
  assert.match((await result).join(''), /Alice in Wonderland/)
  assert.deepEqual(reactions.map(x => [x.action, x.emoji]), [['add', '🔍'], ['remove', '🔍']])
})

test('removes the search reaction even when the search fails', async (t) => {
  const { client, reactions } = await fixture(t, { search: async () => { throw new Error('search failed') } })
  assert.match((await client.receive('zlib.search Alice')).join(''), /请求失败/)
  assert.deepEqual(reactions.map(x => [x.action, x.emoji]), [['add', '🔍'], ['remove', '🔍']])
})

test('falls back to a text acknowledgement when the platform cannot react', async (t) => {
  const { client, logs } = await fixture(t, { reaction: async () => { throw new Error('reaction unavailable') } })
  const replies = (await client.receive('zlib.search Alice')).join('')
  assert.match(replies, /已开始搜索[\s\S]*Alice in Wonderland/)
  assert.doesNotMatch(replies, /请求失败/)
  assert.match(logs.join('\n'), /zlib.interaction: add reaction failed/)
})

test('uses text progress and direct number downloads when reaction interaction is disabled', async (t) => {
  const { client, reactions, logs } = await fixture(t, {
    config: { reactionInteraction: false },
    reaction: async () => { throw new Error('must not call reaction API') },
  })
  assert.match((await client.receive('zlib.search Alice')).join(''), /已开始搜索[\s\S]*Alice in Wonderland/)
  const result = (await client.receive('1')).join('')
  assert.match(result, /正在下载书籍[\s\S]*正在上传书籍[\s\S]*成功转存书籍[\s\S]*<file/)
  assert.doesNotMatch(result, /确认/)
  assert.deepEqual(reactions, [])
  assert.deepEqual(logs, [])
})

test('uses requester-scoped text decisions without reacting when reaction interaction is disabled', { timeout: 5000 }, async (t) => {
  for (const choice of ['yes', '取消']) await t.test(choice, async (t) => {
    let release!: () => void
    let asked!: () => void
    let signal!: AbortSignal
    const gate = new Promise<void>(resolve => { release = resolve })
    const promptSent = new Promise<void>(resolve => { asked = resolve })
    t.after(() => release())
    const { ctx, client, reactions, sent, react, uploads } = await fixture(t, {
      config: { reactionInteraction: false, downloadTimeout: 5 }, promptTimeout: 1000,
      file: async init => {
        signal = init.signal!
        await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])
        return new Response(payload)
      },
    })
    ctx.on('before-send', session => { if (session.content?.includes('是否继续等待')) asked() })
    const result = client.receive(`zlib.store.fetch ${detail}`)
    await promptSent
    await delay(5)
    const prompt = sent.find(x => x.content.includes('是否继续等待'))!
    assert.match(prompt.content, /回复 y \/ yes 继续/)
    assert.doesNotMatch(prompt.content, /reaction|跟贴|✅|❌/)
    react(prompt.id, '❌')
    await ctx.mock.client('another-user').shouldNotReply('取消')
    await ctx.mock.client('tester').shouldNotReply('ordinary chat')
    assert.equal(signal.aborted, false)
    await ctx.mock.client('tester').receive(choice)
    if (choice === 'yes') release()
    assert.match((await result).join(''), choice === 'yes' ? /成功转存/ : /已放弃下载/)
    assert.equal(uploads.length, choice === 'yes' ? 1 : 0)
    assert.deepEqual(reactions, [])
    assert.equal(sent.filter(x => x.content.includes('是否继续等待')).length, 1)
    await client.shouldReply('zlib.state', /已登录/)
  })
})

test('reads opaque book details without a download request or doubled domain', async (t) => {
  const { client, calls } = await fixture(t)
  const replies = await client.receive(`zlib.detail https://external-alias.invalid${opaque}`)
  assert.match(replies.join(''), /Alice in Wonderland/)
  assert.match(replies.join(''), /https:\/\/zlibrary.invalid\/book\/AbC123def9/)
  assert.doesNotMatch(replies.join(''), /https:\/\/zlibrary.invalidhttps|external-alias/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.pathname, '/eapi/book/AbC123def9')
})

test('transfers covers through assets for searches, details and stored lists', async (t) => {
  const { ctx, client, calls, coverUploads, uploads } = await fixture(t)
  for (const command of ['zlib.search Alice', `zlib.detail ${detail}`]) {
    const reply = (await client.receive(command)).join('')
    assert.match(reply, /<img src="https:\/\/assets.invalid\/fixture-cover"/)
    assert.doesNotMatch(reply, /covers.example.invalid/)
  }
  assert.equal(coverUploads.length, 2)
  assert.equal(uploads.length, 0)
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/file')).length, 0)
  await client.receive(`zlib.store.fetch ${detail}`)
  const reply = (await client.receive('zlib.store.list')).join('')
  assert.match(reply, /<img src="https:\/\/assets.invalid\/fixture-cover"/)
  assert.doesNotMatch(reply, /covers.example.invalid/)
  assert.equal(coverUploads.length, 3)
  assert.ok(coverUploads.every(upload => upload.url === coverUrl))
  assert.ok(coverUploads.every(upload => upload.info.categoryId === 'zlibrary-cover'))
  assert.equal(uploads[0].info.categoryId, 'zlibrary')
  // Keep the source URL in stored metadata; assets URLs follow the provider's
  // lifetime and should only replace the image URL in the outgoing message.
  assert.equal((await ctx.database.get('w-zlibrary-stored-book', 1))[0].coverUrl, coverUrl)
})

test('does not upload images for books without a cover', async (t) => {
  const { client, coverUploads } = await fixture(t, { search: () => [{ ...book, cover: '' }] })
  const reply = (await client.receive('zlib.search Alice')).join('')
  assert.match(reply, /Alice in Wonderland/)
  assert.doesNotMatch(reply, /<img|\[封面\]/)
  assert.equal(coverUploads.length, 0)
})

test('omits failed covers without failing queries or forwarding the source URL', async (t) => {
  const { client, calls, logs } = await fixture(t, { cover: async () => {
    throw Object.assign(new Error(`cover transfer failed; Cookie: ${cookie}`), { code: 'ETIMEDOUT' })
  } })
  for (const command of ['zlib.search Alice', `zlib.detail ${detail}`]) {
    const reply = (await client.receive(command)).join('')
    assert.match(reply, /Alice in Wonderland/)
    assert.doesNotMatch(reply, /<img|\[封面\]|covers.example.invalid|请求失败|test-session-key|private-browser-cookie/)
  }
  assert.match(logs.join('\n'), /zlib.cover: upload failed \(book 12345\)/)
  assert.match(logs.join('\n'), /code: ETIMEDOUT/)
  assert.doesNotMatch(logs.join('\n'), /test-session-key|private-browser-cookie/)
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/file')).length, 0)
})

test('a slow cover transfer cannot send obsolete results after a newer search', { timeout: 5000 }, async (t) => {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const transferring = new Promise<void>(resolve => { started = resolve })
  t.after(() => release())
  let transfers = 0
  const { ctx, client } = await fixture(t, {
    search: query => [{ ...book, title: query }],
    cover: async () => {
      if (++transfers === 1) { started(); await gate }
      return { url: 'https://assets.invalid/fixture-cover' }
    },
  })
  const old = ctx.mock.client('tester').receive('zlib.search old')
  await transferring
  assert.match((await client.receive('zlib.search new')).join(''), /\[标题\] new/)
  release()
  assert.deepEqual(await old, [])
  assert.match((await client.receive('1')).join(''), /成功转存书籍/)
})

test('numbers search results and immediately downloads the selected book without confirmation', async (t) => {
  const { client, calls, uploads, reactions } = await fixture(t)
  const results = await client.receive('zlib.search Alice -p 2')
  assert.match(results[0], /120 秒内输入本页序号 1～1/)
  assert.match(results[1], /\[序号\] 1[\s\S]*Alice in Wonderland/)
  assert.equal(calls.length, 1)
  await client.shouldNotReply('y')
  const replies = (await client.receive('1')).join('')
  assert.match(replies, /成功转存书籍[\s\S]*<file/)
  assert.doesNotMatch(replies, /确认|正在请求|下载中|正在上传/)
  assert.equal(uploads.length, 1)
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/file')).length, 1)
  assert.deepEqual(reactions.map(x => [x.action, x.emoji]), [
    ['add', '🔍'], ['remove', '🔍'], ['add', '⏳'], ['remove', '⏳'], ['add', '📤'], ['remove', '📤'],
  ])
  assert.equal(reactions[0].messageId, reactions[1].messageId)
  assert.ok(reactions.slice(2).every(x => x.messageId === reactions[2].messageId))
  assert.notEqual(reactions[0].messageId, reactions[2].messageId)
  await client.shouldNotReply('y')
  await client.shouldNotReply('1')
})

test('interactive downloads reuse stored files without consuming another download', async (t) => {
  const { client, calls, uploads } = await fixture(t)
  await client.receive(`zlib.store.fetch ${detail}`)
  await client.receive('zlib.search Alice')
  const replies = (await client.receive('1')).join('')
  assert.match(replies, /已转存过此书籍[\s\S]*<file[^>]+fixture-asset/)
  assert.equal(uploads.length, 1)
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/file')).length, 1)
})

test('validates selections, passes unrelated messages through, and supports cancellation', async (t) => {
  const { ctx, client, calls } = await fixture(t, { search: () => [book, { ...book, title: 'Another edition' }] })
  await client.receive('zlib.search Alice')
  await client.shouldReply('3', '请输入 1～2 之间的序号。')
  await client.shouldNotReply('ordinary chat')
  await client.shouldNotReply('1<img src="https://example.invalid/image.png"/>')
  await client.shouldNotReply('<at id="another-user"/>1')
  await client.shouldReply('zlib.state', /已登录/)
  assert.match((await client.receive(`<at id="${ctx.bots[0].selfId}"/> 2`)).join(''), /成功转存书籍/)
  await client.receive('zlib.search Alice')
  await client.shouldReply('n', '已取消选书。')
  await client.shouldNotReply('yes')
  await client.shouldNotReply('1')
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/file')).length, 1)
})

test('isolates number selection by user, conversation and receiving bot', async (t) => {
  const { ctx, client, calls } = await fixture(t)
  await ctx.mock.initUser('another-user', 4)
  await ctx.mock.initChannel('group1')
  await ctx.mock.initChannel('group2')
  const group = ctx.mock.client('tester', 'group1')
  const others = [client, ctx.mock.client('tester', 'group2'), ctx.mock.client('another-user', 'group1')]
  const anotherBot = ctx.mock.client('tester', 'group1')
  anotherBot.event.selfId = 'another-bot'
  others.push(anotherBot)
  await group.receive('zlib.search Alice')
  for (const other of others) await other.shouldNotReply('1')
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/file')).length, 0)
  assert.match((await group.receive('1')).join(''), /成功转存书籍[\s\S]*<file/)
})

test('expires number selections without consuming later messages', async (t) => {
  const { client, calls } = await fixture(t, { config: { selectionTimeout: 1000 } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await client.receive('zlib.search Alice')
  t.mock.timers.tick(600)
  await client.shouldReply('2', '请输入 1～1 之间的序号。')
  t.mock.timers.tick(400)
  await client.shouldNotReply('y')
  await client.shouldNotReply('1')
  assert.equal(calls.length, 1)
})

test('new searches replace pending selections, including empty results', async (t) => {
  const { client, calls } = await fixture(t, { search: query => query === 'missing' ? [] : [{ ...book, title: query }] })
  await client.receive('zlib.search old')
  await client.receive('zlib.search new')
  await client.shouldNotReply('y')
  assert.match((await client.receive('1')).join(''), /成功转存书籍/)
  await client.receive('zlib.search missing')
  await client.shouldNotReply('1')
  await client.shouldNotReply('y')
  assert.equal(calls.filter(call => call.url.pathname === '/eapi/book/search').length, 3)
})

test('an older slow search cannot replace the current selection', { timeout: 5000 }, async (t) => {
  let release!: (books: typeof book[]) => void
  let started!: () => void
  const gate = new Promise<typeof book[]>(resolve => { release = resolve })
  const searching = new Promise<void>(resolve => { started = resolve })
  t.after(() => release([]))
  const { ctx, client } = await fixture(t, { search: query => {
    if (query === 'old') { started(); return gate }
    return [{ ...book, title: 'new' }]
  } })
  const old = ctx.mock.client('tester').receive('zlib.search old')
  await searching
  await client.receive('zlib.search new')
  release([{ ...book, title: 'old' }])
  assert.deepEqual(await old, [])
  assert.match((await client.receive('1')).join(''), /成功转存书籍/)
})

test('failed sends and plugin disposal leave no active selection', async (t) => {
  const { ctx, client, fork, logs } = await fixture(t)
  const stopFailing = ctx.on('before-send', session => {
    if (session.content?.includes('输入本页序号')) throw Object.assign(new Error('fixture send failed'), { code: 1200 })
  })
  await client.shouldReply('zlib.search Alice', /请求失败/)
  assert.match(logs.join('\n'), /zlib.search: send results \(mock\)/)
  assert.match(logs.join('\n'), /Error: fixture send failed\n\s+at /)
  assert.match(logs.join('\n'), /code: 1200/)
  await client.shouldNotReply('1')
  stopFailing()
  await client.receive('zlib.search Alice')
  fork.dispose()
  await client.shouldNotReply('1')
})

test('number selection preserves the fetch command authority check', async (t) => {
  const { ctx, calls } = await fixture(t)
  ctx.command('zlib.store.fetch', { permissions: ['authority:4'] })
  await ctx.mock.initUser('reader', 1)
  const reader = ctx.mock.client('reader')
  await reader.receive('zlib.search Alice')
  await reader.receive('1')
  assert.equal(calls.length, 1)
})

test('rapid duplicate selections start only one transfer', { timeout: 5000 }, async (t) => {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const downloading = new Promise<void>(resolve => { started = resolve })
  t.after(() => release())
  const { ctx, client, calls, uploads } = await fixture(t, { file: async () => {
    started()
    await gate
    return new Response(payload)
  } })
  await client.receive('zlib.search Alice')
  const selection = client.receive('1')
  await downloading
  await ctx.mock.client('tester').shouldNotReply('1')
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/file')).length, 1)
  release()
  assert.match((await selection).join(''), /成功转存书籍/)
  assert.equal(uploads.length, 1)
})

test('returns explicit responses for missing keywords and empty search pages', async (t) => {
  const { client, calls } = await fixture(t, { mode: 'empty' })
  await client.shouldReply('zlib.search', /请输入搜索关键词/)
  assert.equal(calls.length, 0)
  await client.shouldReply('zlib.search missing-book -p 3', /未找到[\s\S]*第 3 页/)
})

test('reports HTML challenges and expired sessions without pretending there were zero results', async (t) => {
  for (const mode of ['html', 'unauthorized'] as const) await t.test(mode, async (t) => {
    const { client, uploads, logs } = await fixture(t, { mode })
    const replies = await client.receive('zlib.search Alice')
    assert.match(replies.join(''), /请求失败|登录已失效/)
    assert.doesNotMatch(replies.join(''), /未找到|private-browser-cookie|test-session-key|private-ticket/)
    assert.equal(uploads.length, 0)
    assert.match(logs.join('\n'), /zlib.search: request books/)
    assert.match(logs.join('\n'), /Caused by:/)
    if (mode === 'unauthorized') assert.match(logs.join('\n'), /HTTP 401/)
  })
})

test('can start without a session and retains stored-file commands', async (t) => {
  const { client, calls } = await fixture(t, { config: { cookie: '' } })
  await client.shouldReply('zlib.state', '未登录')
  await client.shouldReply('zlib.search Alice', /请在插件配置中填写/)
  await client.shouldReply('zlib.store.list', /暂无转存的书籍/)
  assert.equal(calls.length, 0)
})

test('downloads bytes, uploads to assets, stores metadata, sends files and avoids duplicate downloads', async (t) => {
  const { ctx, client, calls, uploads } = await fixture(t)
  const replies = await client.receive(`zlib.store.fetch ${detail} -s`)
  assert.match(replies.join(''), /成功转存书籍[\s\S]*<file/)
  assert.doesNotMatch(replies.join(''), /private-ticket|test-session-key|files.example/)
  assert.equal(uploads.length, 1)
  assert.deepEqual(Buffer.from(await uploads[0].blob.arrayBuffer()), payload)
  assert.equal(uploads[0].info.categoryId, 'zlibrary')
  assert.equal(uploads[0].info.sourceUrl, `${origin}${opaque}`)
  const [row] = await ctx.database.get('w-zlibrary-stored-book', {})
  assert.equal(row.sourceId, '12345')
  assert.equal(row.downloadUrl, '')
  assert.equal((await ctx.database.get('w-zlibrary-stats', 1))[0].bookCount, 1)
  assert.match((await client.receive(`zlib.store.fetch ${opaque}`)).join(''), /已转存过此书籍/)
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/file')).length, 1)
  assert.equal(uploads.length, 1)
  assert.match((await client.receive('zlib.store.list')).join(''), /Alice in Wonderland/)
  assert.match((await client.receive('zlib.store.send 1')).join(''), /<file[^>]+Alice in Wonderland.pdf/)
})

test('recognizes pre-eAPI stored records even under an old domain and with no new source fields', async (t) => {
  const { ctx, client, calls, uploads } = await fixture(t)
  await ctx.database.create('w-zlibrary-stored-book', {
    title: 'Old stored book', authors: ['Author'], url: 'https://old-domain.invalid/book/12345/abc123/old-title.html',
    extension: 'pdf', assetId: 'old-asset', assetUrl: 'https://assets.invalid/old-asset', fileName: 'legacy.pdf',
  })
  assert.match((await client.receive(`zlib.store.fetch ${detail}`)).join(''), /已转存过此书籍/)
  assert.equal(calls.length, 1)
  assert.equal(uploads.length, 0)
  assert.match((await client.receive('zlib.store.send 1')).join(''), /old-asset/)
})

test('switches from download to upload reaction before transferring the file to assets', { timeout: 5000 }, async (t) => {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const uploading = new Promise<void>(resolve => { started = resolve })
  t.after(() => release())
  const { client, reactions } = await fixture(t, { upload: async () => { started(); await gate } })
  const result = client.receive(`zlib.store.fetch ${detail}`)
  await uploading
  assert.deepEqual(reactions.map(x => [x.action, x.emoji]), [['add', '⏳'], ['remove', '⏳'], ['add', '📤']])
  release()
  assert.match((await result).join(''), /成功转存/)
  assert.deepEqual(reactions.map(x => [x.action, x.emoji]), [
    ['add', '⏳'], ['remove', '⏳'], ['add', '📤'], ['remove', '📤'],
  ])
})

test('cleans up the upload reaction when assets rejects the upload', async (t) => {
  const { ctx, client, reactions, logs } = await fixture(t, { upload: async () => { throw new Error('upload failed') } })
  assert.match((await client.receive(`zlib.store.fetch ${detail}`)).join(''), /请求失败/)
  assert.deepEqual(reactions.map(x => [x.action, x.emoji]), [
    ['add', '⏳'], ['remove', '⏳'], ['add', '📤'], ['remove', '📤'],
  ])
  assert.equal((await ctx.database.get('w-zlibrary-stored-book', {})).length, 0)
  assert.match(logs.join('\n'), /zlib.store.fetch: upload asset failed/)
})

test('does not request file links with exhausted quota, missing links or denied downloads', async (t) => {
  for (const mode of ['quota', 'no-link', 'disallowed'] as const) await t.test(mode, async (t) => {
    const { client, calls, uploads } = await fixture(t, { mode })
    const replies = await client.receive(`zlib.store.fetch ${detail}`)
    assert.match(replies.join(''), /额度已用完|无法获取下载链接/)
    assert.equal(uploads.length, 0)
    assert.ok(calls.every(call => call.url.hostname === 'zlibrary.invalid'))
    if (mode === 'quota') assert.equal(calls.filter(call => call.url.pathname.endsWith('/file')).length, 0)
  })
})

test('never stores HTML error pages, even when disguised as binary files', async (t) => {
  for (const mode of ['bad-file', 'headerless-html'] as const) await t.test(mode, async (t) => {
    const { ctx, client, uploads } = await fixture(t, { mode })
    const replies = await client.receive(`zlib.store.fetch ${detail}`)
    assert.match(replies.join(''), /下载失败/)
    assert.equal(uploads.length, 0)
    assert.equal((await ctx.database.get('w-zlibrary-stored-book', {})).length, 0)
    assert.equal((await ctx.database.get('w-zlibrary-stats', 1))[0].bookCount, 0)
  })
})

test('bounds file downloads and leaves storage and statistics unchanged on failure', async (t) => {
  const { ctx, client, uploads, calls } = await fixture(t, { config: { maxFileSize: 8 } })
  assert.match((await client.receive(`zlib.store.fetch ${detail}`)).join(''), /大小限制/)
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/file')).length, 0)
  assert.equal(uploads.length, 0)
  assert.equal((await ctx.database.get('w-zlibrary-stored-book', {})).length, 0)
})

test('coalesces concurrent stores of a book before requesting a second quota-consuming link', { timeout: 5000 }, async (t) => {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const downloading = new Promise<void>(resolve => { started = resolve })
  const { ctx, client, uploads, calls } = await fixture(t, { file: async () => {
    started()
    await gate
    return new Response(payload)
  } })
  await ctx.mock.initUser('second-tester', 4)
  const secondClient = ctx.mock.client('second-tester')
  const first = client.receive(`zlib.store.fetch ${detail}`)
  await downloading
  try {
    const second = await secondClient.receive(`zlib.store.fetch ${opaque}`)
    assert.match(second.join(''), /正在转存，请稍后/)
    assert.equal(calls.filter(call => call.url.pathname.endsWith('/file')).length, 1)
  } finally { release() }
  await first
  assert.equal(uploads.length, 1)
})

test('cancels slow downloads on user refusal and does not consume the next command', { timeout: 5000 }, async (t) => {
  const { client, uploads, sent, react, promptReady } = await fixture(t, { config: { downloadTimeout: 5 }, file: async init => {
    await new Promise((resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
    return new Response(payload)
  } })
  const download = client.receive(`zlib.store.fetch ${detail}`)
  await promptReady
  react(sent.find(x => x.content.includes('是否继续等待'))!.id, '❌')
  assert.match((await download).join(''), /已放弃下载/)
  assert.equal(uploads.length, 0)
  await client.shouldReply('zlib.state', /已登录/)
})

test('cleans up a pending wait prompt when the download finishes on its own', { timeout: 5000 }, async (t) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const { client, uploads, sent, react, promptReady, reactions } = await fixture(t, { config: { downloadTimeout: 5 }, file: async () => {
    await gate
    return new Response(payload)
  } })
  const download = client.receive(`zlib.store.fetch ${detail}`)
  await promptReady
  release()
  assert.match((await download).join(''), /成功转存/)
  await client.shouldReply('zlib.state', /已登录/)
  assert.equal(uploads.length, 1)
  react(sent.find(x => x.content.includes('是否继续等待'))!.id, '❌')
  assert.equal(reactions.filter(x => x.action === 'remove' && x.emoji === '⏳').length, 1)
})

test('only accepts the requester reaction on the matching bot/channel/message and prompts once', { timeout: 5000 }, async (t) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  let signal!: AbortSignal
  const { client, sent, react, promptReady, uploads, ctx } = await fixture(t, {
    config: { downloadTimeout: 5 }, file: async init => {
      signal = init.signal!
      await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])
      return new Response(payload)
    },
  })
  const download = client.receive(`zlib.store.fetch ${detail}`)
  await promptReady
  const prompt = sent.find(x => x.content.includes('是否继续等待'))!
  react(prompt.id, '❌', { userId: 'another-user' })
  react(prompt.id, '❌', { userId: ctx.bots[0].selfId })
  react(prompt.id, '❌', { channelId: 'another-channel' })
  react(prompt.id, '❌', { selfId: 'another-bot' })
  react('another-message', '❌')
  react(prompt.id, '👍')
  assert.equal(signal.aborted, false)
  react(prompt.id, '✅')
  react(prompt.id, '❌')
  await delay(120)
  assert.equal(signal.aborted, false)
  assert.equal(sent.filter(x => x.content.includes('是否继续等待')).length, 1)
  release()
  assert.match((await download).join(''), /成功转存/)
  assert.equal(uploads.length, 1)
})

test('cancels an unanswered wait prompt and ignores later reactions', { timeout: 5000 }, async (t) => {
  const { client, sent, react, promptReady, uploads, calls } = await fixture(t, {
    config: { downloadTimeout: 5 }, promptTimeout: 20, file: async init => {
      await new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
      return new Response(payload)
    },
  })
  const download = client.receive(`zlib.store.fetch ${detail}`)
  await promptReady
  assert.match((await download).join(''), /已放弃下载/)
  react(sent.find(x => x.content.includes('是否继续等待'))!.id, '✅')
  assert.equal(uploads.length, 0)
  assert.equal(calls.filter(x => x.url.pathname.endsWith('/file')).length, 1)
})

test('uses sender-scoped text fallback only when reactions fail', { timeout: 5000 }, async (t) => {
  let asked!: () => void
  const promptSent = new Promise<void>(resolve => { asked = resolve })
  const { ctx, client, uploads, logs } = await fixture(t, {
    config: { downloadTimeout: 5 },
    reaction: async emoji => { if (emoji !== '⏳') throw new Error('reaction unavailable') },
    file: async init => {
      await new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
      return new Response(payload)
    },
  })
  ctx.on('before-send', session => { if (session.content?.includes('是否继续等待')) asked() })
  const download = client.receive(`zlib.store.fetch ${detail}`)
  await promptSent
  await delay(5)
  await ctx.mock.client('another-user').shouldNotReply('n')
  await ctx.mock.client('tester').shouldNotReply('ordinary chat')
  await ctx.mock.client('tester').receive('n')
  assert.match((await download).join(''), /已放弃下载/)
  assert.equal(uploads.length, 0)
  assert.match(logs.join('\n'), /reaction unavailable/)
  await client.shouldReply('zlib.state', /已登录/)
})

test('disposal aborts downloads and drops reaction waiters', { timeout: 5000 }, async (t) => {
  const { client, sent, react, promptReady, fork, uploads } = await fixture(t, {
    config: { downloadTimeout: 5 }, file: async init => {
      await new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
      return new Response(payload)
    },
  })
  const download = client.receive(`zlib.store.fetch ${detail}`)
  await promptReady
  fork.dispose()
  assert.match((await download).join(''), /已放弃下载/)
  react(sent.find(x => x.content.includes('是否继续等待'))!.id, '✅')
  assert.equal(uploads.length, 0)
})

test('accepts canonical and raw NapCat Unicode reactions', { timeout: 5000 }, async (t) => {
  for (const emoji of ['emoji|10060', '10060']) await t.test(emoji, async (t) => {
    const { client, sent, react, promptReady, reactions } = await fixture(t, {
      config: { downloadTimeout: 5 }, file: async init => {
        await new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
        return new Response(payload)
      },
    })
    client.event.platform = 'onebot'
    const download = client.receive(`zlib.store.fetch ${detail}`)
    await promptReady
    const prompt = sent.find(x => x.content.includes('是否继续等待'))!
    assert.ok(reactions.some(x => x.emoji === 'emoji|9989' && x.messageId === prompt.id))
    assert.ok(reactions.some(x => x.emoji === 'emoji|9203'))
    react(prompt.id, emoji, { platform: 'onebot' })
    assert.match((await download).join(''), /已放弃下载/)
  })
})

test('reads Unicode reactions from the current Discord adapter content field', { timeout: 5000 }, async (t) => {
  const { client, sent, react, promptReady } = await fixture(t, {
    config: { downloadTimeout: 5 }, file: async init => {
      await new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
      return new Response(payload)
    },
  })
  client.event.platform = 'discord'
  const download = client.receive(`zlib.store.fetch ${detail}`)
  await promptReady
  react(sent.find(x => x.content.includes('是否继续等待'))!.id, '', { platform: 'discord', content: '❌' })
  assert.match((await download).join(''), /已放弃下载/)
})

test('deletes stored books and updates the existing statistics table after confirmation', async (t) => {
  const { ctx, client, deleted } = await fixture(t)
  await client.receive(`zlib.store.fetch ${detail}`)
  const deleting = client.receive('zlib.store.delete 1', 1)
  assert.match((await deleting).join(''), /确定要删除/)
  const replies = await client.receive('y')
  assert.match(replies.join(''), /已删除转存书籍/)
  assert.deepEqual(deleted, ['fixture-asset'])
  assert.equal((await ctx.database.get('w-zlibrary-stats', 1))[0].bookCount, 0)
})

test('rejects mismatched book identities instead of using unrelated metadata', async (t) => {
  const { ctx } = await fixture(t)
  const client = new ZLibraryClient(ctx.http, 'zlibrary.invalid', cookie)
  await assert.rejects(client.detail('/book/99999/abc123'), /与请求不符/)
})

test('follows public file redirects without forwarding account headers', async (t) => {
  const { ctx, calls } = await fixture(t)
  const blob = await downloadFile(ctx.http, 'https://files.example.invalid/redirect', 'pdf', 1024, new AbortController().signal)
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), payload)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.init.redirect === 'manual'))
})

test('rejects unsafe initial URLs and rechecks private redirect targets before connecting', async (t) => {
  const { ctx, calls } = await fixture(t, { file: async () => new Response(null, {
    status: 302, headers: { location: 'https://127.0.0.1/private' },
  }) })
  const signal = new AbortController().signal
  for (const url of ['file:///etc/passwd', 'http://files.example.invalid/book', 'https://user:secret@files.example.invalid/book', 'https://127.0.0.1/book']) {
    await assert.rejects(downloadFile(ctx.http, url, 'pdf', 1024, signal), /不安全/)
  }
  assert.equal(calls.length, 0)
  await assert.rejects(downloadFile(ctx.http, fileUrl, 'pdf', 1024, signal), /不安全/)
  assert.equal(calls.length, 1)
})

test('bounds streamed bytes even without Content-Length and cancels the body', async (t) => {
  let cancelled = false
  const { ctx } = await fixture(t, { file: async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(16)) },
    cancel() { cancelled = true },
  })) })
  await assert.rejects(downloadFile(ctx.http, fileUrl, 'pdf', 8, new AbortController().signal), /大小限制/)
  assert.equal(cancelled, true)
})

test('keeps HTTP exception details, account cookies and signed URLs out of user replies', async (t) => {
  const { client, uploads, logs } = await fixture(t, { file: async () => {
    throw Object.assign(new Error(`connect ${fileUrl}; cookie=${cookie}`), { code: 'ECONNRESET' })
  } })
  const replies = (await client.receive(`zlib.store.fetch ${detail}`)).join('')
  assert.match(replies, /请求失败/)
  assert.doesNotMatch(replies, /private-ticket|test-session-key|private-browser-cookie|files.example/)
  assert.equal(uploads.length, 0)
  const output = logs.join('\n')
  assert.match(output, /zlib.store.fetch: download file/)
  assert.match(output, /code: ECONNRESET/)
  assert.match(output, /Caused by: Error: connect/)
  assert.doesNotMatch(output, /private-ticket|test-session-key|private-browser-cookie|alice\.pdf/)
})
