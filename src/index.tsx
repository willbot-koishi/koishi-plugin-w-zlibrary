import { capitalize, Context, SessionError, z } from 'koishi'
import {} from 'koishi-plugin-w-assets-remote'
import {} from 'koishi-plugin-w-as-forward'
import {} from 'koishi-plugin-w-as-slices'

import * as cheerio from 'cheerio'

export const name = 'w-zlibrary'

export const inject = [ 'http', 'assetsAlt', 'database' ]

export interface Config {
    cookie: string
    domain: string
    pageSize: number
    sliceLength: number
    downloadTimeout: number
}

export const Config: z<Config> = z.object({
    cookie: z.string().role('textarea').default('').description('要使用的 Cookie（主要用于登录，登录后才能获取下载链接等）'),
    domain: z.string().default('z-lib.fm').description('要使用的 zlibrary 域名'),
    pageSize: z.natural().default(30).description('搜索结果每页显示的条目数'),
    sliceLength: z.natural().default(5000).description('搜索结果每条的字数限制'),
    downloadTimeout: z.natural().default(30000).description('下载超时时间（毫秒）')
})

interface Book {
    title: string
    authors: string[]
    coverUrl?: string
    url: string
    downloadUrl?: string
    year: number
    language: string
    fileSize?: string
    extension?: string
    rating: number
    quality: number
}

interface StoredBook extends Book {
    assetId: number
    fileName: string
    assetUrl: string
    storerUid: string
}

declare module 'koishi' {
    interface Tables {
        'w-zlibrary-stored-book': StoredBook
    }
}

const escapeRegExp = (segments: TemplateStringsArray, ...args: string[]) => {
    const re = segments
        .map((segment, index) => segment + (args[index]?.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&') ?? ''))
        .join('')
    return new RegExp(re, 'g')
}

export function apply(ctx: Context, config: Config) {
    type LoginStat = null | {
        username: string
        limit: {
            rest: number
            total: number
        }
    }

    const getLoginStat = ($: cheerio.CheerioAPI): LoginStat => {
        const username = $('.user-card__name').text().trim()
        if (! username) return null
        const limit = $('.user-card__status + div > div:first-child > div:first-child > div:first-child').text().trim()
        const [ rest, total ] = limit.split('/').map(Number)
        return {
            username,
            limit: { rest, total }
        }
    }

    const showLoginStat = (stat: LoginStat) => {
        if (! stat) return '未登录'
        const { username, limit } = stat
        return `已登录：${username}，剩余 ${limit.rest}/${limit.total} 次下载`
    }

    const validateDetailUrl = (url: string) => {
        const match = url.match(escapeRegExp`^((https?://)?${config.domain})?/book/.*\\.html$`)
        if (! match) throw new SessionError('id', [ <>请提供正确的 zlibrary <strong>详情</strong>链接</> ])
        const path = url.replace(escapeRegExp`^(https?://)?${config.domain}`, '')
        return {
            path,
            url: `https://${config.domain}${path}`
        }
    }

    const getUrl = (url: string, short: boolean) => (short ? '' : `https://${config.domain}`) + decodeURI(url) 

    const renderRating = (rating: number) => '★'.repeat(rating) || '☆'

    const renderBook = (options: { shortUrl: boolean, header?: any }) => (book: Book | StoredBook, index?: number) => <>
        { options.header ?? <></> }
        { typeof index === 'number' ? <>
            <br />[#{index + 1}]
        </> : '' }
        <br /> [标题] { book.title }
        { book.coverUrl ? <>
            <br />[封面] <img src={book.coverUrl} />
        </> : '' }
        <br />[作者] { (book.authors.length > 2 ? book.authors.slice(0, 2).concat('...') : book.authors).join('; ') }
        <br />[年份] { book.year || 'N/A' } [语言] { capitalize(book.language) }
        <br />[评分] { renderRating(book.rating) } [质量] { renderRating(book.quality) }
        <br />[详情] <a href={ getUrl(book.url, options.shortUrl) }></a>
        { book.downloadUrl ? <>
            <br />[大小] { book.fileSize } [类型] { book.extension } [下载] <a href={ getUrl(book.downloadUrl, options.shortUrl) }></a>
        </> : '' }
        { 'assetUrl' in book ? <>
            <br />[转存] <a href={ book.assetUrl }>#{ book.assetId }</a>
        </> : '' }
    </>

    const fetchBookDetail = async (detailUrl: string) => {
        const html = await ctx.http.get(detailUrl, {
            responseType: 'text',
            headers: {
                Cookie: config.cookie
            }
        })
        const $ = cheerio.load(html)

        const [ extension, fileSize ] = $('.property__file > .property_value').text().split(', ')

        const book: Book = {
            title: $('.book-title').text(),
            coverUrl: $('.details-book-cover-container > z-cover img').data('src') as string,
            authors: $('.book-title + i > a').toArray().map(el => $(el).text()),
            url: detailUrl,
            downloadUrl: $('a[href^="/dl/"]').attr('href'),
            year: + $('.property_year > .property_value').text(),
            language: $('.property_language > .property_value').text(),
            fileSize,
            extension,
            rating: + $('.book-rating-interest-score').text(),
            quality: + $('.book-rating-quality-score').text()
        }

        return book
    }

    ctx.model.extend('w-zlibrary-stored-book', {
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
        assetUrl: 'string',
        storerUid: 'string',
        assetId: 'unsigned'
    }, {
        primary: 'assetId',
        autoInc: true
    })

    ctx.i18n.define('en-US', {
        id: '{0}'
    })

    ctx.command('zlib', 'zlibrary 功能')

    ctx.command('zlib.stat', '查看 zlibrary 登录状态')
        .action(async () => {
            const requestUrl = `https://${config.domain}/`
            const html = await ctx.http.get(requestUrl, {
                responseType: 'text',
                headers: {
                    Cookie: config.cookie
                }
            })
            const $ = cheerio.load(html)
            const stat = getLoginStat($)
            return showLoginStat(stat)
        })

    ctx.command('zlib.search <filter:text>', '在 zlibrary 中搜索书籍')
        .option('shortUrl', '-s 显示短链接')
        .option('page', '-p <page:posint> 指定页码')
        .action(async ({ session, options: { page, shortUrl } }, filter) => {
            const startTime = Date.now()

            const requestUrl = `https://${config.domain}/s/${filter}?` + new URLSearchParams({
                ...page && { page: String(page) }
            })
            const html = await ctx.http.get(requestUrl, {
                responseType: 'text',
                headers: {
                    Cookie: config.cookie
                }
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
                        url: $item.attr('href'),
                        downloadUrl: $item.attr('download'),
                        year: + $item.attr('year'),
                        language: $item.attr('language'),
                        fileSize: $item.attr('filesize'),
                        extension: $item.attr('extension'),
                        rating: + $item.attr('rating'),
                        quality: + $item.attr('quality')
                    }
                })

            const itemTexts = items.map(item => <message>
                { renderBook({ shortUrl, header: <br /> })(item) }
            </message>)

            const pageTotal = + $('.paginator + script').text().match(/pagesTotal:\s*(\d+)/)?.[1] || '?'
            const pageText = `（第 ${page ?? 1}/${pageTotal} 页）`
            const headerText = `在 ${config.domain} 找到 ${items.length} 条符合 "${filter}" 的结果${pageText}`
                + `，用时 ${durationText} 秒`
                + `（${ showLoginStat(getLoginStat($)) }）`

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
        .action(async ({ session }, url) => {
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

                const [ storedBook ] = await ctx.database.get('w-zlibrary-stored-book', fileName)
                if (storedBook) {
                    return <>已转存过此书籍：{storedBook.assetUrl}</>
                }

                session.send(<>已获取<a href={downloadUrl}>下载链接</a>，下载中……</>)

                const abortController = new AbortController()

                const timeoutTimer = setTimeout(async () => {
                    await session.send(<>下载时间过长，已超过 {config.downloadTimeout / 1000} 秒，是否继续等待？（y/N）</>)
                    const toContinue = await session.prompt(response => {
                        if (session.uid !== response.uid) return
                        return { y: true, n: false }[ response.content.toLowerCase() ]
                    })
                    if (! toContinue) abortController.abort()
                    else await session.send(<>正在继续下载……</>)
                }, config.downloadTimeout)

                const downloadBlob = await ctx.http.get(downloadUrl, {
                    responseType: 'blob',
                    headers: {
                        Cookie: config.cookie
                    },
                    keepAlive: true,
                    signal: abortController.signal
                })

                clearTimeout(timeoutTimer)
                await session.send(<>下载完成，正在上传文件……</>)

                const assetUrl = await ctx.assetsAlt.uploadFile(downloadBlob, fileName)
                const { assetId } = await ctx.database.create('w-zlibrary-stored-book', {
                    ...book,
                    fileName,
                    assetUrl,
                    storerUid: session.uid
                })

                return <>成功转存书籍：<a href={assetUrl}>#{assetId}</a></>
            }
            catch (err) {
                if (err instanceof Error && err.name === 'AbortError') return <>已放弃下载</>
                return <>发生错误：{err}</>
            }
        })
    
    ctx.command('zlib.store.list', '查看已转存的 zlibrary 书籍')
        .action(async () => {
            const storedBooks = await ctx.database.get('w-zlibrary-stored-book', {})
            return <as-forward level='always'>
                <message>共有 { storedBooks.length } 本转存的书籍</message>
                { storedBooks.map(renderBook({ shortUrl: false })).map(el => <message>{ el }</message>) }
            </as-forward>
        })

    ctx.command('zlib.store.send <id:string>', '以文件形式发送转存的 zlibrary 书籍')
        .action(async ({ session }, id) => {
            const [ storedBook ] = await ctx.database.get('w-zlibrary-stored-book', + id)
            if (! storedBook) throw new SessionError('id', [ <>未找到 id 为 <strong>{id}</strong> 的转存书籍</> ])
            session.send(<>正在发送文件……</>)
            return <file url={storedBook.assetUrl} />
        })
}
