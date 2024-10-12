import { Context, h, z } from 'koishi'
import {} from 'koishi-plugin-w-as-forward'

import * as cheerio from 'cheerio'

export const name = 'w-zlibrary'

export const inject = [ 'http' ]

export interface Config {
    cookie: string
    domain: string
}

export const Config: z<Config> = z.object({
    cookie: z.string().role('textarea').default('').description('要使用的 Cookie（主要用于登录，登录后  才能获取下载链接等）'),
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


    ctx.command('zlib.search <filter:string>', '在 zlibrary 中搜索书籍')
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
            const items = $('.resItemBox')
                .toArray()
                .map(el => {
                    const $item = $(el)
                    const $title = $item.find('h3 > a')
                    const $authors = $item.find('.authors > a')
                    return {
                        title: $title.text(),
                        url: $title.attr('href'),
                        downloadUrl: $item.find('.property__file > a').attr('href'),
                        cover: $item.find('z-cover > a').attr('href'),
                        authors: $authors.toArray().map(el => $(el).text()),
                        year: $item.find('.property_year > .property_value').text(),
                        language: $item.find('.property_language > .property_value').text()
                    }
                })

            const username = $('.user-card__name').text().trim()

            const getUrl = (url: string) => (shortUrl ? '' : `https://${config.domain}`) + decodeURI(url) 

            const itemTexts = items
                .map((item, index) => <>
                    <br />
                    <br /> [#{index + 1}]
                    <br /> [标题] {item.title}
                    <br /> [作者] {item.authors.join(', ')} [年份] {item.year} [语言] ${item.language}
                    <br /> [详情] <a href={getUrl(item.url)}></a>
                    { item.downloadUrl && <>
                        <br /> [下载] <a href={getUrl(item.downloadUrl)}></a>
                    </> }
                </>)

            const pageTotal = + $('.paginator + script').text().match(/pagesTotal:\s*(\d+)/)?.[1] || '?'
            const pageText = `（第 ${page ?? 1}/${pageTotal} 页）`
            const headerText = `在 ${config.domain} 找到 ${items.length} 条符合 "${filter}" 的结果${pageText}`
                + `，用时 ${durationText} 秒`
                + `（${getLoginStat(username)}）`

            const MAX_SLICE_LENGTH = 5000
            const [ itemTextSlices ] = itemTexts.reduce<[ string[], string ]>(([ slices, currentSlice ], text, index) => {
                const appendedSlice = currentSlice + text
                if (appendedSlice.length >= MAX_SLICE_LENGTH || index === itemTexts.length - 1) {
                    slices.push(appendedSlice)
                    return [ slices, '' ]
                }
                return [ slices, appendedSlice ]
            }, [ [], headerText ])

            return <as-forward level='always'>
                { itemTextSlices.map(slice => <message>
                    { h.parse(slice) }
                </message>) }
            </as-forward>
        })
}
