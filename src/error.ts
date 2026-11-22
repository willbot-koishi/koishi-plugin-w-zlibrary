import { HTTP } from 'koishi'

export function createErrorFormatter(cookie: string) {
  const secrets = cookie.split(';').map(part => part.slice(part.indexOf('=') + 1).trim()).filter(Boolean)
  const redact = (value: string) => {
    for (const secret of secrets) {
      value = value.replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]')
    }
    return value
      .replace(/\b(?:cookie|set-cookie|authorization)\s*[:=][^\r\n]*/gi, '[credentials redacted]')
      .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, (value) => {
        try {
          const url = new URL(value)
          // File URLs may carry credentials in the path, not only the query.
          return url.origin + (url.pathname.startsWith('/eapi/') ? url.pathname : '/[redacted]') + (url.search ? '?[redacted]' : '')
        } catch { return '[URL redacted]' }
      })
      .slice(0, 8000)
  }
  return (error: unknown) => {
    const seen = new Set<unknown>()
    const describe = (error: unknown, depth: number): string => {
      if (depth >= 6 || seen.has(error)) return '[cause truncated]'
      seen.add(error)
      if (!(error instanceof Error)) return typeof error === 'string' ? redact(error) : `Thrown ${typeof error}`
      const lines = [redact(error.stack || `${error.name}: ${error.message}`)]
      // Node network codes are strings; OneBot SenderError.code is a numeric
      // retcode. Do not trust a type assertion to normalize runtime values.
      const code = (error as Error & { code?: unknown }).code
      if (typeof code === 'string' || typeof code === 'number') lines.push(`code: ${redact(String(code))}`)
      if (HTTP.Error.is(error) && error.response) {
        const { status, statusText, url, headers } = error.response
        lines.push(`HTTP ${status} ${redact(statusText)}, url: ${redact(url)}, content-type: ${redact(headers.get('content-type') ?? 'unknown')}`)
      }
      if (error.cause !== undefined) lines.push(`Caused by: ${describe(error.cause, depth + 1)}`)
      if (error instanceof AggregateError) {
        for (const cause of error.errors.slice(0, 4)) lines.push(`Aggregate cause: ${describe(cause, depth + 1)}`)
      }
      return lines.join('\n')
    }
    // Do not pass raw errors/config/response bodies to the logger: HTTP and
    // adapter errors can contain account headers and signed download URLs.
    return describe(error, 0)
  }
}
