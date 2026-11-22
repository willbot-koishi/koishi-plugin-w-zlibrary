import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HTTP } from 'koishi'
import { createErrorFormatter } from '../src/error'

test('preserves stacks, network codes and nested aggregate causes', () => {
  const error = new Error('fetch failed', { cause: new AggregateError([
    Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
  ]) })
  const output = createErrorFormatter('')(error)
  assert.match(output, /Error: fetch failed\n\s+at /)
  assert.match(output, /Caused by: AggregateError/)
  assert.match(output, /Aggregate cause: Error: connect timed out/)
  assert.match(output, /code: ETIMEDOUT/)
  assert.match(output, /code: ECONNREFUSED/)
})

test('accepts numeric OneBot retcodes and ignores non-scalar error codes', () => {
  const format = createErrorFormatter('remix_userkey=test-session-key')
  for (const code of [1200, -1, 0]) {
    const error = Object.assign(new Error('OneBot request failed'), { code })
    const output = format(error)
    assert.match(output, /Error: OneBot request failed\n\s+at /)
    assert.ok(output.includes(`code: ${code}`))
  }
  const error = Object.assign(new Error('invalid code'), { code: { secret: 'private-code' } })
  const output = format(error)
  assert.match(output, /Error: invalid code/)
  assert.doesNotMatch(output, /code:|private-code/)
})

test('logs HTTP status and API endpoint without headers or response bodies', () => {
  const error = new HTTP.Error('Forbidden')
  error.response = {
    status: 403, statusText: 'Forbidden', url: 'https://example.invalid/eapi/book/search',
    headers: new Headers({ 'content-type': 'application/json', 'set-cookie': 'private-header' }),
    data: { error: 'private-response-body' },
  }
  const output = createErrorFormatter('')(error)
  assert.match(output, /HTTP 403 Forbidden/)
  assert.match(output, /https:\/\/example.invalid\/eapi\/book\/search/)
  assert.match(output, /content-type: application\/json/)
  assert.doesNotMatch(output, /private-header|private-response-body/)
})

test('redacts account values, credential headers and signed URL paths in every cause', () => {
  const cookie = 'remix_userid=123456; remix_userkey=session+secret; cf_clearance=browser-secret'
  const error = new Error('download https://user:password@files.invalid/signed-path-secret/file.pdf?ticket=query-secret#fragment-secret', {
    cause: new Error(`key=session+secret encoded=session%2Bsecret id=123456\nCookie: ${cookie}\nAuthorization: Bearer bearer-secret`),
  })
  const output = createErrorFormatter(cookie)(error)
  assert.match(output, /https:\/\/files.invalid\/\[redacted\]\?\[redacted\]/)
  assert.match(output, /Caused by: Error:/)
  assert.doesNotMatch(output, /password|signed-path-secret|query-secret|fragment-secret|session\+secret|session%2Bsecret|123456|browser-secret|bearer-secret/)
})

test('bounds cyclic and excessively long errors and does not inspect arbitrary thrown objects', () => {
  const error = new Error('cycle')
  error.cause = error
  const format = createErrorFormatter('')
  assert.match(format(error), /cause truncated/)
  assert.ok(format(new Error('x'.repeat(20_000))).length <= 8000)
  assert.equal(format({ cookie: 'private-value' }), 'Thrown object')
  assert.equal(format(null), 'Thrown object')
  assert.equal(format('plain failure'), 'plain failure')
})
