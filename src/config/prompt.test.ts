import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEscapeSequence } from './prompt'

const ESC = String.fromCharCode(27)

test('isEscapeSequence recognizes a real ANSI escape sequence (arrow keys, etc.)', () => {
  // Regression test for a real, live bug: a user pressing arrow keys while
  // typing at the "LLM provider" prompt got the raw sequence silently
  // appended into the saved config value (observed: the saved provider
  // became an escape-sequence-prefixed string instead of the plain
  // "gemini" that was typed, which then failed to match any known
  // provider id in the registry).
  assert.equal(isEscapeSequence(ESC + '[A'), true, 'up arrow')
  assert.equal(isEscapeSequence(ESC + '[B'), true, 'down arrow')
  assert.equal(isEscapeSequence(ESC + '[C'), true, 'right arrow')
  assert.equal(isEscapeSequence(ESC + '[D'), true, 'left arrow')
  assert.equal(isEscapeSequence(ESC), true, 'a lone ESC byte')
})

test('isEscapeSequence does not flag ordinary typed characters', () => {
  assert.equal(isEscapeSequence('g'), false)
  assert.equal(isEscapeSequence('gemini'), false)
  assert.equal(isEscapeSequence(''), false)
})
