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
}

export const Config: z<Config> = z.object({
    cookie: z.string().role('textarea').default('').description('要使用的 Cookie（主要用于登录，登录后      才能获取下载链接等）'),
    domain: z.string().default('z-lib.fm').description('要使用的 zlibrary 域名')
})

const escapeRegExp = (segments: TemplateStringsArray, ...args: string[]) => {
    const re = segments
        .map((segment, index) => segment + (args[index]?.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&') ?? ''))
        .join('')
    return new RegExp(re, 'g')
}

export function apply(ctx: Context, config: Config) {
    ctx.command('zlib', 'zlibrary 功能')

    const getLoginStat = (username?: string) => username ? `已登录：${username}` : '未登录'

    const validateDetailUrl = (url: string) => {
        const match = url.match(escapeRegExp`^((https?://)?${config.domain})?/book/.*\\.html$`)
        if (! match) throw new SessionError('id', [ <>请提供正确的 zlibrary <strong>详情</strong>链接</> ])
        const path = url.replace(escapeRegExp`^(https?://)?${config.domain}`, '')
        return {
            path,
            url: `https://${config.domain}${path}`
        }
    }

    ctx.command('zlib.loginstat', '查看 zlibrary 登录状态')
        .action(async () => {
            const requestUrl = `https://${config.domain}/`
            const html = await ctx.http.get(requestUrl, {
                responseType: 'text',
                headers: {
                    Cookie: config.cookie
                }
            })
            const $ = cheerio.load(html)
            const username = $('.user-card__name').text().trim()
            return getLoginStat(username)
        })

    ctx.i18n.define('en-US', {
        id: '{0}'
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

    const getUrl = (url: string, short: boolean) => (short ? '' : `https://${config.domain}`) + decodeURI(url) 

    const renderRating = (rating: number) => '★'.repeat(rating) || '☆'

    const renderBook = (options: { shortUrl: boolean, header?: any }) => (book: Book, index?: number) => <>
        { options.header ?? <></> }
        { typeof index === 'number' ? <>
            <br /> [#{index + 1}]
        </> : '' }
        <br /> [标题] { book.title }
        { book.coverUrl ? <>
            <br /> [封面] <img src={book.coverUrl} />
        </> : '' }
        <br /> [作者] { (book.authors.length > 2 ? book.authors.slice(0, 2).concat('...') : book.authors).join('; ') }
        <br /> [年份] { book.year || 'N/A' } [语言] { capitalize(book.language) }
        <br /> [评分] { renderRating(book.rating) } [质量] { renderRating(book.quality) }
        <br /> [详情] <a href={ getUrl(book.url, options.shortUrl) }></a>
        { book.downloadUrl ? <>
            <br /> [大小] { book.fileSize } [类型] { book.extension } [下载] <a href={ getUrl(book.downloadUrl, options.shortUrl) }></a>
        </> : '' }
    </>

    ctx.command('zlib.search <filter:text>', '在 zlibrary 中搜索书籍')
        .option('shortUrl', '-s 显示短链接')
        .option('page', '-p <page:posint> 指定页码')
        .action(async ({ options: { page, shortUrl } }, filter) => {
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

            const username = $('.user-card__name').text().trim()

            const itemTexts = items.map(renderBook({ shortUrl, header: <br /> }))

            const pageTotal = + $('.paginator + script').text().match(/pagesTotal:\s*(\d+)/)?.[1] || '?'
            const pageText = `（第 ${page ?? 1}/${pageTotal} 页）`
            const headerText = `在 ${config.domain} 找到 ${items.length} 条符合 "${filter}" 的结果${pageText}`
                + `，用时 ${durationText} 秒`
                + `（${getLoginStat(username)}）`

            return <as-forward level='always'>
                <as-slices sliceLength={5000} header={headerText}>
                    { itemTexts }
                </as-slices>
            </as-forward>
        })

    ctx.command('zlib.detail <url:string>', '查看 zlibrary 书籍详情')
        .action(async ({ session }, url) => {
            const { url: detailUrl } = validateDetailUrl(url)
            const startTime = Date.now()

            session.send(<>正在请求详情页面……</>)
            const html = await ctx.http.get(detailUrl, {
                responseType: 'text',
                headers: {
                    Cookie: config.cookie
                }
            })
            const $ = cheerio.load(html)

            const [ fileType, fileSize ] = $('.property__file > .property_value').text().split(', ')

            const book: Book = {
                title: $('.book-title').text(),
                coverUrl: $('.details-book-cover-container > z-cover img').data('src') as string,
                authors: $('.book-title + i > a').toArray().map(el => $(el).text()),
                url: detailUrl,
                downloadUrl: $('a[href^="/dl/"]').attr('href'),
                year: + $('.property_year > .property_value').text(),
                language: $('.property_language > .property_value').text(),
                fileSize,
                extension: fileType,
                rating: + $('.book-rating-interest-score').text(),
                quality: + $('.book-rating-quality-score').text()
            }
            
            const endTime = Date.now()
            const durationText = ((endTime - startTime) / 1000).toFixed(2)

            return <as-forward level='always'>
                已获取书籍详情，用时 {durationText} 秒<br />
                { renderBook({ shortUrl: false })(book) }
            </as-forward>
        })

    ctx.command('zlib.store <url:string>', '转存 zlibrary 的书籍到 Koishi', { authority: 2 })
        .action(async ({ session }, url) => {
            const { url: detailUrl, path: detailPath } = validateDetailUrl(url)

            session.send(<>正在请求详情页面……</>)
            const html = await ctx.http.get(detailUrl, {
                responseType: 'text',
                headers: {
                    Cookie: config.cookie
                }
            })
            const $ = cheerio.load(html)

            const downloadPath = $('a[href^="/dl/"]').attr('href')
            const downloadUrl = `https://${config.domain}${downloadPath}`
            session.send(<>已获取<a href={downloadUrl}>下载链接</a>，下载中……</>)

            const downloadBlob = await ctx.http.get(downloadUrl, {
                responseType: 'blob',
                headers: {
                    Cookie: config.cookie
                }
            })

            const extname = $('.book-property__extension').text()
            const filename = detailPath.slice('/book/'.length).replaceAll('/', '_').replace(/html$/, extname)
            const assetUrl = await ctx.assetsAlt.uploadFile(downloadBlob, filename)

            return <>成功转存到 Koishi：{assetUrl}</>
        })
}
