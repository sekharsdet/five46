import * as readline from 'readline/promises'

export interface PromptSession {
  ask(question: string, options?: { defaultValue?: string; mask?: boolean }): Promise<string>
  close(): void
}

const CTRL_C = '\u0003'
const CTRL_D = '\u0004'
const BACKSPACE = '\u007f'
const ESC = '\u001b'

/** True for an ANSI escape sequence (arrow keys, Home/End, Delete, function
 * keys, ...) -- anything starting with ESC. Found via a real, live bug: a
 * user pressing arrow keys while typing at a prompt got the raw sequence
 * silently appended into the captured input -- the saved provider became
 * an escape-sequence-prefixed string instead of the plain text typed,
 * which then failed to match any known provider id. This prompt is a
 * plain single-line reader, not a full line editor with cursor
 * movement/history -- the correct behavior for any of these sequences is
 * to discard them entirely, not echo or record anything. */
export function isEscapeSequence(char: string): boolean {
  return char.startsWith(ESC)
}

/** Real interactive terminal: reads raw keystrokes so secrets can be masked
 * with `*` instead of echoed in plaintext (a real, avoidable exposure risk —
 * terminal scrollback, screen recordings, shared-screen sessions — for
 * exactly the kind of credential this wizard exists to collect carefully).
 * Each `ask()` call sets up and tears down its own raw-mode listener; unlike
 * the non-TTY path below, there's no shared resource that breaks across
 * repeated calls, so no session-level state is needed here. */
function createRawModeSession(): PromptSession {
  const stdin = process.stdin
  return {
    ask(question, options = {}) {
      return new Promise((resolve, reject) => {
        const suffix = options.defaultValue ? ` (${options.defaultValue})` : ''
        process.stdout.write(`${question}${suffix}: `)
        let input = ''

        const onData = (charBuffer: Buffer) => {
          const char = charBuffer.toString('utf8')
          switch (char) {
            case '\n':
            case '\r':
            case CTRL_D:
              cleanup()
              process.stdout.write('\n')
              resolve(input.trim() || options.defaultValue || '')
              break
            case CTRL_C:
              cleanup()
              process.stdout.write('\n')
              reject(new Error('Cancelled.'))
              break
            case BACKSPACE:
            case '\b':
              if (input.length > 0) {
                input = input.slice(0, -1)
                process.stdout.write('\b \b')
              }
              break
            default:
              if (isEscapeSequence(char)) break
              input += char
              process.stdout.write(options.mask ? '*'.repeat(char.length) : char)
          }
        }

        function cleanup() {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
        }

        stdin.resume()
        stdin.setRawMode(true)
        stdin.on('data', onData)
      })
    },
    close() {
      // Nothing persists between calls in this path — each `ask()` cleans
      // up its own listener when it resolves/rejects.
    },
  }
}

/**
 * Non-TTY stdin (piped input — scripted use, tests, some CI contexts): no
 * raw-mode/masking is possible here (there's no live terminal to intercept
 * keystrokes on), so this just reads whole lines. This does **not** use
 * `readline.Interface.question()` — two real bugs were found by testing this
 * exact command (`echo -e "n\nn" | five46 config`):
 *
 * 1. Creating a fresh `readline.Interface` per prompt: the *second* prompt
 *    silently never resolved (the wizard exited without saving anything, no
 *    error surfaced) — closing the first interface over a piped stream
 *    leaves a second, freshly-created one unable to read further input.
 * 2. Even with **one shared** interface, calling `.question()` a second time
 *    still hung forever: piped input arrives as a single burst, so both
 *    lines can already be parsed into 'line' events before the second
 *    `.question()` call has even run. `.question()` attaches a *one-time*
 *    listener per call — if the second line's event already fired before
 *    that listener existed, it's simply missed (classic EventEmitter
 *    "must already be listening" gap), and the returned promise never
 *    settles. Since nothing else is keeping the process alive once stdin
 *    ends, Node exits anyway, abandoning the pending prompt mid-wizard.
 *
 * The fix: attach ONE persistent 'line' listener for the whole session,
 * immediately on creation (before any prompt is even asked), queuing every
 * line as it arrives. `ask()` then just drains that queue — nothing can be
 * missed regardless of how fast piped input arrives relative to when each
 * prompt happens to be asked.
 */
function createReadlineSession(): PromptSession {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  const bufferedLines: string[] = []
  let ended = false
  const waiters: Array<(line: string | undefined) => void> = []

  rl.on('line', (line: string) => {
    const waiter = waiters.shift()
    if (waiter) waiter(line)
    else bufferedLines.push(line)
  })
  rl.on('close', () => {
    ended = true
    while (waiters.length > 0) waiters.shift()!(undefined)
  })

  function nextLine(): Promise<string | undefined> {
    if (bufferedLines.length > 0) return Promise.resolve(bufferedLines.shift())
    if (ended) return Promise.resolve(undefined)
    return new Promise((resolve) => waiters.push(resolve))
  }

  return {
    async ask(question, options = {}) {
      const suffix = options.defaultValue ? ` (${options.defaultValue})` : ''
      process.stdout.write(`${question}${suffix}: `)
      const line = await nextLine()
      return (line ?? '').trim() || options.defaultValue || ''
    },
    close() {
      rl.close()
    },
  }
}

export function createPromptSession(): PromptSession {
  return process.stdin.isTTY ? createRawModeSession() : createReadlineSession()
}
