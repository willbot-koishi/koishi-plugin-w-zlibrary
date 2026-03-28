import { $, capitalize, Context, HTTP, SessionError, z } from 'koishi'
import {} from 'koishi-plugin-w-assets-core'
import {} from 'koishi-plugin-w-as-forward'

import * as cheerio from 'cheerio'

export const name = 'w-zlibrary'

export const inject = ['http', 'assetsPro', 'database']

export interface Config {
  cookie: string
  domain: string
  pageSize: number
  downloadTimeout: number
}

export const Config: z<Config> = z.object({
  cookie: z.string().role('textarea').default('').description('要使用的 Cookie（主要用于登录，登录后才能获取下载链接等）'),
  domain: z.string().default('z-lib.fm').description('要使用的 zlibrary 域名'),
  pageSize: z.natural().default(30).description('搜索结果每页显示的条目数'),
  downloadTimeout: z.natural().default(60_000).description('下载超时时间（毫秒）')
})

interface Book {
  title: string
  authors: string[]
  coverUrl?: string
  url: string
  downloadUrl: string
  year: number
  language: string
  fileSize?: string
  extension: string
  rating: number
  quality: number
}

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

type LoginState = null | {
  username: string
  limit: {
    used: number
    total: number
  }
}

const escapeRegExp = (segments: TemplateStringsArray, ...args: string[]) => {
  const re = segments
    .map((segment, index) => segment + (args[index]?.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&') ?? ''))
    .join('')
  return new RegExp(re, 'g')
}

const parseLoginState = ($: cheerio.CheerioAPI): LoginState => {
  const username = $('.user-card__name').text().trim()
  if (! username) return null
  const limit = $('.user-card__status + div > div:first-child > div:first-child > div:first-child').text().trim()
  const [used, total] = limit.split('/').map(Number)
  return {
    username,
    limit: { used, total }
  }
}

const showLoginState = (stat: LoginState) => {
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
  const validateDetailUrl = (url: string) => {
    const match = url.match(escapeRegExp`^((https?://)?${config.domain})?/book/.*\\.html$`)
    if (! match) throw new SessionError('id', [<>请提供正确的 zlibrary <strong>详情</strong>链接</>])
    const path = url.replace(escapeRegExp`^(https?://)?${config.domain}`, '')
    return {
      path,
      url: `https://${config.domain}${path}`
    }
  }

  const getUrl = (url: string, short: boolean) => (short ? '' : `https://${config.domain}`) + decodeURI(url)

  const renderRating = (rating: number) => '★'.repeat(rating) || '☆'

  const renderBook = (options: { shortUrl: boolean, header?: any }) => (book: Book | StoredBook) => <>
    { options.header ?? <></> }
    { 'bookId' in book ? <>
      <br />[#{book.bookId}]
    </> : '' }
    <br />[标题] {book.title}
    { book.coverUrl ? <>
      <br />[封面] <img src={book.coverUrl} />
    </> : '' }
    <br />[作者] { (book.authors.length > 2 ? book.authors.slice(0, 2).concat('...') : book.authors).join('; ') }
    <br />[年份] { book.year || 'N/A' } [语言] { capitalize(book.language) }
    <br />[评分] { renderRating(book.rating) } [质量] { renderRating(book.quality) }
    <br />[详情] { getUrl(book.url, options.shortUrl) }
    { book.downloadUrl ? <>
      <br />[大小] {book.fileSize} [类型] {book.extension}
    </> : '' }
    { 'assetUrl' in book ? <>
      <br />[转存] <a href={book.assetUrl}>#{book.assetId}</a>
    </> : '' }
  </>

  const request = async <K extends keyof HTTP.ResponseTypes>(
    method: HTTP.Method, url: string, reqConfig: HTTP.RequestConfig & { responseType: K }
  ): Promise<HTTP.ResponseTypes[K]> => {
    const { headers: basicHeaders, ...basicReqConfig } = reqConfig
    const resp = await ctx.http(method, url, {
      headers: {
        ...basicHeaders,
        Cookie: config.cookie
      },
      ...basicReqConfig,
    })
    return resp.data as HTTP.ResponseTypes[K]
  }

  const fetchBookDetail = async (detailUrl: string) => {
    const html = await request('GET', detailUrl, {
      responseType: 'text'
    })
    const $ = cheerio.load(html)

    const [extension, fileSize] = $('.property__file > .property_value').text().split(', ')

    const book: Book = {
      title: $('.book-title').text(),
      coverUrl: $('.details-book-cover-container > z-cover img').data('src') as string,
      authors: $('.book-title + i > a').toArray().map(el => $(el).text()),
      url: detailUrl,
      downloadUrl: $('a[href^="/dl/"]').attr('href')!,
      year: Number($('.property_year > .property_value').text()),
      language: $('.property_language > .property_value').text(),
      fileSize,
      extension,
      rating: Number($('.book-rating-interest-score').text()),
      quality: Number($('.book-rating-quality-score').text())
    }

    return book
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

  ctx.command('zlib', 'zlibrary 功能')

  ctx.command('zlib.state', '查看 zlibrary 登录状态')
    .action(async () => {
      const requestUrl = `https://${config.domain}/`
      const html = await request('GET', requestUrl, {
        responseType: 'text',
      })
      const $ = cheerio.load(html)
      const state = parseLoginState($)
      return showLoginState(state)
    })

  ctx.command('zlib.search <filter:text>', '在 zlibrary 中搜索书籍')
    .option('shortUrl', '-s 显示短链接')
    .option('page', '-p <page:posint> 指定页码')
    .action(async ({ session, options }, filter) => {
      const { page, shortUrl = false } = options
      const startTime = Date.now()

      const requestUrl = `https://${config.domain}/s/${encodeURIComponent(filter)}?` + new URLSearchParams({
        ...page && { page: String(page) }
      })
      const html = await request('GET', requestUrl, {
        responseType: 'text',
      })

      const endTime = Date.now()
      const durationText = ((endTime - startTime) / 1000).toFixed(2)

      const $ = cheerio.load(html)
      const items = $('z-bookcard')
        .toArray()
        .map((el): Book => {
          const $item = $(el)
          const $title = $item.find('[slot=title]')
          const $author = $item.find('[slot=author]')
          return {
            title: $title.text(),
            authors: $author.text().split(';'),
            url: $item.attr('href')!,
            downloadUrl: $item.attr('download')!,
            year: Number($item.attr('year')!),
            language: $item.attr('language')!,
            fileSize: $item.attr('filesize'),
            extension: $item.attr('extension')!,
            rating: Number($item.attr('rating')!),
            quality: Number($item.attr('quality')!),
          }
        })

      const itemTexts = items.map(item => <message>
        { renderBook({ shortUrl, header: <br /> })(item) }
      </message>)

      const pageTotal = Number($('.paginator + script').text().match(/pagesTotal:\s*(\d+)/)?.[1]) || '?'
      const pageText = `（第 ${page ?? 1}/${pageTotal} 页）`
      const headerText = `在 ${config.domain} 找到 ${items.length} 条符合 "${filter}" 的结果${pageText}`
        + `，用时 ${durationText} 秒`
        + `（${ showLoginState(parseLoginState($)) }）`

      const { pageSize } = config
      for (let i = 0; i < itemTexts.length / pageSize; i ++) {
        await session.sendQueued(<as-forward level='always'>
          { headerText }
          { itemTexts.slice(i * pageSize, (i + 1) * pageSize) }
        </as-forward>)
      }
    })

  ctx.command('zlib.detail <url:string>', '查看 zlibrary 书籍详情')
    .action(async ({ session }, url) => {
      const { url: detailUrl } = validateDetailUrl(url)
      const startTime = Date.now()

      session.send(<>正在请求详情页面……</>)

      const book = await fetchBookDetail(detailUrl)

      const endTime = Date.now()
      const durationText = ((endTime - startTime) / 1000).toFixed(2)

      return <as-forward level='always'>
        已获取书籍详情，用时 {durationText} 秒<br />
        { renderBook({ shortUrl: false })(book) }
      </as-forward>
    })

  ctx.command('zlib.store', 'zlibrary 书籍转存功能')

  ctx.command('zlib.store.fetch <url:string>', '转存 zlibrary 书籍到 Koishi')
    .option('send', '-s 转存完成后立即发送书籍文件')
    .action(async ({ session, options }, url) => {
      try {
        const { url: detailUrl, path: detailPath } = validateDetailUrl(url)

        session.send(<>正在请求详情页面……</>)

        const book = await fetchBookDetail(detailUrl)
        const { extension } = book
        const downloadUrl = getUrl(book.downloadUrl, false)
        const fileName = detailPath
          .slice('/book/'.length)
          .replaceAll('/', '_')
          .replace(/html$/, extension)

        const [storedBook] = await ctx.database.get('w-zlibrary-stored-book', { fileName })
        if (storedBook) {
          return <>已转存过此书籍：<a href={storedBook.assetUrl}>#{storedBook.bookId}</a></>
        }

        session.send(<>已获取<a href={downloadUrl}>下载链接</a>，下载中……</>)

        const abortController = new AbortController()

        const timeoutTimer = setTimeout(async () => {
          await session.send(<>下载时间过长，已超过 {config.downloadTimeout / 1000} 秒，是否继续等待？（y/N）</>)
          const toContinue = await session.prompt(isYesResponse)
          if (! toContinue) abortController.abort()
          else await session.send(<>正在继续下载……</>)
        }, config.downloadTimeout)

        let downloadBlob: Blob

        try {
          downloadBlob = await request('GET', downloadUrl, {
            responseType: 'blob',
            keepAlive: true,
            signal: abortController.signal,
          })
        }
        catch (err) {
          return <>下载失败：{err instanceof Error ? err.message : err}</>
        }
        finally {
          clearTimeout(timeoutTimer)
        }

        await session.send(<>下载完成，正在上传文件……</>)

        const asset = await ctx.assetsPro.uploadFromFile(downloadBlob, {
          name: fileName,
          sourceUrl: downloadUrl,
          categoryId: 'zlibrary',
        })

        const [{ bookId }] = await Promise.all([
          ctx.database.create('w-zlibrary-stored-book', {
            ...book,
            fileName,
            assetId: asset.id,
            assetUrl: asset.url,
            storerUid: session.uid
          }),
          ctx.database.set('w-zlibrary-stats', 1, row => ({
            bookCount: $.add(row.bookCount, 1),
          }))
        ])

        await session.send(<>
          成功转存书籍：<a href={asset.url}>#{bookId}{}</a>
          { options.send ? <>，正在发送文件……</> : '' }
        </>)

        if (options.send) {
          await session.send(<file url={asset.url} title={fileName} />)
        }
      }
      catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return <>已放弃下载</>
        return <>发生错误：{err}</>
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
        { books.map(book => <message>{ renderBook({ shortUrl: false })(book) }</message>) }
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
      const fileName = `${ellipsis(storedBook.title, MAX_FILE_NAME_LENGTH - extension.length + 1)}.${extension}`
      session.send(<>正在发送文件（{fullFileName}）……</>)
      return <file url={storedBook.assetUrl} title={fileName} />
    })
}
