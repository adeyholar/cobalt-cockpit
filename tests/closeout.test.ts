// The post-hotfix closeout. (1) An instruction file is created only with the person's say-so, whichever tool creates it.
// (2) With subscriptionOnly on, only a confirmed subscription sign-in is let through: an unconfirmed one is refused on a
// prompt and on a model request, in both configurations, with a way to recover and no credential in the text.

import { describe, expect, test } from 'claude-code/testing'

import { isInsideFolder } from '../hooks/guard-rules'
import { instructionFilesWritten } from '../hooks/hygiene'
import { bash, commandsRun, prompt, start, world } from './world'

type Engine = Parameters<typeof start>[0]

const CONFIGS = [
  ['orchestration on', { orchestration: true }],
  ['observation only', { orchestration: false }],
] as const

const denial = (answer: unknown): string => String((answer as { deny?: string }).deny ?? '')
const written = (w: ReturnType<typeof world>) => w.ran.filter(call => ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(String(call['tool'])))
const slash = ($: Engine, name: string) => $.command.run({ command: name, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
const step = async ($: Engine, model: string) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 3 } as never)
  let at = await stream.next()
  while (at.done !== true) at = await stream.next()

  return at.value as { answer?: string }
}

const CREATORS: [string, Record<string, unknown>][] = [
  ['Edit with an empty old_string', { tool: 'Edit', file_path: '/work/example/CLAUDE.md', old_string: '', new_string: 'hello' }],
  ['MultiEdit with an empty old_string', { tool: 'MultiEdit', file_path: '/work/example/AGENTS.md', edits: [{ old_string: '', new_string: 'hello' }] }],
  ['Write', { tool: 'Write', file_path: '/work/example/CLAUDE.md', content: 'hello' }],
  ['NotebookEdit', { tool: 'NotebookEdit', notebook_path: '/work/example/CLAUDE.md', new_source: 'hello' }],
  ['a lower-case name', { tool: 'Edit', file_path: '/work/example/claude.md', old_string: '', new_string: 'hello' }],
]

for (const [label, options] of CONFIGS) {
  describe(`instruction files are created only with the person's say-so (${label})`, () => {
    for (const [name, input] of CREATORS) {
      test(`${name}: Block refuses it and nothing is written`, { options }, async ($, on) => {
        const w = world(on, { answer: 'Block' })
        await start($)
        expect(denial(await $.tool.call(input as never))).toContain('only created when the user asks')
        expect(w.asked).toHaveLength(1)
        expect(written(w)).toEqual([])
      })

      test(`${name}: Create lets it through`, { options }, async ($, on) => {
        const w = world(on, { answer: 'Create' })
        await start($)
        expect(denial(await $.tool.call(input as never))).toBe('')
        expect(w.asked).toHaveLength(1)
        expect(written(w)).toHaveLength(1)
      })

      test(`${name}: a dismissed question, or nobody to ask, is a refusal`, { options }, async ($, on) => {
        const w = world(on, { answer: null })
        await start($)
        expect(denial(await $.tool.call(input as never))).toContain('only created when the user asks')
        expect(written(w)).toEqual([])
      })
    }

    test('an edit to an instruction file that exists is not asked about', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block', files: { '/work/example/CLAUDE.md': '# notes\n' } })
      await start($)
      expect(denial(await $.tool.call({ tool: 'Edit', file_path: '/work/example/CLAUDE.md', old_string: '# notes', new_string: '# project notes' } as never))).toBe('')
      expect(denial(await $.tool.call({ tool: 'MultiEdit', file_path: '/work/example/CLAUDE.md', edits: [{ old_string: 'notes', new_string: 'rules' }] } as never))).toBe('')
      expect(w.asked).toEqual([])
      expect(written(w)).toHaveLength(2)
    })

    test('ordinary files are not asked about', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block' })
      await start($)
      expect(denial(await $.tool.call({ tool: 'Edit', file_path: '/work/example/src/a.ts', old_string: '', new_string: 'x' } as never))).toBe('')
      expect(denial(await $.tool.call({ tool: 'Edit', file_path: '/work/example/docs/CLAUDE.md.txt', old_string: '', new_string: 'x' } as never))).toBe('')
      expect(w.asked).toEqual([])
    })

    test('/init is the person asking: the file is created without a question', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block' })
      await start($)
      // /init marks the task in progress; with no task yet it marks nothing, and the file is asked about (the cautious side)
      await prompt($, 'Add rate limiting to the bids API')
      await slash($, 'init')
      expect(denial(await $.tool.call({ tool: 'Edit', file_path: '/work/example/CLAUDE.md', old_string: '', new_string: 'hello' } as never))).toBe('')
      expect(w.asked).toEqual([])
    })

    test('a prompt that names the file is the person asking', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block' })
      await start($)
      await prompt($, 'Please write a CLAUDE.md for this project')
      expect(denial(await $.tool.call({ tool: 'Edit', file_path: '/work/example/CLAUDE.md', old_string: '', new_string: 'hello' } as never))).toBe('')
      expect(w.asked).toEqual([])
    })

    test('only a human gesture asks for the file: other origins that name it, or run /init, do not', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block' })
      await start($)
      const create = { tool: 'Edit', file_path: '/work/example/CLAUDE.md', old_string: '', new_string: 'hello' }
      const submit = (kind: string, text: string) => $.prompt.submit({ text, wait: false, origin: { kind } } as never)
      const init = (kind: string) => $.command.run({ command: 'init', args: '', origin: { kind }, presentation: { isFullscreen: true, columns: 120 } } as never)
      // a first human prompt starts the task, so that a later origin has a task to mark
      await submit('composer', 'Add rate limiting to the bids API')
      for (const kind of ['sdk', 'plugin', 'peer', 'task-notification', 'scheduled-trigger', 'channel', 'future']) {
        await submit(kind, 'Please write a CLAUDE.md for this project')
        await init(kind)
        expect([kind, denial(await $.tool.call(create as never)).includes('only created when the user asks')]).toEqual([kind, true])
      }
      expect(written(w)).toEqual([])
    })

    test('the terminal Enter and the bridge naming the file, or /init from them, authorize it', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block' })
      await start($)
      await $.prompt.submit({ text: 'Add rate limiting to the bids API', wait: false, origin: { kind: 'composer' } } as never)
      await $.prompt.submit({ text: 'and create the CLAUDE.md', wait: false, origin: { kind: 'bridge' } } as never)
      expect(denial(await $.tool.call({ tool: 'Edit', file_path: '/work/example/CLAUDE.md', old_string: '', new_string: 'hello' } as never))).toBe('')
      expect(w.asked).toEqual([])
    })

    test('/init from the bridge authorizes it', { options }, async ($, on) => {
      world(on, { answer: 'Block' })
      await start($)
      await $.prompt.submit({ text: 'Add rate limiting to the bids API', wait: false, origin: { kind: 'composer' } } as never)
      await $.command.run({ command: 'init', args: '', origin: { kind: 'bridge' }, presentation: { isFullscreen: true, columns: 120 } } as never)
      expect(denial(await $.tool.call({ tool: 'Edit', file_path: '/work/example/CLAUDE.md', old_string: '', new_string: 'hello' } as never))).toBe('')
    })

    test('a filesystem that cannot answer refuses the edit', { options }, async ($, on) => {
      const w = world(on, { answer: 'Create', failExists: true })
      await start($)
      for (const [, input] of CREATORS) expect(denial(await $.tool.call(input as never))).toContain('the instruction-file guard failed')
      expect(written(w)).toEqual([])
    })

    test('a command that changes directory first is asked about even when the root file exists', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block', files: { '/work/example/CLAUDE.md': '# root\n' } })
      await start($)
      expect(denial(await bash($, 'echo x >> CLAUDE.md'))).toBe('')
      expect(denial(await bash($, 'cd sub && echo x > CLAUDE.md'))).toContain('only created when the user asks')
      for (const command of ['bash -c "cd sub && echo x > CLAUDE.md"', "echo 'cd sub; touch CLAUDE.md' | sh", 'cd; touch CLAUDE.md', 'env --chdir=sub tee CLAUDE.md']) {
        expect([command, denial(await bash($, command)).includes('only created when the user asks')]).toEqual([command, true])
      }
      expect(commandsRun(w)).toEqual(['echo x >> CLAUDE.md'])
    })

    test('Bash forms that create an instruction file are asked about', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block' })
      await start($)
      for (const command of ['echo x > CLAUDE.md', 'install a.md CLAUDE.md', 'ln -s a.md AGENTS.md', 'dd if=a of=CLAUDE.md', 'truncate -s 0 CLAUDE.md', 'sh -c "echo x > CLAUDE.md"']) {
        expect([command, denial(await bash($, command)).includes('only created when the user asks')]).toEqual([command, true])
      }
      expect(commandsRun(w)).toEqual([])
    })
  })
}

describe('the shell forms that name an instruction file', () => {
  const CASES: [string, string[]][] = [
    ['echo x > CLAUDE.md', ['CLAUDE.md']],
    ['cat <<EOF > AGENTS.md\nhi\nEOF', ['AGENTS.md']],
    ['printf x | tee CLAUDE.md', ['CLAUDE.md']],
    ['cp a.md CLAUDE.md', ['CLAUDE.md']],
    ['install -m 644 a.md CLAUDE.md', ['CLAUDE.md']],
    ['ln -s a.md CLAUDE.md', ['CLAUDE.md']],
    ["echo 'echo x > CLAUDE.md' | sh", ['CLAUDE.md']],
    ['rsync -a src/ dst/ --exclude CLAUDE.md', []],
    ['dd if=a of=CLAUDE.md', ['CLAUDE.md']],
    ['truncate -s 0 CLAUDE.md', ['CLAUDE.md']],
    ['bash -c "echo x > CLAUDE.md"', ['CLAUDE.md']],
    ['sh -lc "touch AGENTS.md"', ['AGENTS.md']],
    ['bash -c "sh -c \\"echo x > CLAUDE.md\\""', ['CLAUDE.md']],
    ['eval "echo x > CLAUDE.md"', ['CLAUDE.md']],
    ["cat <<'EOF' | sh\necho x > CLAUDE.md\nEOF", ['CLAUDE.md']],
    ['cat build.sh | sh', []],
    ['ls CLAUDE.md', []],
    ['cat CLAUDE.md', []],
    ['cp CLAUDE.md backup.md', []],
    ['ln -s CLAUDE.md link', []],
    ['dd if=CLAUDE.md of=copy', []],
    ['bash -c "cat CLAUDE.md"', []],
  ]
  for (const [command, expected] of CASES) test(JSON.stringify(command), () => expect(instructionFilesWritten(command)).toEqual(expected))
})

// built at run time from parts, as the other fixtures are, and shaped like no credential
const SECRET = ['tok', 'a1b2c3d4e5f60718'].join('')

for (const [label, options] of CONFIGS) {
  describe(`subscriptionOnly never reads an unknown sign-in as a subscription (${label})`, () => {
    const on_ = { ...options, subscriptionOnly: true }
    for (const [why, over] of [
      ['the engine reports no credential', { credential: null }],
      ['the engine does not answer', { failAuthorize: true }],
    ] as const) {
      test(`${why}: the prompt and the model request are refused, with a way to recover`, { options: on_ }, async ($, on) => {
        const w = world(on, over)
        await start($)
        const dropped = (await prompt($, 'Add rate limiting')).drop
        expect(dropped).toContain('AUTH / UNVERIFIED')
        expect(dropped).toContain('/login')
        expect(dropped).toContain('"subscriptionOnly"')
        expect(w.submitted).toEqual([])
        expect((await step($, 'claude-sonnet-5-5')).answer).toBe('AUTH / UNVERIFIED')
        expect(w.requests).toEqual([])
      })
    }

    test('a refusal carries no credential, even when one is configured', { options: on_ }, async ($, on) => {
      const w = world(on, { credential: null, env: { ANTHROPIC_API_KEY: SECRET } })
      await start($)
      const dropped = (await prompt($, 'Add rate limiting')).drop
      expect(dropped).toContain('AUTH / API DETECTED')
      expect(String(dropped)).not.toContain(SECRET)
      expect(w.requests).toEqual([])
    })

    test('signing in is the recovery: the next prompt and request go through', { options: on_ }, async ($, on) => {
      const w = world(on, { credential: null })
      await start($)
      expect((await prompt($, 'Add rate limiting')).drop).toContain('AUTH / UNVERIFIED')
      w.credential = { handle: 'h', kind: 'bearer' }
      await slash($, 'login')
      expect((await prompt($, 'Add rate limiting')).drop).toBeUndefined()
      expect((await step($, 'claude-sonnet-5-5')).answer).not.toBe('AUTH / UNVERIFIED')
    })

    test('a sign-in made outside the plugin\'s commands is seen before anything is refused', { options: on_ }, async ($, on) => {
      const w = world(on, { credential: null })
      await start($)
      w.credential = { handle: 'h', kind: 'bearer' }
      expect((await prompt($, 'Add rate limiting')).drop).toBeUndefined()
    })

    test('subscriptionOnly off: an unconfirmed sign-in is not refused', { options }, async ($, on) => {
      world(on, { credential: null })
      await start($)
      expect((await prompt($, 'Add rate limiting')).drop).toBeUndefined()
    })
  })
}

describe('a path is inside the plugin folder only when it says so plainly', () => {
  test('climbing out with .. or wandering with . is not inside', () => {
    expect(isInsideFolder('/p/root', '/p/root/hooks/a.ts')).toBe(true)
    expect(isInsideFolder('/p/root', '/p/root/../elsewhere/CLAUDE.md')).toBe(false)
    expect(isInsideFolder('/p/root', '/p/root/a/../../x/CLAUDE.md')).toBe(false)
    expect(isInsideFolder('/p/root', '/p/root/./CLAUDE.md')).toBe(false)
    expect(isInsideFolder('/p/root', '/p/rootsibling/CLAUDE.md')).toBe(false)
    expect(isInsideFolder('/p/root', 'CLAUDE.md')).toBe(false)
  })
})
