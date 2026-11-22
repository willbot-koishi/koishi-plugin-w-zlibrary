import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactionId } from '../src/interaction'

test('encodes NapCat Unicode reaction IDs without changing other platforms', () => {
  assert.equal(reactionId('onebot', '✅'), 'emoji|9989')
  assert.equal(reactionId('onebot', '❌'), 'emoji|10060')
  assert.equal(reactionId('onebot', '⏳'), 'emoji|9203')
  assert.equal(reactionId('onebot', '🔍'), 'emoji|128269')
  assert.equal(reactionId('onebot', '📤'), 'emoji|128228')
  assert.equal(reactionId('discord', '✅'), '✅')
  assert.equal(reactionId('mock', '⏳'), '⏳')
})
