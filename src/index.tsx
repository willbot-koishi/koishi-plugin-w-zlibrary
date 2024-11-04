import { capitalize, Context, z } from 'koishi'
import {} from 'koishi-plugin-w-assets-remote'
import {} from 'koishi-plugin-w-as-forward'
import {} from 'koishi-plugin-w-as-slices'

import * as cheerio from 'cheerio'

export const name = 'w-zlibrary'

export const inject = [ 'http', 'assetsAlt' ]

export interface Config {
    cookie: string
    domain: string
}

export const Config: z<Config> = z.object({
    cookie: z.string().role('textarea').default('').description('要使用的 Cookie（主要用于登录，登录后      才能获取下载链接等）'),
    domain: z.string().default('z-lib.fm').description('要使用的 zlibrary 域名')
})

export function apply(ctx: Context, config: Config) {
    ctx.command('zlib', 'zlibrary 功能')

    const getLoginStat = (username?: string) => username ? `已登录：${username}` : '未登录'

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
                .map(el => {
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
                        size: $item.attr('filesize'),
                        rating: + $item.attr('rating')
                    }
                })

            const username = $('.user-card__name').text().trim()

            const getUrl = (url: string) => (shortUrl ? '' : `https://${config.domain}`) + decodeURI(url) 

            const itemTexts = items
                .map((item, index) => <>
                    <br />
                    <br /> [#{index + 1}]
                    <br /> [标题] { item.title }
                    <br /> [作者] { (item.authors.length > 2 ? item.authors.slice(0, 2).concat('...') : item.authors).join('; ') }
                    <br /> [年份] { item.year || 'N/A' } [语言] { capitalize(item.language) } [评分] { '★'.repeat(item.rating) || '☆' }
                    <br /> [详情] <a href={getUrl(item.url)}></a>
                    { item.downloadUrl && <>
                        <br /> [大小] { item.size } [下载] <a href= {getUrl(item.downloadUrl) }></a>
                    </> }
                </>)

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

    ctx.command('zlib.store <url:string>', '转存 zlibrary 的书籍到 Koishi', { authority: 2 })
        .action(async ({ session }, url) => {
            const escapeRegExp = (segments: TemplateStringsArray, ...args: string[]) => {
                const re = segments
                    .map((segment, index) => segment + (args[index]?.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&') ?? ''))
                    .join('')
                return new RegExp(re, 'g')
            }

            const match = url.match(escapeRegExp`(https?://|/)?${config.domain}/book/.*\\.html`)
            if (! match) return <>请提供正确的 zlibrary <strong>详情</strong>链接</>
            const path = new URL(url).pathname
            url = `https://${config.domain}${path}`

            session.send(<>正在请求详情页面……</>)

            const html = await ctx.http.get(url, {
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
            const filename = path.slice('/book/'.length).replaceAll('/', '_').replace(/html$/, extname)
            const assetUrl = await ctx.assetsAlt.uploadFile(downloadBlob, filename)

            return <>成功转存到 Koishi：{assetUrl}</>
        })
}
