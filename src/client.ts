import { HTTP } from 'koishi'

export interface Book {
  sourceId: string
  sourceHash: string
  title: string
  authors: string[]
  coverUrl?: string
  url: string
  downloadUrl: string
  year: number
  language: string
  fileSize?: string
  fileBytes: number
  extension: string
  rating: number
  quality: number
}

export interface LoginState {
  username: string
  limit: { used: number, total: number }
}

export class ZLibraryError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function natural(value: unknown) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

export function bookPath(value: string, origin: string) {
  let pathname: string
  try {
    pathname = new URL(value, origin).pathname
  } catch {
    throw new ZLibraryError('请提供正确的 Z-Library 书籍详情链接。')
  }
  const legacy = /^\/book\/(\d+)\/([a-f\d]{4,64})(?:\/[^/]+)?\/?$/i.exec(pathname)
  if (legacy) return `/eapi/book/${legacy[1]}/${legacy[2]}`
  const current = /^\/book\/([a-z\d]{8,32})(?:\/[^/]+)?\/?$/i.exec(pathname)
  if (current && /[a-z]/i.test(current[1])) return `/eapi/book/${current[1]}`
  throw new ZLibraryError('请提供正确的 Z-Library 书籍详情链接。')
}

export class ZLibraryClient {
  readonly origin: string
  private headers?: Record<string, string>

  constructor(private http: HTTP, domain: string, cookie: string) {
    const url = new URL(domain.includes('://') ? domain : `https://${domain}`)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Z-Library domain must be an HTTPS origin without credentials or a path')
    }
    this.origin = url.origin
    const cookies = Object.fromEntries(cookie.split(';').map((part) => {
      const index = part.indexOf('=')
      return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()]
    }))
    const id = cookies.remix_userid
    const key = cookies.remix_userkey
    if (id && key && /^\d+$/.test(id) && !/[\r\n]/.test(key)) {
      // Only the account session is needed; never send browser challenge cookies.
      this.headers = {
        Accept: 'application/json',
        // Match the verified API client rather than Node's implicit "node"
        // User-Agent, which changes opaque-link support and quota responses.
        'User-Agent': 'undici',
        Cookie: `remix_userid=${id}; remix_userkey=${key}`,
        'remix-userid': id,
        'remix-userkey': key,
      }
    }
  }

  private async request(path: string, data?: URLSearchParams) {
    if (!this.headers) throw new ZLibraryError('请在插件配置中填写含 remix_userid 和 remix_userkey 的有效 Cookie。')
    try {
      const response = await this.http<unknown>(`${this.origin}${path}`, {
        method: data ? 'POST' : 'GET', data,
        headers: this.headers,
        responseType: 'json',
        redirect: 'error',
        timeout: 20_000,
      })
      if (!record(response.data) || response.data.success !== 1) {
        throw new ZLibraryError('Z-Library 拒绝了请求，请检查登录状态及下载额度。')
      }
      return response.data
    } catch (error) {
      if (error instanceof ZLibraryError) throw error
      if (HTTP.Error.is(error) && [401, 403].includes(error.response?.status ?? 0)) {
        throw new ZLibraryError('登录已失效或站点拒绝访问，请更新 Cookie，或更换可用域名。', { cause: error })
      }
      if (HTTP.Error.is(error) && error.response?.data?.error === 'Requested book not found') {
        throw new ZLibraryError('未找到该书籍，请检查详情链接。', { cause: error })
      }
      throw new ZLibraryError('Z-Library 请求失败，请检查网络、域名及登录状态。', { cause: error })
    }
  }

  private normalize(value: unknown): Book {
    if (!record(value)) throw new ZLibraryError('Z-Library 返回了无效的书籍信息。')
    const id = String(value.id ?? '')
    const hash = text(value.hash)
    if (!/^\d+$/.test(id) || !/^[a-f\d]{4,64}$/i.test(hash) || !text(value.title)) {
      throw new ZLibraryError('Z-Library 返回了无效的书籍信息。')
    }
    let url = `${this.origin}/book/${id}/${hash}`
    if (text(value.href)) {
      const upstream = new URL(text(value.href), this.origin)
      bookPath(upstream.href, this.origin)
      // Website aliases may differ from the configured API domain. Keep the
      // book path, but all subsequent authenticated requests use our origin.
      url = new URL(upstream.pathname, this.origin).href
    }
    let coverUrl: string | undefined
    if (text(value.cover)) {
      const cover = new URL(text(value.cover), this.origin)
      if (cover.protocol === 'https:' && !cover.username && !cover.password) coverUrl = cover.href
    }
    return {
      sourceId: id, sourceHash: hash,
      title: text(value.title), authors: text(value.author).split(';').map(x => x.trim()).filter(Boolean),
      coverUrl, url, downloadUrl: '', year: natural(value.year) ?? 0,
      language: text(value.language), extension: text(value.extension).toLowerCase(),
      fileSize: text(value.filesizeString) || (natural(value.filesize) === undefined ? '' : `${value.filesize} B`),
      fileBytes: natural(value.filesize) ?? 0,
      rating: Math.max(0, Math.min(5, Math.round(Number(value.interestScore) || 0))),
      quality: Math.max(0, Math.min(5, Math.round(Number(value.qualityScore) || 0))),
    }
  }

  async profile(): Promise<LoginState | null> {
    if (!this.headers) return null
    const data = await this.request('/eapi/user/profile')
    const user = data.user
    if (!record(user) || String(user.id) !== this.headers['remix-userid']) {
      throw new ZLibraryError('登录已失效，请更新 Cookie。')
    }
    const used = natural(user.downloads_today ?? user.dailyDownloadsCount)
    const total = natural(user.downloads_limit ?? user.dailyDownloadLimit)
    if (used === undefined || total === undefined) throw new ZLibraryError('Z-Library 返回了无效的下载额度。')
    return { username: text(user.name), limit: { used, total } }
  }

  async search(query: string, page: number, limit: number) {
    const data = await this.request('/eapi/book/search', new URLSearchParams({ message: query, page: String(page), limit: String(limit) }))
    if (!Array.isArray(data.books)) throw new ZLibraryError('Z-Library 返回了无效的搜索结果。')
    return { books: data.books.map(book => this.normalize(book)),
      pages: record(data.pagination) ? natural(data.pagination.total_pages) : undefined }
  }

  async detail(url: string) {
    const route = bookPath(url, this.origin)
    const data = await this.request(route)
    const book = this.normalize(data.book)
    const requested = /^\/eapi\/book\/(\d+)\/([a-f\d]+)$/i.exec(route)
    if (requested && (book.sourceId !== requested[1] || book.sourceHash.toLowerCase() !== requested[2].toLowerCase())) {
      throw new ZLibraryError('Z-Library 返回的书籍与请求不符。')
    }
    return book
  }

  async downloadLink(book: Book) {
    const data = await this.request(`/eapi/book/${book.sourceId}/${book.sourceHash}/file`)
    const file = data.file
    if (!record(file) || [false, 0, '0', 'false'].some(value => value === file.allowDownload) || !text(file.downloadLink)) {
      throw new ZLibraryError('无法获取下载链接，请检查登录状态及下载额度。')
    }
    return text(file.downloadLink)
  }
}
