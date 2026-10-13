import { describe, expect, test } from 'claude-code/testing'
import { shown } from '../hooks/doctor'
import { blockerOf, shortenPaths as viaInspector, taskText } from '../hooks/inspector'
import { personalRest, shortenPaths, shortResource, withoutHomeName } from '../hooks/paths'
import { emptySwarm, finishTask, submitTask, admitTask, bindAgent } from '../hooks/swarm'
import { command, start, world } from './world'

// A home directory names a person. These are the layouts recognised, what is left alone on purpose, and what is not
// recognised: the last group is the documented limit, pinned so that it cannot widen or narrow without a test saying so.

const NAME = 'alice'
const each = (cases: readonly (readonly [string, string])[]) => { for (const [input, want] of cases) expect([input, shortenPaths(input)]).toEqual([input, want]) }

describe('a user\'s name in a home path is never shown', () => {
  test('Linux: /home/<name>', () => each([
    ['/home/alice', '…/'],
    ['/home/alice/', '…/'],
    ['/home/alice/proj', '…/proj'],
    ['/home/alice/proj/hooks/a.ts', '…/hooks/a.ts'],
    ['/home/alice/.ssh/id_ed25519', '…/.ssh/id_ed25519'],
    ['fix /home/alice/Projects/secret-client/hooks/alerts.ts now', 'fix …/hooks/alerts.ts now'],
  ]))
  test('Fedora Atomic and other immutable desktops: /var/home/<name>', () => each([
    ['/var/home/alice', '…/'],
    ['/var/home/alice/', '…/'],
    ['/var/home/alice/x.ts', '…/x.ts'],
    ['/var/home/alice/proj', '…/proj'],
    ['/var/home/alice/Projects/cobalt/hooks/a.ts', '…/hooks/a.ts'],
    ['see /var/home/alice/Projects/cobalt/hooks/a.ts:12 please', 'see …/hooks/a.ts:12 please'],
  ]))
  test('macOS: /Users/<name>, another volume and the data volume', () => each([
    ['/Users/alice', '…/'],
    ['/Users/alice/Documents/a/b.txt', '…/a/b.txt'],
    ['/Volumes/Ext/Users/alice/a/b', '…/a/b'],
    ['/System/Volumes/Data/Users/alice/a', '…/a'],
    ['/System/Volumes/Data/home/alice/a/b/c', '…/b/c'],
  ]))
  test('other systems: FreeBSD, NFS exports, WSL, Git Bash, Cygwin, per-user media', () => each([
    ['/usr/home/alice/a', '…/a'],
    ['/export/home/alice/a/b/c', '…/b/c'],
    ['/mnt/c/Users/alice/proj/a.ts', '…/proj/a.ts'],
    ['/c/Users/alice/proj/a.ts', '…/proj/a.ts'],
    ['/cygdrive/d/Users/alice/a', '…/a'],
    ['/media/alice/USB/x', '…/USB/x'],
    ['/run/media/alice/USB/x/y', '…/x/y'],
  ]))
  test('home-relative paths: ~ has no name in it, ~name is another person\'s home', () => each([
    ['~/x', '~/x'],
    ['~/a/b', '~/a/b'],
    ['~/work/x/y/z.ts', '…/y/z.ts'],
    ['~alice/x/y', '…/x/y'],
    ['~alice/x', '…/x'],
    ['~alice/', '…/'],
  ]))
  test('unusual formatting: drive letters, file URLs, host:path, quotes, brackets, assignments', () => each([
    ['C:\\Users\\alice\\proj\\a.ts', '…/proj/a.ts'],
    ['C:/Users/alice/proj/a.ts', '…/proj/a.ts'],
    ['C:\\Users\\alice', '…/'],
    ['D:\\work\\x\\y\\z.ts', '…/y/z.ts'],
    ['file:///home/alice/x/y.ts', 'file://…/x/y.ts'],
    ['file://localhost/var/home/alice/x', 'file://…/x'],
    ['file:///C:/Users/alice/x', 'file://…/x'],
    ['file:///C:/Users/alice', 'file://…/'],
    ['file:///c:/users/alice/a/b/c', 'file://…/b/c'],
    // a backslash doubled, as JSON and many logs write it
    ['"C:\\\\Users\\\\alice\\\\proj\\\\a.ts"', '"…/proj/a.ts"'],
    // Windows keeps no case: users is Users
    ['c:\\users\\alice\\x\\y', '…/x/y'],
    ['/mnt/c/users/alice/x', '…/x'],
    ['/users/alice/x', '…/x'],
    ['user@host:/home/alice/repo.git', 'user@host:…/repo.git'],
    ['(/home/alice/x)', '(…/x)'],
    ["cwd='/var/home/alice/p'", "cwd='…/p'"],
    ['`/var/home/alice/p/q`', '`…/p/q`'],
    ['x=/var/home/alice/p/q', 'x=…/p/q'],
    ['path:/var/home/alice/p', 'path:…/p'],
    ['"/home/alice/My Project/a.ts"', '"…/My Project/a.ts"'],
    ['/home/alice/a /var/home/alice/b /Users/alice/c', '…/a …/b …/c'],
  ]))
  test('no recognised form leaves the name in the text', () => {
    for (const prefix of ['/home', '/var/home', '/Users', '/users', '/usr/home', '/export/home', '/mnt/c/Users', '/mnt/c/users', '/c/Users', '/cygdrive/c/Users', '/Volumes/X/Users', '/System/Volumes/Data/Users', '/media', '/run/media', 'C:\\Users', 'c:\\users', 'C:/Users', 'C:\\\\Users', 'file:///var/home', 'file:///C:/Users', 'host:/var/home']) {
      for (const tail of ['', '/', '/a', '/a/b', '/a/b/c.ts', '/.config/x/y/z']) {
        const slash = prefix.includes('\\\\') ? '\\\\' : prefix.includes('\\') ? '\\' : '/'
        const input = `${prefix}${slash}${NAME}${tail.replace(/\//g, slash)}`
        expect([input, shortenPaths(`open ${input} now`).includes(NAME)]).toEqual([input, false])
      }
    }
    for (const tail of ['/', '/a', '/a/b', '/a/b/c.ts']) expect(shortenPaths(`~${NAME}${tail}`)).not.toContain(NAME)
  })
})

describe('what is not a home path is not damaged', () => {
  test('web URLs keep their path, whatever it looks like', () => each([
    ['https://example.org/a/b/c', 'https://example.org/a/b/c'],
    ['https://example.org/home/alice/x', 'https://example.org/home/alice/x'],
    ['http://localhost:3000/home/alice/x', 'http://localhost:3000/home/alice/x'],
    ['git clone ssh://git@example.org/home/alice/r.git', 'git clone ssh://git@example.org/home/alice/r.git'],
    ['see https://github.com/echelong/cobalt-cockpit/blob/main/hooks/swarm.ts#L10', 'see https://github.com/echelong/cobalt-cockpit/blob/main/hooks/swarm.ts#L10'],
    ['http://[::1]/a/b/c', 'http://[::1]/a/b/c'],
    ['http://[::1]:8080/home/alice/x', 'http://[::1]:8080/home/alice/x'],
  ]))
  test('relative paths are left as they are', () => each([
    ['hooks/alerts.ts', 'hooks/alerts.ts'],
    ['docs/home/index.md', 'docs/home/index.md'],
    ['src/Users/List.tsx', 'src/Users/List.tsx'],
    ['../x/y', '../x/y'],
    ['a/b', 'a/b'],
  ]))
  test('a directory that is merely called home or Users is ordinary path context', () => each([
    ['/srv/www/home/index.html', '…/home/index.html'],
    ['/app/src/Users/List.tsx', '…/Users/List.tsx'],
    ['/work/site/pages/home/hero.tsx', '…/home/hero.tsx'],
    ['/home', '/home'],
    ['/home/', '/home/'],
    ['/Users', '/Users'],
    ['/var/home', '/var/home'],
  ]))
  test('other absolute paths are shortened to two segments and short ones stay whole', () => each([
    ['/tmp', '/tmp'],
    ['/tmp/x', '/tmp/x'],
    ['/etc/ssh/sshd_config', '…/ssh/sshd_config'],
    ['/root/x/y/z', '…/y/z'],
    ['./src/a/b.ts', '…/a/b.ts'],
    ['file:///etc/hosts', 'file:///etc/hosts'],
  ]))
  test('ordinary text with slashes, dates, ratios and tildes is untouched', () => each([
    ['ratio 3/4 and and/or', 'ratio 3/4 and and/or'],
    ['on 5/10/2026 at 12:30', 'on 5/10/2026 at 12:30'],
    ['takes ~five minutes', 'takes ~five minutes'],
    ['either/or, and/or, n/a, w/o', 'either/or, and/or, n/a, w/o'],
    ['a => b, a <- b, 50% / 2', 'a => b, a <- b, 50% / 2'],
    ['TEST pass · 2217/2217 · 61s', 'TEST pass · 2217/2217 · 61s'],
    ['', ''],
  ]))
  test('shortening again changes nothing more', () => {
    for (const input of ['/var/home/alice/Projects/cobalt/hooks/a.ts', 'fix /home/alice/x and ~/a/b/c', 'C:\\Users\\alice\\proj\\a.ts', 'file:///home/alice/x/y.ts', '/etc/ssh/sshd_config', '/home/alice/media/bob', '/work/x/home/bob/y', '/a/b/Users/carol', '/x/y/z/media/dave/e']) {
      const once = shortenPaths(input)
      expect([input, shortenPaths(once)]).toEqual([input, once])
    }
  })
})

describe('the documented limits: forms that are not recognised', () => {
  test('these still show the name, and the documentation says so', () => each([
    // a layout outside the list is shortened like any path: its last two segments
    ['/data/home/alice/x.ts', '…/alice/x.ts'],
    ['/srv/nfs/home/alice', '…/home/alice'],
    // a bare ~name with no slash is indistinguishable from ordinary text
    ['~alice', '~alice'],
    // UNC shares
    ['//server/share/Users/alice/x', '//server/share/Users/alice/x'],
    ['\\\\server\\share\\Users\\alice', '\\\\server\\share\\Users\\alice'],
    // a user name with a space or a quote character in it: the path is taken to end there, so the rest of the name stays
    ['/Users/alice smith/Documents/x', '…/ smith/Documents/x'],
    ["/home/o'brien/x", "…/'brien/x"],
    // text of the form ~word/… is read as another person's home, which loses the word
    ['about ~five/six days', 'about …/six days'],
  ]))
})

describe('claims, diagnostics and the Inspector use the same rule', () => {
  test('a resource claim never shows the name, however short the claim', () => {
    for (const [claim, want] of [
      ['*', 'the whole repository'], ['/hooks', '/hooks'], ['/work/example/hooks/a.ts', '…/hooks/a.ts'],
      ['/home/alice', '…/'], ['/home/alice/proj', '…/proj'], ['/var/home/alice', '…/'], ['/var/home/alice/proj', '…/proj'], ['/var/home/alice/proj/hooks/a.ts', '…/hooks/a.ts'], ['/Users/alice', '…/'], ['/media/alice/usb', '…/usb'],
    ] as const) expect([claim, shortResource(claim)]).toEqual([claim, want])
  })
  test('a diagnostic keeps the whole path but for the name', () => {
    expect(withoutHomeName('/var/home/alice/.claude/plugins/cache/cobalt-cockpit/0.6.1')).toBe('/var/home/…/.claude/plugins/cache/cobalt-cockpit/0.6.1')
    expect(withoutHomeName('/home/alice/.claude')).toBe('/home/…/.claude')
    expect(withoutHomeName('/Users/alice')).toBe('/Users/…')
    expect(withoutHomeName('/mnt/c/Users/alice/x')).toBe('/mnt/c/Users/…/x')
    expect(withoutHomeName('/opt/claude/plugins')).toBe('/opt/claude/plugins')
    expect(withoutHomeName('relative/home/alice/x')).toBe('relative/home/alice/x')
    // a drive-letter path keeps its own slashes
    expect(withoutHomeName('C:\\Users\\alice\\.claude\\plugins')).toBe('C:\\Users\\…\\.claude\\plugins')
    expect(withoutHomeName('C:/Users/alice/.claude')).toBe('C:/Users/…/.claude')
    expect(withoutHomeName('c:\\users\\alice')).toBe('c:\\users\\…')
    expect(withoutHomeName('D:\\work\\x')).toBe('D:\\work\\x')
    // the session's own home is shown as ~; another home, or an unknown one, loses only its name
    expect(shown('/var/home/alice/.claude/plugins', '/var/home/alice')).toBe('~/.claude/plugins')
    expect(shown('/var/home/alice/.claude/plugins', null)).toBe('/var/home/…/.claude/plugins')
    expect(shown('/var/home/bob/.claude/plugins', '/var/home/alice')).toBe('/var/home/…/.claude/plugins')
    expect(shown('/home/alice/x', '/var/home/alice')).toBe('/home/…/x')
    expect(shown('/opt/x', '/var/home/alice')).toBe('/opt/x')
  })
  test('personalRest answers only for a recognised layout with a name in it', () => {
    expect(personalRest(['var', 'home', 'alice', 'x'])).toEqual(['x'])
    expect(personalRest(['home', 'alice'])).toEqual([])
    expect(personalRest(['home'])).toBeNull()
    expect(personalRest(['var', 'home'])).toBeNull()
    expect(personalRest(['srv', 'home', 'alice'])).toBeNull()
    expect(personalRest(['cc', 'Users', 'alice'])).toBeNull()   // a drive is one letter
  })
  test('the Inspector\'s objective, escalation question and failure reason carry no name from a /var/home path', () => {
    expect(viaInspector).toBe(shortenPaths)
    let s = emptySwarm()
    s = submitTask(s, { id: 'P', tier: 'SONNET', role: 'worker', objective: 'fix /var/home/alice/Projects/secret-client/hooks/alerts.ts and /var/home/alice/notes', owned: ['/var/home/alice/Projects/secret-client/hooks/alerts.ts', '/var/home/alice'], mode: 'write' }, 1).swarm
    s = bindAgent(admitTask(s, 'P', 2).swarm, 'P', 'agent-p', 3)
    const failed = finishTask(s, 'P', 'failed', { conclusion: 'could not write /var/home/alice/Projects/secret-client/out.log' }, 4)
    const text = taskText({ swarm: failed, agents: [], now: 10, columns: 200 }, 'P')
    expect(text).not.toContain(NAME)
    expect(text).toContain('objective: fix …/hooks/alerts.ts and …/notes')
    expect(text).toContain('owns: write …/, …/hooks/alerts.ts')
    expect(blockerOf(failed, failed.tasks[0]!, 10)?.why).toBe('The task failed: could not write …/secret-client/out.log.')
  })
})

describe('/cockpit version', () => {
  test('SOURCE shows where the plugin is loaded from without a user\'s name', async ($, on) => {
    const w = world(on); w.env['HOME'] = '/var/home/alice'
    await start($)
    const text = (await command($, 'version')).text ?? ''
    const source = text.split('\n').find(line => line.startsWith('SOURCE / ')) ?? ''
    // the plugin's root goes through the same `shown` the doctor uses (pinned above): under a home directory the name is `…`
    expect(source).toMatch(/^SOURCE \/ (?:~|\/(?:home|Users|var\/home)\/…(?:\/|$)|\/(?!home\/|Users\/|var\/home\/))/)
    expect(text).not.toContain(NAME)
  })
})
