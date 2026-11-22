import type { HTTP } from 'koishi'
import { ZLibraryError } from './client'

export async function downloadFile(http: HTTP, source: string, extension: string, maxBytes: number, signal: AbortSignal) {
  let url: URL
  try { url = new URL(source) }
  catch { throw new ZLibraryError('下载地址无效。') }
  const visited = new Set<string>()
  for (let hops = 0; ; hops++) {
    signal.throwIfAborted()
    if (url.protocol !== 'https:' || url.username || url.password || url.port || await http.isLocal(url.href)) {
      throw new ZLibraryError('拒绝不安全的下载地址。')
    }
    if (visited.has(url.href)) throw new ZLibraryError('下载地址发生循环跳转。')
    visited.add(url.href)
    const result = await http.get<Blob | { location: string }>(url.href, {
      // File hosts receive no account session. Inspect every redirect before
      // making the next request, instead of forwarding the API request config.
      redirect: 'manual', signal, timeout: 0, validateStatus: () => true,
      responseType: async (response) => {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel()
          const location = response.headers.get('location')
          if (!location || hops >= 5) throw new ZLibraryError('下载链接跳转异常。')
          return { location }
        }
        const type = response.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream'
        if (response.status !== 200 || /(?:text\/html|application\/(?:json|xhtml\+xml))/i.test(type)) {
          await response.body?.cancel()
          throw new ZLibraryError(`下载失败：服务器未返回书籍文件（HTTP ${response.status}）。`)
        }
        if (!response.body) throw new ZLibraryError('下载失败：文件内容为空。')
        if (Number(response.headers.get('content-length')) > maxBytes) {
          await response.body.cancel()
          throw new ZLibraryError('书籍超过 maxFileSize 配置的大小限制。')
        }
        const reader = response.body.getReader()
        const chunks: Buffer<ArrayBuffer>[] = []
        let size = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > maxBytes) throw new ZLibraryError('书籍超过 maxFileSize 配置的大小限制。')
            chunks.push(Buffer.from(value))
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
        const bytes = Buffer.concat(chunks)
        const start = bytes.subarray(0, 1024).toString('utf8').trimStart()
        if (!size || /^(?:<!doctype\s+html|<html|<\?xml[^>]*>\s*<html)/i.test(start)
          || (extension === 'pdf' && !start.includes('%PDF-'))
          || (extension === 'epub' && !bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')))) {
          throw new ZLibraryError('下载失败：内容不是预期的书籍文件。')
        }
        return new Blob([bytes], { type })
      },
    })
    if (result instanceof Blob) return result
    try { url = new URL(result.location, url) }
    catch { throw new ZLibraryError('下载地址无效。') }
  }
}
