import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { bedrockProvider } from './bedrock'

// No live AWS credentials are available in this environment, so this
// verifies the provider's own request-building/response-parsing logic by
// mocking the SDK client's `send` method directly — Bedrock authenticates
// via SigV4 request signing (handled by the SDK, not this code), which
// isn't something `fetch`-mocking (used for the OpenAI/Anthropic providers)
// can intercept the same way. A real round-trip against Bedrock is still
// unverified.
test('bedrockProvider sends a Converse API request and parses the text content block', async () => {
  const originalSend = BedrockRuntimeClient.prototype.send
  let capturedCommand: ConverseCommand | undefined

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  BedrockRuntimeClient.prototype.send = (async function (this: BedrockRuntimeClient, command: any) {
    capturedCommand = command
    return {
      output: { message: { content: [{ text: 'Everything lines up with the AC.' }] } },
    }
  }) as any

  try {
    const result = await bedrockProvider.complete('compare this', 'us-east-1')
    assert.equal(result, 'Everything lines up with the AC.')
    assert.ok(capturedCommand instanceof ConverseCommand)
    assert.equal(capturedCommand!.input.messages?.[0]?.content?.[0]?.text, 'compare this')
  } finally {
    BedrockRuntimeClient.prototype.send = originalSend
  }
})
