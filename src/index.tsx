import { $, capitalize, Context, h, HTTP, SessionError, z, type Fragment, type Session } from 'koishi'
import {} from 'koishi-plugin-w-assets-core'
import {} from 'koishi-plugin-w-as-forward'

import { bookPath, ZLibraryClient, ZLibraryError, type Book, type LoginState } from './client'
import { downloadFile } from './download'
import { createErrorFormatter } from './error'
import { createInteractions } from './interaction'

export const name = 'w-zlibrary'

export const inject = ['http', 'assetsPro', 'database']

export interface Config {
  cookie: string
  domain: string
  pageSize: number
  reactionInteraction: boolean
  selectionTimeout: number
  downloadTimeout: number
  maxFileSize: number
}

export const Config: z<Config> = z.object({
  cookie: z.string().role('secret').default('').description('账号 Cookie，需包含 remix_userid 和 remix_userkey'),
  domain: z.string().default('z-lib.by').description('提供 eAPI 的 Z-Library 域名'),
  pageSize: z.natural().min(1).max(100).default(30).description('搜索及转存列表每页显示的条目数'),
  reactionInteraction: z.boolean().default(true).description('使用 reaction 提示进度和确认是否继续下载；关闭时使用文字交互'),
  selectionTimeout: z.natural().min(1000).role('ms').default(120_000).description('搜索结果序号选书的有效期'),
  downloadTimeout: z.natural().min(1).default(60_000).description('下载多久后询问是否继续等待（毫秒）'),
  maxFileSize: z.natural().min(1).default(100 * 1024 * 1024).description('单本书籍下载大小上限（字节）')
})

interface StoredBook extends Book {
  bookId: number

  assetId: string
  assetUrl: string

  fileName: string
  storerUid: string
}

interface Stats {
  id: 1
  bookCount: number
}

declare module 'koishi' {
  interface Tables {
    'w-zlibrary-stored-book': StoredBook
    'w-zlibrary-stats': Stats
  }
}

const showLoginState = (stat: LoginState | null) => {
  if (! stat) return '未登录'
  const { username, limit } = stat
  return `已登录：${username}，今日已用 ${limit.used}/${limit.total} 次下载`
}

const ellipsis = (text: string, length: number) =>
  text.length <= length ? text : text.slice(0, length - 1) + '…'

const isYesResponse = (response: { content?: string }) => {
  const text = response.content?.toLowerCase()
  return text === 'y' || text === 'yes'
}

export async function apply(ctx: Context, config: Config) {
  const client = new ZLibraryClient(ctx.http, config.domain, config.cookie)
  const pending = new Set<string>()
  const downloads = new Set<AbortController>()
  interface Selection {
    books?: Book[]
    cancelTimeout?: () => void
  }
  const selections = new Map<string, Selection>()
  let disposed = false
  // fid does not include the receiving bot, so include sid as well.
  const selectionKey = (session: Session) => JSON.stringify([session.sid, session.guildId, session.channelId, session.userId])
  const current = (key: string, entry: Selection) => !disposed && selections.get(key) === entry
  const clearSelection = (key: string, entry: Selection) => {
    if (selections.get(key) !== entry) return
    selections.delete(key)
    entry.cancelTimeout?.()
  }
  const renewSelection = (key: string, entry: Selection) => {
    if (!current(key, entry)) return
    entry.cancelTimeout?.()
    entry.cancelTimeout = ctx.setTimeout(() => clearSelection(key, entry), config.selectionTimeout)
  }
  ctx.on('dispose', () => {
    disposed = true
    for (const [key, entry] of selections) clearSelection(key, entry)
    downloads.forEach(controller => controller.abort())
  })
  // Unlike session.send(), this propagates adapter failures. Only enable an
  // interaction after its list or confirmation has actually been sent.
  const send = (session: Session, content: Fragment) => session.bot.sendMessage(
    session.channelId!, h.normalize(content), session.event.referrer, { session },
  )
  const formatError = createErrorFormatter(config.cookie)
  const interactions = createInteractions(ctx, send, formatError, config.reactionInteraction)
  const reportError = (error: unknown, stage: string) => {
    ctx.logger.warn('%s failed (%s):\n%s', stage, client.origin, formatError(error))
    if (error instanceof ZLibraryError) return error.message
    return '请求失败，请检查网络、域名及登录状态。'
  }
  const getUrl = (value: string, short: boolean) => {
    const url = new URL(value, client.origin)
    return short ? url.pathname : url.href
  }

  const renderRating = (rating: number) => '★'.repeat(Math.max(0, Math.min(5, Math.round(rating) || 0))) || '☆'

  const renderBook = (options: { shortUrl: boolean, header?: any }) => async (book: Book | StoredBook) => {
    let coverUrl: string | undefined
    if (book.coverUrl) {
      try {
        const asset = await ctx.assetsPro.uploadFromUrl(book.coverUrl, { categoryId: 'zlibrary-cover' })
        coverUrl = asset.url
      } catch (error) {
        // A cover is optional. Never send the original URL as a fallback,
        // otherwise an adapter download failure can reject the whole forward.
        ctx.logger.warn('zlib.cover: upload failed (book %s):\n%s', book.sourceId, formatError(error))
      }
    }
    return <>
      { options.header ?? <></> }
      { 'bookId' in book ? <>
        <br />[#{book.bookId}]
      </> : '' }
      <br />[标题] {book.title}
      { coverUrl ? <>
        <br />[封面] <img src={coverUrl} />
      </> : '' }
      <br />[作者] { (book.authors.length > 2 ? book.authors.slice(0, 2).concat('...') : book.authors).join('; ') }
      <br />[年份] { book.year || 'N/A' } [语言] { capitalize(book.language) }
      <br />[评分] { renderRating(book.rating) } [质量] { renderRating(book.quality) }
      <br />[详情] { getUrl(book.url, options.shortUrl) }
      { book.extension || book.fileSize ? <>
        <br />[大小] {book.fileSize} [类型] {book.extension}
      </> : '' }
      { 'assetUrl' in book ? <>
        <br />[转存] <a href={book.assetUrl}>#{book.assetId}</a>
      </> : '' }
    </>
  }

  const initDb = async () => {
    const [stats] = await ctx.database.get('w-zlibrary-stats', 1)
    if (! stats) {
      await ctx.database.create('w-zlibrary-stats', {
        id: 1,
        bookCount: 0,
      })
    }
  }

  ctx.model.extend('w-zlibrary-stored-book', {
    bookId: 'unsigned',

    sourceId: 'string',
    sourceHash: 'string',

    assetId: 'string',
    assetUrl: 'string',

    title: 'string',
    authors: { type: 'array', inner: 'string' },
    coverUrl: 'string',
    url: 'string',
    downloadUrl: 'string',
    year: 'unsigned',
    language: 'string',
    fileSize: 'string',
    fileBytes: 'unsigned',
    extension: 'string',
    rating: 'unsigned',
    quality: 'unsigned',
    fileName: 'string',
    storerUid: 'string',
  }, {
    primary: 'bookId',
    autoInc: true
  })

  ctx.model.extend('w-zlibrary-stats', {
    id: 'unsigned',
    bookCount: 'unsigned',
  }, {
    primary: 'id',
  })

  ctx.i18n.define('en-US', {
    id: '{0}'
  })

  await initDb()

  ctx.middleware(async (session, next) => {
    const key = selectionKey(session)
    const entry = selections.get(key)
    if (!entry?.books) return next()
    const elements = (session.elements ?? []).slice()
    if (elements[0]?.type === 'at' && elements[0].attrs.id === session.selfId) elements.shift()
    if (elements.some(element => element.type !== 'text')) return next()
    const input = elements.map(element => element.attrs.content).join('').trim()
    if (/^(取消|n|no)$/i.test(input)) {
      clearSelection(key, entry)
      await session.send('已取消选书。')
      return
    }
    if (!/^\d+$/.test(input)) return next()
    const index = Number(input)
    if (!Number.isSafeInteger(index) || index < 1 || index > entry.books.length) {
      await session.send(`请输入 1～${entry.books.length} 之间的序号。`)
      return
    }
    const book = entry.books[index - 1]
    // Consume before awaiting I/O. Execute the command to retain its authority
    // checks and prevent rapid duplicate numbers from starting two downloads.
    clearSelection(key, entry)
    await session.execute({ name: 'zlib.store.fetch', args: [book.url], options: { send: true } })
  }, true)

  ctx.command('zlib', 'zlibrary 功能')

  ctx.command('zlib.state', '查看 zlibrary 登录状态')
    .action(async () => {
      try { return showLoginState(await client.profile()) }
      catch (error) { return reportError(error, 'zlib.state: request profile') }
    })

  ctx.command('zlib.search [...filter:string]', '在 zlibrary 中搜索书籍')
    .option('shortUrl', '-s 显示短链接')
    .option('page', '-p <page:posint> 指定页码')
    .action(async ({ session, options }, ...words) => {
      const filter = words.join(' ').trim()
      if (!filter) return <>请输入搜索关键词</>
      const { page, shortUrl = false } = options
      const startTime = Date.now()
      const key = selectionKey(session)
      const previous = selections.get(key)
      if (previous) clearSelection(key, previous)
      const entry: Selection = {}
      selections.set(key, entry)
      let clearStatus: (() => Promise<void>) | undefined
      let stage = 'zlib.search: request books'
      try {
        clearStatus = await interactions.search(session)
        if (!current(key, entry)) return
        const { books, pages } = await client.search(filter, page ?? 1, config.pageSize)
        if (!current(key, entry)) return
        if (!books.length) return <>未找到符合“{filter}”的书籍（第 {page ?? 1} 页）</>
        stage = 'zlib.search: prepare results'
        const messages = await Promise.all(books.map(async (book, index) => <message>
          {await renderBook({ shortUrl, header: <>[序号] {index + 1}</> })(book)}
        </message>))
        if (!current(key, entry)) return
        stage = `zlib.search: send results (${session.platform})`
        const duration = ((Date.now() - startTime) / 1000).toFixed(2)
        const header = `在 ${config.domain} 找到 ${books.length} 条符合“${filter}”的结果（第 ${page ?? 1}/${pages ?? '?'} 页），用时 ${duration} 秒`
        await send(session, <as-forward level='always'>
          <message>{header}<br />请查询者在 {config.selectionTimeout / 1000} 秒内输入本页序号 1～{books.length} 直接转存并发送文件（可能消耗 1 次下载额度）；回复“取消”退出。</message>
          {messages}
        </as-forward>)
        if (!current(key, entry)) return
        entry.books = books
        renewSelection(key, entry)
      }
      catch (error) {
        if (current(key, entry)) return reportError(error, stage)
      }
      finally {
        if (!entry.books) clearSelection(key, entry)
        await clearStatus?.()
      }
    })

  ctx.command('zlib.detail <url:string>', '查看 zlibrary 书籍详情')
    .action(async ({ session }, url) => {
      try {
        bookPath(url, client.origin)
        const startTime = Date.now()
        await session.send(<>正在请求书籍详情……</>)
        const book = await client.detail(url)
        const content = await renderBook({ shortUrl: false })(book)
        const duration = ((Date.now() - startTime) / 1000).toFixed(2)
        return <as-forward level='always'>
          已获取书籍详情，用时 {duration} 秒<br />
          {content}
        </as-forward>
      }
      catch (error) { return reportError(error, 'zlib.detail: request/render book') }
    })

  ctx.command('zlib.store', 'zlibrary 书籍转存功能')

  ctx.command('zlib.store.fetch <url:string>', '转存 zlibrary 书籍到 Koishi')
    .option('send', '-s 转存完成后立即发送书籍文件')
    .action(async ({ session, options }, url) => {
      const key = selectionKey(session)
      const selection = selections.get(key)
      if (selection) clearSelection(key, selection)
      let identity: string | undefined
      let abortController: AbortController | undefined
      let clearStatus: (() => Promise<void>) | undefined
      let stage = 'zlib.store.fetch: request book'
      try {
        bookPath(url, client.origin)
        clearStatus = await interactions.download(session)
        const book = await client.detail(url)
        if (disposed) return
        const { extension } = book
        if (!/^[a-z0-9]{1,12}$/.test(extension)) throw new ZLibraryError('书籍缺少有效的文件类型，无法转存。')
        if (book.fileBytes > config.maxFileSize) throw new ZLibraryError('书籍超过 maxFileSize 配置的大小限制。')
        const fileName = `${book.sourceId}_${book.sourceHash}.${extension}`
        if (pending.has(book.sourceId)) return <>此书籍正在转存，请稍后查看转存列表。</>
        pending.add(book.sourceId)
        identity = book.sourceId
        stage = 'zlib.store.fetch: find stored book'

        // Older rows have no sourceId. Match their numeric or opaque website
        // links too, including links saved under a different site domain.
        const pathname = new URL(book.url).pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const [storedBook] = await ctx.database.get('w-zlibrary-stored-book', {
          $or: [
            { sourceId: book.sourceId },
            { url: { $regex: new RegExp(`^https?://[^/]+/book/${book.sourceId}/`) } },
            { url: { $regex: new RegExp(`^https?://[^/]+${pathname}$`) } },
          ]
        })
        if (storedBook) {
          stage = 'zlib.store.fetch: send stored book'
          await session.send(<>已转存过此书籍：<a href={storedBook.assetUrl}>#{storedBook.bookId}</a>{options.send ? '，正在发送文件……' : ''}</>)
          if (options.send) await session.send(<file url={storedBook.assetUrl} title={storedBook.fileName} />)
          return
        }

        stage = 'zlib.store.fetch: request profile'
        const state = await client.profile()
        if (!state || state.limit.used >= state.limit.total) throw new ZLibraryError('今日下载额度已用完。')
        // Requesting /file may consume quota. Never do it for searches,
        // detail views, duplicate stores, or simultaneous requests for a book.
        stage = 'zlib.store.fetch: request download link'
        const downloadUrl = await client.downloadLink(book)
        if (disposed) return
        abortController = new AbortController()
        downloads.add(abortController)
        const controller = abortController
        const cleanupPrompt = interactions.wait(session, controller, config.downloadTimeout)

        let downloadBlob: Blob

        try {
          stage = 'zlib.store.fetch: download file'
          downloadBlob = await downloadFile(ctx.http, downloadUrl, extension, config.maxFileSize, controller.signal)
          controller.signal.throwIfAborted()
        }
        finally {
          cleanupPrompt()
          downloads.delete(controller)
        }

        stage = 'zlib.store.fetch: upload asset'
        await clearStatus()
        clearStatus = undefined
        if (disposed) return
        clearStatus = await interactions.upload(session)
        if (disposed) return
        const asset = await ctx.assetsPro.uploadFromFile(downloadBlob, {
          name: fileName,
          sourceUrl: book.url,
          categoryId: 'zlibrary',
        })

        stage = 'zlib.store.fetch: save record'
        const { bookId } = await ctx.database.create('w-zlibrary-stored-book', {
          ...book, fileName, assetId: asset.id, assetUrl: asset.url, storerUid: session.uid
        })
        await ctx.database.set('w-zlibrary-stats', 1, row => ({ bookCount: $.add(row.bookCount, 1) }))

        stage = 'zlib.store.fetch: send result'
        await session.send(<>
          成功转存书籍：<a href={asset.url}>#{bookId}</a>
          { options.send ? <>，正在发送文件……</> : '' }
        </>)

        if (options.send) {
          await session.send(<file url={asset.url} title={fileName} />)
        }
      }
      catch (err) {
        if (abortController?.signal.aborted) return <>已放弃下载</>
        return reportError(err, stage)
      }
      finally {
        if (identity) pending.delete(identity)
        await clearStatus?.()
      }
    })

  ctx.command('zlib.store.list', '查看已转存的 zlibrary 书籍')
    .option('page', '-p <page:posint> 指定页码')
    .action(async ({ options }) => {
      const { pageSize } = config
      const { page = 1 } = options
      const pageStart = (page - 1) * pageSize

      const [{ bookCount }] = await ctx.database.get('w-zlibrary-stats', 1)
      if (! bookCount) return <>暂无转存的书籍</>

      const pageCount = Math.ceil(bookCount / pageSize)
      if (page > pageCount) return <>已超过最大页码 {pageCount}</>

      const books = await ctx.database
        .select('w-zlibrary-stored-book')
        .orderBy('bookId', 'asc')
        .offset(pageStart)
        .limit(pageSize)
        .execute()

      return <as-forward level='always'>
        <message>查询到 {books.length}/{bookCount} 本转存的书籍（第 {page}/{pageCount} 页）</message>
        {await Promise.all(books.map(async book => <message>{await renderBook({ shortUrl: false })(book)}</message>))}
      </as-forward>
    })

  ctx.command('zlib.store.delete <id:number>', '删除已转存的 zlibrary 书籍', { authority: 3 })
    .action(async ({ session }, bookId) => {
      const [storedBook] = await ctx.database.get('w-zlibrary-stored-book', bookId)
      if (! storedBook) throw new SessionError('id', [<>未找到 id 为 #{bookId} 的转存书籍</>])

      await session.send(<>确定要删除转存书籍 #{bookId} {storedBook.title} 吗？（y/N）</>)
      const toDelete = await session.prompt(isYesResponse)
      if (! toDelete) return <>已取消删除</>

      try {
        await ctx.assetsPro.delete(storedBook.assetId)
      }
      catch (err) {
        if (err instanceof HTTP.Error && err.response?.status === 404) {
          ctx.logger.warn('asset not found when deleting stored book #%d, asset id %d', storedBook.bookId, storedBook.assetId)
        }
        else throw err
      }
      await Promise.all([
        ctx.database.remove('w-zlibrary-stored-book', bookId),
        ctx.database.set('w-zlibrary-stats', 1, row => ({
          bookCount: $.sub(row.bookCount, 1),
        }))
      ])
      return <>已删除转存书籍 #{bookId}</>
    })

  ctx.command('zlib.store.send <id:string>', '以文件形式发送转存的 zlibrary 书籍')
    .action(async ({ session }, id) => {
      const [storedBook] = await ctx.database.get('w-zlibrary-stored-book', + id)
      if (! storedBook) throw new SessionError('id', [<>未找到 id 为 <strong>{id}</strong> 的转存书籍</>])
      const extension = storedBook.extension.toLowerCase()
      const MAX_FILE_NAME_LENGTH = 32
      const fullFileName = `${storedBook.title}.${extension}`
      const fileName = `${ellipsis(storedBook.title, MAX_FILE_NAME_LENGTH - extension.length - 1)}.${extension}`
      await session.send(<>正在发送文件（{fullFileName}）……</>)
      return <file url={storedBook.assetUrl} title={fileName} />
    })
}
