import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyCache, type Cache } from '@/lib/cache'
import { GitHubError, type Answer, type GitHub, type Probe, type QueryError } from '@/lib/github'
import {
  NODES,
  ORG_REPOS,
  PR_STATUS,
  repoItems,
  REVIEW_REQUESTED,
  SEARCH,
  type RawItem,
  type RawRepo,
} from '@/lib/queries'
import { repoRows } from '@/lib/repos'
import { sourcesKey } from '@/lib/sources'
import { idleStatus, Syncer, type SyncStore } from '@/lib/sync'
import { noOne, type Item, type Repo, type Workspace } from '@/types'

// What IndexedDB would keep for the workspace between syncers. jsdom has no IndexedDB, so by default nothing.
const saved = vi.hoisted(() => ({ cache: null as Cache | null }))
vi.mock('@/lib/cache', async (original) => ({
  ...(await original<typeof import('@/lib/cache')>()),
  readCache: async () => saved.cache,
}))

const MINUTE = 60_000
const HOUR = 3_600_000
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()

function raw(id: string, state: RawItem['state'], updatedAt: string, pr = false): RawItem {
  return {
    kind: pr ? 'PullRequest' : 'Issue',
    id,
    number: Number(id.slice(1)),
    title: id,
    url: '',
    state,
    ...(pr ? { isDraft: false, reviewDecision: null } : {}),
    createdAt: ago(24 * 30),
    updatedAt,
    author: null,
    assignees: { nodes: [] },
    labels: { nodes: [] },
    comments: { totalCount: 0 },
    repository: { id: 'R1' },
  }
}

const page = <T>(nodes: T[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes })
const count = (nodes: RawItem[], state: RawItem['state']) => nodes.filter((node) => node.state === state).length

const size = (kind: 'issues' | 'pullRequests', open: boolean) => repoItems(kind, open).size

const done = (data: unknown) => ({ data, errors: [] as QueryError[] })
const second = (time: string) => Math.floor(Date.parse(time) / 1000)
// A time as a search names its second.
const secondOf = (time: string) => time.replace(/\.\d+Z$/, 'Z')
// Searches as GitHub reads them: each one's terms in any order, and the searches in any order.
const searches = (queries: string[]) => queries.map((q) => q.split(' ').toSorted().join(' ')).toSorted()
// Whether a search has each of these terms.
const has = (q: string, ...terms: string[]) => terms.every((term) => q.split(' ').includes(term))
const byRepo = (q: string) => /(^| )repo:/.test(q)
const byPart = (q: string) => /(^| )is:(open|closed)( |$)/.test(q)
const labels = (many: number) => ({ nodes: Array.from({ length: many }, (_, n) => ({ name: `l${n}`, color: '' })) })

// A look for changes: the issues and the pull requests are searched apart.
const LOOK = ['search', 'search']

/** A GitHub whose answers to queries are `query`'s, with nothing changed since the last look and nothing else to read. */
const answering = (query: GitHub['query']): GitHub => ({
  scopes: () => ['repo'],
  rate: () => null,
  rest: () => Promise.reject(new Error('unused')),
  probe: async () => 'same',
  async request<T>(text: string, variables?: Record<string, unknown>) {
    return { data: await query<T>(text, variables), errors: [] }
  },
  query,
})

// A GitHub with one repository: one open and one closed issue, one open and one merged pull request.
function fakeGitHub() {
  const issues = [raw('I1', 'OPEN', ago(24)), raw('I3', 'CLOSED', ago(240))]
  const prs = [raw('P2', 'OPEN', ago(24), true), raw('P4', 'MERGED', ago(240), true)]
  const state = {
    issues,
    prs,
    searchResults: [] as RawItem[],
    // The times each search looked over: since the last look, or a part of that time. And each search's whole query.
    searched: [] as string[],
    queries: [] as string[],
    checks: {} as Record<string, string>,
    mergeable: {} as Record<string, RawItem['mergeable']>,
    requested: [] as string[],
    // What GitHub says of each item asked for again that it doesn't return.
    missing: {} as Record<string, string>,
    // What GitHub won't show: a repository's lists of one kind or both, and pull requests asked for by id.
    hidden: [] as string[],
    archived: false,
    hiddenStatus: [] as string[],
    // More repositories in the organization, by name, each with the same items as the first, and the repositories
    // whose items were asked for.
    more: [] as string[],
    itemsOf: [] as string[],
    // The lists asked for, as `kind states`, like `issues CLOSED`.
    lists: [] as string[],
    probes: {} as Record<string, Probe>,
    probed: [] as string[],
    seen: new Set<string>(),
    firsts: [] as number[],
    serverErrors: 0,
    rateLimited: false,
    calls: [] as string[],
    pageSize: Infinity,
    searchPage: Infinity,
    onQuery: () => {},
  }

  const rollup = (id: string) => ({ commit: { statusCheckRollup: { state: state.checks[id] ?? 'SUCCESS' } } })
  const status = (id: string) => ({ mergeable: state.mergeable[id] ?? 'MERGEABLE', commits: { nodes: [rollup(id)] } })

  const gh: GitHub = {
    ...answering(async (text, variables) => (await answer(text, variables ?? {})).data as never),
    async probe(path: string) {
      state.calls.push('probe')
      state.probed.push(path)
      // Like GitHub, the first answer has nothing to compare with.
      const first = !state.seen.has(path)
      state.seen.add(path)
      return state.probes[path] ?? (first ? 'new' : 'same')
    },
    async request<T>(text: string, variables: Record<string, unknown> = {}): Promise<Answer<T>> {
      const { data, errors } = await answer(text, variables)
      return { data: data as T, errors }
    },
  }

  async function answer(
    text: string,
    variables: Record<string, unknown>,
  ): Promise<{ data: unknown; errors: QueryError[] }> {
    const call =
      {
        [ORG_REPOS]: 'repos',
        [SEARCH]: 'search',
        [NODES]: 'nodes',
        [PR_STATUS]: 'checks',
        [REVIEW_REQUESTED]: 'requested',
      }[text] ?? 'items'
    state.calls.push(call)
    state.onQuery()
    if (state.rateLimited) throw new GitHubError('Rate limited', 'rate', Date.now() + 60_000)
    if (call === 'repos') {
      const repo: RawRepo = {
        id: 'R1',
        name: 'web',
        nameWithOwner: 'acme/web',
        description: null,
        isPrivate: false,
        isArchived: state.archived,
        pushedAt: null,
        owner: { login: 'acme', avatarUrl: '' },
        primaryLanguage: null,
        openIssues: { totalCount: count(state.issues, 'OPEN') },
        openPrs: { totalCount: count(state.prs, 'OPEN') },
        allIssues: { totalCount: state.issues.length },
        allPrs: { totalCount: state.prs.length },
      }
      const more = state.more.map((name) => ({ ...repo, id: name, name, nameWithOwner: `acme/${name}` }))
      return done({ organization: { repositories: page([repo, ...more]) } })
    }
    if (call === 'search') {
      // Like GitHub: a time from one second to another, both included, or from one on, and no more than 1,000
      // results listed, a page at a time. Of one kind, as with a fine-grained token, which finds nothing unless the
      // query says which. And open or closed, or in one repository, when the query says so.
      const q = variables.q as string
      const span = /updated:(\S+)\.\.(\S+)/.exec(q) ?? /updated:>=(\S+)()/.exec(q)
      const kind = /is:(issue|pr)\b/.exec(q)?.[1]
      const open = /is:(open|closed)\b/.exec(q)?.[1]
      const repo = /repo:acme\/(\S+)/.exec(q)?.[1]
      const matching = state.searchResults.filter(
        (node) =>
          (!span ||
            (second(node.updatedAt) >= second(span[1]) && (!span[2] || second(node.updatedAt) <= second(span[2])))) &&
          (!repo || node.repository.id === (repo === 'web' ? 'R1' : repo)) &&
          !!kind &&
          (node.kind === 'PullRequest') === (kind === 'pr') &&
          (!open || (node.state === 'OPEN') === (open === 'open')),
      )
      state.searched.push(span?.[2] ? `${span[1]}..${span[2]}` : 'since')
      state.queries.push(q)
      const listed = matching.slice(0, 1000)
      const start = Number(variables.after ?? 0)
      const end = Math.min(listed.length, start + state.searchPage)
      const pageInfo = { hasNextPage: end < listed.length, endCursor: String(end) }
      return done({ search: { issueCount: matching.length, pageInfo, nodes: listed.slice(start, end) } })
    }
    if (call === 'requested')
      return done({ viewer: { login: 'ali' }, search: page(state.requested.map((id) => ({ id }))) })
    if (call === 'nodes') {
      const ids = variables.ids as string[]
      return {
        data: { nodes: ids.map(() => null) },
        errors: ids.flatMap((id, index) =>
          state.missing[id] ? [{ type: state.missing[id], path: ['nodes', index], message: id }] : [],
        ),
      }
    }
    if (call === 'checks') {
      const ids = variables.ids as string[]
      return done({
        nodes: ids.map((id) =>
          state.hiddenStatus.includes(id) ? null : { id, isDraft: false, reviewDecision: null, ...status(id) },
        ),
      })
    }
    state.firsts.push(variables.first as number)
    const name = variables.name as string
    state.itemsOf.push(name)
    if (state.serverErrors > 0) {
      state.serverErrors--
      throw new GitHubError('GitHub answered 502', 'server')
    }
    const states = variables.states as string[]
    const list = text.includes('issues(') ? state.issues : state.prs
    const kind = text.includes('issues(') ? 'issues' : 'pullRequests'
    state.lists.push(`${kind} ${states.join(',')}`)
    if (state.hidden.includes(kind))
      return done(kind === 'issues' ? { repository: null } : { repository: { [kind]: null } })
    const matching = list.filter((node) => states.includes(node.state))
    const start = Number(variables.after ?? 0)
    const withChecks = text.includes('statusCheckRollup')
    const nodes = matching
      .slice(start, start + state.pageSize)
      .map((node) => (withChecks ? { ...node, ...status(node.id) } : node))
      .map((node) => (name === 'web' ? node : { ...node, id: `${name}-${node.id}`, repository: { id: name } }))
    const end = start + nodes.length
    const pageInfo = { hasNextPage: end < matching.length, endCursor: String(end) }
    return done({ repository: { [kind]: { pageInfo, nodes } } })
  }
  return { gh, state }
}

const ws: Workspace = {
  id: 'ws',
  name: 'acme',
  token: 't',
  sources: [{ kind: 'org', name: 'acme' }],
  views: [],
  pinned: [],
}

// GitHub's answer to items asked for by id: each as it is now.
function answerNodes(fake: Awaited<ReturnType<typeof setup>>) {
  const request = fake.gh.request.bind(fake.gh)
  fake.gh.request = async <T>(text: string, variables: Record<string, unknown> = {}) => {
    if (text !== NODES) return request<T>(text, variables)
    const all = [...fake.state.issues, ...fake.state.prs]
    const ids = variables.ids as string[]
    return { data: { nodes: ids.map((id) => all.find((node) => node.id === id) ?? null) } as T, errors: [] }
  }
}

async function setup(workspace = ws) {
  const fake = fakeGitHub()
  const fresh: string[] = []
  const store: SyncStore = {
    repos: new Map<string, Repo>(),
    items: new Map<string, Item>(),
    me: { login: null, requested: new Set() },
    changed: (ids) => fresh.push(...ids),
  }
  const status = idleStatus()
  const syncer = await Syncer.open(workspace, fake.gh, store, status)
  return { ...fake, store, status, syncer, fresh }
}

beforeEach(() => {
  localStorage.clear()
  saved.cache = null
})
afterEach(() => vi.restoreAllMocks())

describe('Syncer', () => {
  it('loads open items, then the closed history, without marking any of it as news', async () => {
    const { store, status, syncer, fresh } = await setup()
    await syncer.sync()
    expect([...store.items.keys()].toSorted()).toEqual(['I1', 'I3', 'P2', 'P4'])
    expect(store.items.get('P4')?.state).toBe('merged')
    expect(status.historyDone).toBe(true)
    expect(status.syncedAt).not.toBeNull()
    expect(fresh).toEqual([])
  })

  it('loads a long history in slices, and checks for changes before each one', async () => {
    const { store, state, status, syncer } = await setup()
    state.issues.push(...[10, 11, 12, 13, 14, 15].map((n) => raw(`I${n}`, 'CLOSED', ago(240))))
    state.pageSize = 1
    // Each request takes 20 seconds, so a slice of the history holds only a few pages.
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    state.onQuery = () => (now += 20_000)

    await syncer.sync()
    expect(status.historyDone).toBe(false)
    expect(status.history).toEqual({ done: 0, total: 1 })
    await vi.waitFor(() => expect(status.historyDone).toBe(true))
    syncer.stop()

    expect(store.items.size).toBe(10)
    expect(status.history).toEqual({ done: 1, total: 1 })
    // Each check is a search, or a free question to GitHub that tells whether one is needed.
    const pages = state.calls.flatMap((call, index) => (call === 'items' ? [index] : []))
    const checks = state.calls.flatMap((call, index) => (call === 'search' || call === 'probe' ? [index] : []))
    expect(checks.filter((index) => index < pages.at(-1)!).length).toBeGreaterThanOrEqual(2)
  })

  it('tells what each repository has left to load, but not open items it reads again', async () => {
    const { state, status, syncer } = await setup()
    const left: string[] = []
    state.onQuery = () => left.push(JSON.stringify(status.left))
    await syncer.sync()
    expect(left[1]).toBe('{"R1":["open","issues","pullRequests"]}')
    expect(left).toContain('{"R1":["issues","pullRequests"]}')
    expect(status.left).toEqual({})

    // A refresh some time later reads the open items again, which are still shown meanwhile.
    const later = Date.now() + 11 * 60_000
    vi.spyOn(Date, 'now').mockImplementation(() => later)
    left.length = 0
    state.calls = []
    await syncer.sync(true)
    expect(state.calls).toContain('items')
    expect(new Set(left)).toEqual(new Set(['{}']))
  })

  it('loads the history of active repositories first, the latest pushed first', async () => {
    const repos = [
      ['old', true, ago(1)],
      ['quiet', false, ago(24 * 300)],
      ['busy', false, ago(1)],
      ['mid', false, ago(24 * 10)],
      ['unknown', false, null],
    ] as const
    const started: string[] = []
    const gh = answering(async <T>(text: string, variables: Record<string, unknown> = {}): Promise<T> => {
      if (text === REVIEW_REQUESTED) return { viewer: { login: 'ali' }, search: page([]) } as T
      if (text === ORG_REPOS) {
        const nodes: RawRepo[] = repos.map(([name, isArchived, pushedAt]) => ({
          id: name,
          name,
          nameWithOwner: `acme/${name}`,
          description: null,
          isPrivate: false,
          isArchived,
          pushedAt,
          owner: { login: 'acme', avatarUrl: '' },
          primaryLanguage: null,
          openIssues: { totalCount: 0 },
          openPrs: { totalCount: 0 },
          allIssues: { totalCount: 1 },
          allPrs: { totalCount: 0 },
        }))
        return { organization: { repositories: page(nodes) } } as T
      }
      started.push(variables.name as string)
      return { repository: { issues: page([]) } } as T
    })
    const store: SyncStore = {
      repos: new Map(),
      items: new Map(),
      me: { login: null, requested: new Set() },
      changed: () => {},
    }
    const syncer = await Syncer.open(ws, gh, store, idleStatus())
    await syncer.sync()
    expect(started).toEqual(['busy', 'mid', 'quiet', 'unknown', 'old'])
  })

  it('picks up a change with one search of each kind, and marks it as news', async () => {
    const { store, state, syncer, fresh } = await setup()
    await syncer.sync()
    state.searchResults = [raw('I1', 'CLOSED', new Date().toISOString())]
    state.calls = []
    await syncer.sync()
    expect(state.calls).toEqual(LOOK)
    expect(store.items.get('I1')?.state).toBe('closed')
    expect(fresh).toEqual(['I1'])
  })

  it('searches the time away in parts when it holds more changes than a search lists', async () => {
    const { store, state, syncer } = await setup()
    await syncer.sync()
    // Two hours away, in which 1,001 items changed, one issue was opened and closed, and a closed one was edited.
    let now = Date.now() + 2 * HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const during = (minutes: number) => new Date(now - minutes * MINUTE).toISOString()
    const busy = Array.from({ length: 1001 }, (_, index) => raw(`I${100 + index}`, 'OPEN', during(index / 10)))
    const openedAndClosed = raw('I8', 'CLOSED', during(30))
    const edited = { ...raw('I3', 'CLOSED', during(20)), title: 'Edited while away' }
    state.searchResults = [...busy, openedAndClosed, edited]
    state.calls = []
    await syncer.sync()

    expect(store.items.get('I8')?.state).toBe('closed')
    expect(store.items.get('I3')?.title).toBe('Edited while away')
    expect(busy.every((node) => store.items.has(node.id))).toBe(true)
    // The first search said how many, then the time was searched again in parts, without reading every open item.
    expect(state.searched[0]).toBe('since')
    expect(state.searched.length).toBeGreaterThan(2)
    expect(state.calls).not.toContain('items')

    // The next look starts from there: nothing is searched in parts again.
    now += MINUTE
    state.searched = []
    state.searchResults = []
    await syncer.sync(true)
    expect(state.searched).toEqual(['since', 'since'])
  })

  it('shows and keeps the parts of the time away it searched when GitHub fails partway', async () => {
    const { store, state, status, syncer } = await setup()
    await syncer.sync()
    let now = Date.now() + 2 * HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    state.searchResults = Array.from({ length: 1500 }, (_, index) =>
      raw(`I${100 + index}`, 'OPEN', new Date(now - index * 5000).toISOString()),
    )
    // GitHub stops answering after the first part of the time.
    state.onQuery = () => {
      if (state.searched.length === 2) state.rateLimited = true
    }
    await syncer.sync()
    expect(status.pausedUntil).not.toBeNull()
    const kept = state.searchResults.filter((node) => store.items.has(node.id)).length
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(1500)
  })

  it('searches a second holding more changes of a kind than a search lists, open and closed apart', async () => {
    const { store, state, syncer } = await setup()
    await syncer.sync()
    let now = Date.now() + HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const once = new Date(now - 5 * MINUTE).toISOString()
    // A change made to 1,200 items at once: open and closed issues, and pull requests.
    state.searchResults = [
      ...Array.from({ length: 600 }, (_, index) => raw(`I${100 + index}`, 'OPEN', once)),
      ...Array.from({ length: 500 }, (_, index) => raw(`I${700 + index}`, 'CLOSED', once)),
      ...Array.from({ length: 100 }, (_, index) => raw(`P${100 + index}`, 'MERGED', once, true)),
    ]
    state.calls = []
    await syncer.sync()
    expect(state.searchResults.every((node) => store.items.has(node.id))).toBe(true)
    expect(searches(state.queries.filter(byPart))).toEqual(
      searches(
        ['is:open', 'is:closed'].map(
          (terms) => `org:acme is:issue ${terms} updated:${secondOf(once)}..${secondOf(once)}`,
        ),
      ),
    )
    // The pull requests' search lists all of its own.
    expect(state.queries.filter((q) => has(q, 'is:pr'))).toHaveLength(1)
    // Nothing needed reading again from the repository.
    expect(state.calls).not.toContain('items')
  })

  it('searches a second holding more changes than a search lists source by source', async () => {
    const { state, syncer } = await setup({
      ...ws,
      sources: [
        { kind: 'org', name: 'acme' },
        { kind: 'org', name: 'beta' },
      ],
    })
    await syncer.sync()
    let now = Date.now() + HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const once = new Date(now - 5 * MINUTE).toISOString()
    state.searchResults = Array.from({ length: 1001 }, (_, index) =>
      raw(`I${100 + index}`, index % 2 ? 'OPEN' : 'CLOSED', once),
    )
    await syncer.sync()
    const during = `updated:${secondOf(once)}..${secondOf(once)}`
    const bySource = state.queries.filter((q) => has(q, during) && !byPart(q))
    expect(searches(bySource)).toEqual(
      searches([`org:acme org:beta is:issue ${during}`, `org:acme is:issue ${during}`, `org:beta is:issue ${during}`]),
    )
    expect(searches(state.queries.filter((q) => has(q, 'is:issue', 'is:closed')))).toEqual(
      searches([`org:acme is:issue is:closed ${during}`, `org:beta is:issue is:closed ${during}`]),
    )
  })

  it('reads the closed history again when one second holds more closed changes than a search lists', async () => {
    const { store, state, status, syncer } = await setup()
    await syncer.sync()
    let now = Date.now() + 2 * HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    // A thousand and one issues closed at once while away.
    const once = new Date(now - 30 * MINUTE).toISOString()
    const closed = Array.from({ length: 1001 }, (_, index) => raw(`I${100 + index}`, 'CLOSED', once))
    state.issues.push(...closed)
    state.searchResults = closed
    state.lists = []
    await syncer.sync()
    await vi.waitFor(() => expect(status.historyDone).toBe(true))
    expect(closed.filter((node) => !store.items.has(node.id))).toEqual([])
    // The open items were read again, and the closed issues, not the closed pull requests.
    expect(state.lists.toSorted()).toEqual(['issues CLOSED', 'issues OPEN', 'pullRequests OPEN'])

    // The next look starts from there.
    now += 11 * MINUTE
    state.searched = []
    state.searchResults = []
    await syncer.sync(true)
    expect(state.searched).toEqual(['since', 'since'])
  })

  it('shows issues closed at once in a crowded second as closed, before the closed history loads', async () => {
    const fake = await setup()
    const { store, state, syncer } = fake
    answerNodes(fake)
    const many = Array.from({ length: 1001 }, (_, index) => raw(`I${100 + index}`, 'OPEN', ago(48)))
    state.issues.push(...many)
    await syncer.sync()
    const now = Date.now() + 2 * HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const once = new Date(now - 5 * MINUTE).toISOString()
    for (const node of many) Object.assign(node, { state: 'CLOSED', updatedAt: once })
    state.searchResults = many
    // A tenth of the hour's points left: enough for a sync, not for the history.
    fake.gh.rate = () => ({ limit: 5000, remaining: 500, resetAt: now + HOUR })
    await syncer.sync()
    expect(many.filter((node) => store.items.get(node.id)?.state === 'open')).toEqual([])
  })

  it("reads a crowded second's closed history again once, though later runs look over that second again", async () => {
    const fake = await setup()
    const { state, syncer } = fake
    await syncer.sync()
    let now = Date.now() + 2 * HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const once = new Date(now - 30 * 1000).toISOString()
    const closed = Array.from({ length: 1001 }, (_, index) => raw(`I${100 + index}`, 'CLOSED', once))
    state.issues.push(...closed)
    state.searchResults = closed
    state.pageSize = 10
    // Each request takes 3 seconds: a slice of the history holds about 15 pages.
    state.onQuery = () => (now += 3000)
    const starts: number[] = []
    const query = fake.gh.query.bind(fake.gh)
    fake.gh.query = async <T>(text: string, variables?: Record<string, unknown>) => {
      const states = variables?.states as string[] | undefined
      if (text.includes('issues(') && states?.includes('CLOSED') && variables?.after == null) starts.push(now)
      return query<T>(text, variables)
    }
    // A run a minute until the second is past what the search looks back over.
    while (now < Date.parse(once) + 12 * MINUTE) {
      await syncer.sync()
      now += MINUTE
    }
    syncer.stop()
    expect(starts).toHaveLength(1)
  })

  it('reads again the closed history of the repository with a crowded second alone', async () => {
    const fake = await setup()
    const { state, syncer } = fake
    state.more = ['api']
    await syncer.sync()
    const now = Date.now() + 2 * HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const once = new Date(now - 5 * MINUTE).toISOString()
    // A thousand and one issues of acme/web closed at once, and one of acme/api.
    const closed = Array.from({ length: 1001 }, (_, index) => raw(`I${100 + index}`, 'CLOSED', once))
    state.issues.push(...closed)
    const other = { ...raw('I9', 'CLOSED', once), repository: { id: 'api' } }
    state.searchResults = [...closed, other]
    state.itemsOf = []
    state.lists = []
    await syncer.sync()
    await vi.waitFor(() => expect(fake.status.historyDone).toBe(true))
    expect(fake.store.items.get('I9')?.state).toBe('closed')
    const read = state.lists.map((list, index) => `${state.itemsOf[index]} ${list}`)
    expect(read.filter((each) => each.endsWith('CLOSED'))).toEqual(['web issues CLOSED'])
    expect(searches(state.queries.filter(byRepo))).toEqual(
      searches(
        ['web', 'api'].map(
          (name) => `repo:acme/${name} is:issue is:closed updated:${secondOf(once)}..${secondOf(once)}`,
        ),
      ),
    )
  })

  it('finds an item of a crowded second that the search indexed after the run that split it by repository', async () => {
    const fake = await setup()
    const { state, store, syncer } = fake
    state.more = ['api']
    // An open issue of acme/web the list holds.
    const issue = raw('I5000', 'OPEN', ago(48))
    state.issues.push(issue)
    await syncer.sync()
    expect(store.items.get('I5000')?.state).toBe('open')
    let now = Date.now() + 2 * HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fake.gh.probe = async () => 'changed'
    const once = new Date(now - 30 * 1000).toISOString()
    // 1,001 issues of the organization closed in one second: 600 of acme/web and 401 of acme/api, so each
    // repository's own search lists all of its own.
    const web = Array.from({ length: 600 }, (_, index) => raw(`I${100 + index}`, 'CLOSED', once))
    const api = Array.from({ length: 401 }, (_, index) => ({
      ...raw(`I${1000 + index}`, 'CLOSED', once),
      repository: { id: 'api' },
    }))
    state.searchResults = [...web, ...api]
    await syncer.sync()
    expect(store.items.get('I100')?.state).toBe('closed')
    expect(store.items.get('I1000')?.state).toBe('closed')
    // It was closed in that second too, and reaches the search index late, as the overlap is there for.
    Object.assign(issue, { state: 'CLOSED', updatedAt: once })
    state.searchResults = [...state.searchResults, issue]
    now += MINUTE
    await syncer.sync()
    expect(store.items.get('I5000')?.state).toBe('closed')
  })

  it('finds an item of a crowded second that the search indexed late, from what an earlier version kept of it', async () => {
    const fake = await setup()
    const { state, store, syncer } = fake
    state.more = ['api']
    const issue = raw('I5000', 'OPEN', ago(48))
    state.issues.push(issue)
    await syncer.sync()
    let now = Date.now() + 2 * HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fake.gh.probe = async () => 'changed'
    const once = new Date(now - 30 * 1000).toISOString()
    const web = Array.from({ length: 600 }, (_, index) => raw(`I${100 + index}`, 'CLOSED', once))
    const api = Array.from({ length: 401 }, (_, index) => ({
      ...raw(`I${1000 + index}`, 'CLOSED', once),
      repository: { id: 'api' },
    }))
    state.searchResults = [...web, ...api]
    await syncer.sync()
    // An earlier version kept how many changes the second held, not the repositories that held them.
    const { crowded } = (syncer as unknown as { cache: Cache }).cache
    expect(Object.keys(crowded)).not.toHaveLength(0)
    for (const [q, { second: at }] of Object.entries(crowded)) crowded[q] = { second: at, count: 1001 } as never
    Object.assign(issue, { state: 'CLOSED', updatedAt: once })
    state.searchResults = [...state.searchResults, issue]
    now += MINUTE
    await syncer.sync()
    syncer.stop()
    expect(store.items.get('I5000')?.state).toBe('closed')
  })

  it('finds an item of a crowded second that the search indexed late, though another left it meanwhile', async () => {
    const fake = await setup()
    const { state, store, syncer } = fake
    state.more = ['api']
    const issue = raw('I5000', 'OPEN', ago(48))
    state.issues.push(issue)
    await syncer.sync()
    await vi.waitFor(() => expect(fake.status.historyDone).toBe(true))
    let now = Date.now() + 2 * HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fake.gh.probe = async () => 'changed'
    const once = new Date(now - 30 * 1000).toISOString()
    // 1,001 issues of the organization closed in one second, which each repository's own search lists.
    const web = Array.from({ length: 600 }, (_, index) => raw(`I${100 + index}`, 'CLOSED', once))
    const api = Array.from({ length: 401 }, (_, index) => ({
      ...raw(`I${1000 + index}`, 'CLOSED', once),
      repository: { id: 'api' },
    }))
    state.searchResults = [...web, ...api]
    await syncer.sync()
    expect(store.items.get('I100')?.state).toBe('closed')
    // One of them is edited again, which takes it out of that second, as one closed then reaches the search index:
    // the second holds as many as before.
    now += MINUTE
    Object.assign(web[0], { updatedAt: new Date(now - 1000).toISOString() })
    Object.assign(issue, { state: 'CLOSED', updatedAt: once })
    state.searchResults = [...state.searchResults, issue]
    // A run a minute until the second is past what the search looks back over.
    while (now < Date.parse(once) + 12 * MINUTE) {
      await syncer.sync()
      now += MINUTE
    }
    syncer.stop()
    expect(store.items.get('I5000')?.state).toBe('closed')
  })

  it('searches a crowded second again in the repositories that held its changes, while they hold all it does', async () => {
    const fake = await setup()
    const { state, store, syncer } = fake
    state.more = ['api', ...Array.from({ length: 38 }, (_, index) => `quiet${index}`)]
    await syncer.sync()
    await vi.waitFor(() => expect(fake.status.historyDone).toBe(true))
    let now = Date.now() + 2 * HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fake.gh.probe = async () => 'changed'
    const once = new Date(now - 30 * 1000).toISOString()
    // 1,001 issues closed in one second, in two of the organization's 40 repositories.
    const web = Array.from({ length: 600 }, (_, index) => raw(`I${100 + index}`, 'CLOSED', once))
    const api = Array.from({ length: 401 }, (_, index) => ({
      ...raw(`I${1000 + index}`, 'CLOSED', once),
      repository: { id: 'api' },
    }))
    state.searchResults = [...web, ...api]
    const runs: number[] = []
    const run = async () => {
      const before = state.queries.length
      await syncer.sync()
      runs.push(state.queries.slice(before).filter(byRepo).length)
      now += MINUTE
    }
    await run()
    await run()
    // One of them is edited again, which takes it out of that second, as one closed then in a quiet repository reaches
    // the search index: the second holds as many as before, though not all in the two.
    Object.assign(web[0], { updatedAt: new Date(now - 1000).toISOString() })
    state.searchResults.push({ ...raw('I5000', 'CLOSED', once), repository: { id: 'quiet7' } })
    await run()
    await run()
    syncer.stop()
    // The others are searched until those found make up what the second holds.
    expect(runs).toEqual([40, 2, 10, 3])
    expect(store.items.get('I5000')?.state).toBe('closed')
  })

  it('reads the open items again when a single second holds more changes than a search lists', async () => {
    const { store, state, syncer } = await setup()
    await syncer.sync()
    let now = Date.now() + HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    state.issues.push(raw('I7', 'OPEN', new Date(now).toISOString()))
    // A change made to 1,001 issues at once.
    const once = new Date(now - 5 * MINUTE).toISOString()
    state.searchResults = Array.from({ length: 1001 }, (_, index) => raw(`I${100 + index}`, 'OPEN', once))
    state.calls = []
    await syncer.sync()
    expect(state.calls).toContain('items')
    expect(store.items.has('I7')).toBe(true)
    // Each part is cut again until a second alone holds too many: a few searches, not one per second.
    expect(state.searched.length).toBeLessThan(60)
    now += MINUTE
    state.searched = []
    await syncer.sync(true)
    expect(state.searched[0]).toBe('since')
  })

  it('reads the open items again of a repository that had none, when one second holds more of its changes than a search lists', async () => {
    const fake = await setup()
    const { state, store, syncer } = fake
    state.issues = []
    await syncer.sync()
    await vi.waitFor(() => expect(fake.status.historyDone).toBe(true))
    const now = Date.now() + MINUTE
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fake.gh.probe = async () => 'changed'
    // 1,001 issues opened in one second, in a repository that had no open issues a minute ago.
    const once = new Date(now - 30 * 1000).toISOString()
    const opened = Array.from({ length: 1001 }, (_, index) => raw(`I${100 + index}`, 'OPEN', once))
    state.issues.push(...opened)
    state.searchResults = opened
    await syncer.sync()
    syncer.stop()
    expect(opened.filter((node) => store.items.has(node.id))).toHaveLength(1001)
  })

  it('reads the repositories once in a run that reads them anyway, for a crowded second and a change outside them', async () => {
    const fake = await setup()
    const { state, store, syncer } = fake
    state.issues = []
    await syncer.sync()
    await vi.waitFor(() => expect(fake.status.historyDone).toBe(true))
    // A run a while later, which reads the repositories first.
    const now = Date.now() + 20 * MINUTE
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fake.gh.probe = async () => 'changed'
    const once = new Date(now - 30 * 1000).toISOString()
    const opened = Array.from({ length: 1001 }, (_, index) => raw(`I${100 + index}`, 'OPEN', once))
    state.issues.push(...opened)
    state.searchResults = [...opened, { ...raw('X1', 'OPEN', once), repository: { id: 'elsewhere' } }]
    state.calls = []
    await syncer.sync()
    syncer.stop()
    expect(opened.filter((node) => store.items.has(node.id))).toHaveLength(1001)
    expect(state.calls.filter((call) => call === 'repos')).toHaveLength(1)
  })

  it('reads the closed history of a repository that had none closed, when one second holds more of its changes than a search lists', async () => {
    const fake = await setup()
    const { state, store, syncer } = fake
    state.issues = [raw('I1', 'OPEN', ago(24))]
    await syncer.sync()
    await vi.waitFor(() => expect(fake.status.historyDone).toBe(true))
    let now = Date.now() + MINUTE
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fake.gh.probe = async () => 'changed'
    // 1,001 issues opened and closed in one second.
    const once = new Date(now - 30 * 1000).toISOString()
    const closed = Array.from({ length: 1001 }, (_, index) => raw(`I${100 + index}`, 'CLOSED', once))
    state.issues.push(...closed)
    state.searchResults = closed
    await syncer.sync()
    now += MINUTE
    await syncer.sync()
    syncer.stop()
    expect(closed.filter((node) => store.items.has(node.id))).toHaveLength(1001)
  })

  it('reads the open items again of a repository that had none, when one second holds more of its changes than a search lists and reading the repositories failed', async () => {
    const fake = await setup()
    const { state, store, syncer } = fake
    state.issues = []
    await syncer.sync()
    await vi.waitFor(() => expect(fake.status.historyDone).toBe(true))
    // A run a while later, which reads the repositories first, but GitHub can't answer that.
    const now = Date.now() + 20 * MINUTE
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fake.gh.probe = async () => 'changed'
    state.onQuery = () => {
      if (state.calls.at(-1) === 'repos') throw new GitHubError('Something went wrong', 'query')
    }
    const once = new Date(now - 30 * 1000).toISOString()
    const opened = Array.from({ length: 1001 }, (_, index) => raw(`I${100 + index}`, 'OPEN', once))
    state.issues.push(...opened)
    state.searchResults = opened
    await syncer.sync()
    syncer.stop()
    expect(fake.status.failedSources).toEqual(['acme'])
    expect(opened.filter((node) => store.items.has(node.id))).toHaveLength(1001)
  })

  it('reads the open items again of a repository that had none as the run read it, when one second then holds more of its changes than a search lists', async () => {
    const fake = await setup()
    const { state, store, syncer } = fake
    state.issues = []
    await syncer.sync()
    await vi.waitFor(() => expect(fake.status.historyDone).toBe(true))
    const now = Date.now() + 20 * MINUTE
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fake.gh.probe = async () => 'changed'
    // 1,001 issues opened in the second the run started, after it read the repositories and before it searched.
    const opened = Array.from({ length: 1001 }, (_, index) =>
      raw(`I${100 + index}`, 'OPEN', new Date(now).toISOString()),
    )
    state.onQuery = () => {
      if (state.calls.at(-1) !== 'search' || state.searchResults.length) return
      state.issues.push(...opened)
      state.searchResults = opened
    }
    state.calls = []
    await syncer.sync()
    syncer.stop()
    expect(state.calls.filter((call) => call === 'repos')).toHaveLength(1)
    expect(opened.filter((node) => store.items.has(node.id))).toHaveLength(1001)
  })

  it('reads the closed history of a repository that had none closed, when one second holds more of its changes than a search lists and reading the repositories failed', async () => {
    const fake = await setup()
    const { state, store, syncer } = fake
    state.issues = [raw('I1', 'OPEN', ago(24))]
    await syncer.sync()
    await vi.waitFor(() => expect(fake.status.historyDone).toBe(true))
    let now = Date.now() + 20 * MINUTE
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fake.gh.probe = async () => 'changed'
    state.onQuery = () => {
      if (state.calls.at(-1) === 'repos') throw new GitHubError('Something went wrong', 'query')
    }
    const once = new Date(now - 30 * 1000).toISOString()
    const closed = Array.from({ length: 1001 }, (_, index) => raw(`I${100 + index}`, 'CLOSED', once))
    state.issues.push(...closed)
    state.searchResults = closed
    await syncer.sync()
    now += MINUTE
    await syncer.sync()
    syncer.stop()
    expect(closed.filter((node) => store.items.has(node.id))).toHaveLength(1001)
  })

  it('counts no more in the one repository it knows of an organization for a second that holds more changes than a search lists in another, when reading the repositories failed', async () => {
    const fake = await setup()
    const { state, store, status, syncer } = fake
    // GitHub hides the repository's issues from the app, so it shows what it counts.
    state.hidden = ['issues']
    await syncer.sync()
    await vi.waitFor(() => expect(fake.status.historyDone).toBe(true))
    const shown = () =>
      repoRows(store.items.values(), { repos: store.repos, now: Date.now(), me: noOne() }, status)[0].counts.issues
    expect(shown()).toBe(1)
    const now = Date.now() + 20 * MINUTE
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fake.gh.probe = async () => 'changed'
    // 1,001 issues opened in one second in a repository new to the organization, which the run can't read.
    state.more = ['api']
    state.onQuery = () => {
      if (state.calls.at(-1) === 'repos') throw new GitHubError('Something went wrong', 'query')
    }
    const once = new Date(now - 30 * 1000).toISOString()
    state.searchResults = Array.from({ length: 1001 }, (_, index) => ({
      ...raw(`I${100 + index}`, 'OPEN', once),
      repository: { id: 'api' },
    }))
    await syncer.sync()
    syncer.stop()
    expect(store.repos.get('R1')?.openIssues).toBe(1)
    expect(shown()).toBe(1)
  })

  it.each([
    ['an open', 'OPEN'],
    ['a closed', 'CLOSED'],
  ] as const)(
    'finds %s issue that the search indexed late of the one repository it knows of an organization, for a second that holds more changes than a search lists in another, when reading the repositories failed',
    async (_name, itemState) => {
      const fake = await setup()
      const { state, store, syncer } = fake
      state.issues = []
      await syncer.sync()
      await vi.waitFor(() => expect(fake.status.historyDone).toBe(true))
      let now = Date.now() + 20 * MINUTE
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      fake.gh.probe = async () => 'changed'
      // 1,001 issues changed in one second in a repository new to the organization, which the run can't read, and two
      // of acme/web, which had none: the search has one of those so far.
      state.more = ['api']
      state.onQuery = () => {
        if (state.calls.at(-1) === 'repos') throw new GitHubError('Something went wrong', 'query')
      }
      const once = new Date(now - 30 * 1000).toISOString()
      const [first, late] = ['I50', 'I51'].map((id) => raw(id, itemState, once))
      state.issues.push(first, late)
      const api = Array.from({ length: 1001 }, (_, index) => ({
        ...raw(`I${100 + index}`, itemState, once),
        repository: { id: 'api' },
      }))
      state.searchResults = [first, ...api]
      await syncer.sync()
      expect(store.items.has('I50')).toBe(true)
      // The other reaches the search index a minute later.
      state.searchResults = [first, late, ...api]
      now += MINUTE
      await syncer.sync()
      syncer.stop()
      expect(store.items.has('I51')).toBe(true)
    },
  )

  it("keeps what it found and looks over the same time again when the hour's allowance runs low partway", async () => {
    const { gh, store, state, syncer } = await setup()
    await syncer.sync()
    let now = Date.now() + 2 * HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    // Spread over the time away, the latest first.
    state.searchResults = Array.from({ length: 1500 }, (_, index) =>
      raw(`I${100 + index}`, 'OPEN', new Date(now - index * 5000).toISOString()),
    )
    // The allowance runs low once the first part of the time has been searched.
    const low = { limit: 5000, remaining: 50, resetAt: now + 10 * MINUTE }
    state.onQuery = () => {
      if (state.searched.length === 1) gh.rate = () => low
    }
    await syncer.sync()
    const kept = state.searchResults.filter((node) => store.items.has(node.id)).length
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(1500)

    gh.rate = () => null
    state.onQuery = () => {}
    now += 11 * MINUTE
    state.searched = []
    await syncer.sync()
    expect(state.searched[0]).toBe('since')
    expect(state.searchResults.every((node) => store.items.has(node.id))).toBe(true)
  })

  it('takes the labels a copy kept from before lacks, when the open items are read again', async () => {
    const { store, state, syncer } = await setup()
    state.issues[0] = { ...state.issues[0], labels: labels(20) }
    await syncer.sync()
    expect(store.items.get('I1')?.labels).toHaveLength(20)
    // GitHub gives all 25 now, and the issue hasn't changed since.
    state.issues[0] = { ...state.issues[0], labels: labels(25) }
    const later = Date.now() + HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => later)
    await syncer.sync(true)
    expect(store.items.get('I1')?.labels).toHaveLength(25)
  })

  it('keeps the newer copy when an older one arrives later', async () => {
    const { store, state, syncer } = await setup()
    await syncer.sync()
    state.searchResults = [raw('I1', 'OPEN', ago(48))]
    await syncer.sync()
    expect(store.items.get('I1')?.updatedAt).toBe(state.issues[0].updatedAt)
  })

  it('gets the checks with the open pull requests, and asks again only for a refresh', async () => {
    const { store, state, syncer } = await setup()
    state.checks.P2 = 'FAILURE'
    await syncer.sync()
    expect(store.items.get('P2')?.checks).toBe('failure')
    expect(state.calls).not.toContain('checks')
    const later = Date.now() + 1000
    vi.spyOn(Date, 'now').mockImplementation(() => later)
    await syncer.sync(true)
    expect(state.calls.filter((call) => call === 'checks')).toHaveLength(1)
  })

  it("reads checks again as often as they are likely to change, since that doesn't change the update time", async () => {
    const { store, state, syncer } = await setup()
    state.checks.P2 = 'PENDING'
    await syncer.sync()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const checkCalls = async (minutes: number) => {
      now += minutes * MINUTE
      state.calls = []
      await syncer.sync()
      return state.calls.filter((call) => call === 'checks').length
    }

    // Running checks are read every minute.
    expect(await checkCalls(1)).toBe(1)
    state.checks.P2 = 'FAILURE'
    expect(await checkCalls(1)).toBe(1)
    expect(store.items.get('P2')?.checks).toBe('failure')
    expect(store.items.get('P2')?.updatedAt).toBe(state.prs[0].updatedAt)
    // Failing ones every five minutes.
    expect(await checkCalls(4)).toBe(0)
    state.checks.P2 = 'SUCCESS'
    expect(await checkCalls(1)).toBe(1)
    // Passing ones every fifteen.
    expect(await checkCalls(14)).toBe(0)
    expect(await checkCalls(1)).toBe(1)
  })

  it('asks a few times in a row while GitHub works out whether a pull request conflicts', async () => {
    const { store, state, syncer } = await setup()
    state.mergeable.P2 = 'UNKNOWN'
    await syncer.sync()
    expect(store.items.get('P2')?.merge).toBeNull()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const checkCalls = async () => {
      now += MINUTE
      state.calls = []
      await syncer.sync()
      return state.calls.filter((call) => call === 'checks').length
    }
    expect([await checkCalls(), await checkCalls(), await checkCalls(), await checkCalls()]).toEqual([1, 1, 1, 0])

    state.mergeable.P2 = 'CONFLICTING'
    await syncer.sync(true)
    expect(store.items.get('P2')?.merge).toBe('conflicts')
    // Its base branch moved: GitHub doesn't know again for a moment, and the last answer stands meanwhile.
    state.mergeable.P2 = 'UNKNOWN'
    now += MINUTE
    await syncer.sync(true)
    expect(store.items.get('P2')?.merge).toBe('conflicts')
    // The same holds when the pull request itself changes and arrives through the search.
    now += MINUTE
    state.searchResults = [raw('P2', 'OPEN', new Date(now).toISOString(), true)]
    state.probes = Object.fromEntries(state.probed.map((path) => [path, 'changed']))
    await syncer.sync()
    expect(store.items.get('P2')?.updatedAt).toBe(new Date(now).toISOString())
    expect(store.items.get('P2')?.merge).toBe('conflicts')
  })

  it('asks again soon when a pull request known to be clean comes back unknown', async () => {
    const { store, state, syncer } = await setup()
    await syncer.sync()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const checkCalls = async (minutes: number) => {
      now += minutes * MINUTE
      state.calls = []
      await syncer.sync()
      return state.calls.filter((call) => call === 'checks').length
    }
    // Its base branch moved by its fifteen-minute turn, and GitHub is working out whether it still merges.
    state.mergeable.P2 = 'UNKNOWN'
    expect(await checkCalls(15)).toBe(1)
    expect(store.items.get('P2')?.merge).toBe('clean')
    state.mergeable.P2 = 'CONFLICTING'
    expect(await checkCalls(1)).toBe(1)
    expect(store.items.get('P2')?.merge).toBe('conflicts')
    expect(await checkCalls(1)).toBe(0)
  })

  it('asks again soon when a pull request known to be clean changes and the search finds it unknown', async () => {
    const { store, state, syncer } = await setup()
    await syncer.sync()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    // A push, in a repository without checks: the search finds it while GitHub works out whether it still merges.
    now += MINUTE
    state.searchResults = [{ ...raw('P2', 'OPEN', new Date(now).toISOString(), true), mergeable: 'UNKNOWN' }]
    await syncer.sync()
    expect(store.items.get('P2')).toMatchObject({ merge: 'clean', checks: null })

    // GitHub has worked it out: it conflicts now.
    state.mergeable.P2 = 'CONFLICTING'
    state.searchResults = []
    now += MINUTE
    state.calls = []
    await syncer.sync()
    expect(state.calls).toContain('checks')
    expect(store.items.get('P2')?.merge).toBe('conflicts')
    // Known again, it waits its usual turn.
    now += MINUTE
    state.calls = []
    await syncer.sync()
    expect(state.calls).not.toContain('checks')
  })

  it('drops the checks and conflicts of a pull request once it merges', async () => {
    const { store, state, syncer } = await setup()
    state.mergeable.P2 = 'CONFLICTING'
    state.checks.P2 = 'FAILURE'
    await syncer.sync()
    expect(store.items.get('P2')).toMatchObject({ merge: 'conflicts', checks: 'failure' })
    state.searchResults = [raw('P2', 'MERGED', new Date().toISOString(), true)]
    await syncer.sync()
    expect(store.items.get('P2')).toMatchObject({ state: 'merged', merge: null, checks: null })
  })

  it("doesn't read checks in an archived repository again", async () => {
    const { state, syncer } = await setup()
    state.archived = true
    await syncer.sync()
    const later = Date.now() + 5000
    vi.spyOn(Date, 'now').mockImplementation(() => later)
    state.calls = []
    await syncer.sync(true)
    expect(state.calls).not.toContain('checks')
  })

  it("doesn't read checks again on a refresh that has just read them with the open items", async () => {
    const { state, syncer } = await setup()
    await syncer.sync()
    // Long enough since the open items were last read that a refresh reads them all again.
    const later = Date.now() + HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => later)
    state.calls = []
    await syncer.sync(true)
    expect(state.calls).toContain('items')
    expect(state.calls).not.toContain('checks')
  })

  it('pauses until GitHub says to come back, without retrying in between', async () => {
    const { state, status, syncer } = await setup()
    await syncer.sync()
    state.rateLimited = true
    await syncer.sync()
    expect(status.pausedUntil).toBeGreaterThan(Date.now())
    state.calls = []
    await syncer.sync()
    expect(state.calls).toEqual([])
  })

  it('asks for pages of the largest size that costs one point, and halves a page GitHub times out on', async () => {
    const { state, syncer } = await setup()
    state.serverErrors = 1
    await syncer.sync()
    // Open issues, at half the size after the timeout, then open pull requests, then the closed history.
    expect(state.firsts).toEqual([
      size('issues', true),
      Math.floor(size('issues', true) / 2),
      size('pullRequests', true),
      size('issues', false),
      size('pullRequests', false),
    ])
  })

  it('removes an item only when GitHub says it is gone, not when it is hidden from the token', async () => {
    const { store, state, syncer } = await setup()
    await syncer.sync()
    // Both open items drop out of the open lists, and GitHub won't show them when asked for by id.
    state.issues = state.issues.filter((node) => node.id !== 'I1')
    state.prs = state.prs.filter((node) => node.id !== 'P2')
    state.missing = { I1: 'FORBIDDEN', P2: 'NOT_FOUND' }
    const later = Date.now() + HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => later)
    await syncer.sync(true)
    expect(store.items.has('I1')).toBe(true)
    expect(store.items.has('P2')).toBe(false)
  })

  it("keeps a repository's open items while GitHub won't show the repository", async () => {
    const { store, state, syncer } = await setup()
    await syncer.sync()
    state.hidden = ['issues', 'pullRequests']
    const later = Date.now() + HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => later)
    state.calls = []
    await syncer.sync(true)
    expect(state.calls).toContain('items')
    expect(state.calls).not.toContain('nodes')
    expect(store.items.has('I1')).toBe(true)
  })

  it("counts a repository's open items of a kind GitHub won't show as GitHub does, until it shows them", async () => {
    const { store, state, status, syncer } = await setup()
    state.hidden = ['issues']
    await syncer.sync()
    const issuesCount = () =>
      repoRows(store.items.values(), { repos: store.repos, now: Date.now(), me: noOne() }, status)[0].counts.issues
    expect(store.items.has('I1')).toBe(false)
    expect(status.hidden).toEqual({ R1: ['issue'] })
    expect(issuesCount()).toBe(1)

    // A refresh a while later, as the open items are read again.
    state.hidden = []
    const later = Date.now() + HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => later)
    await syncer.sync(true)
    expect(store.items.has('I1')).toBe(true)
    expect(status.hidden).toEqual({})
    expect(issuesCount()).toBe(1)
  })

  it("asks again in a while for a closed history GitHub won't show for now, rather than counting it complete", async () => {
    const { store, state, status, syncer } = await setup()
    // As when an organization's SAML sign-on lapses for a moment.
    state.hidden = ['issues']
    await syncer.sync()
    expect(store.items.has('I3')).toBe(false)
    expect(store.items.get('P4')?.state).toBe('merged')
    // Nothing else is loading meanwhile.
    expect(status.left).toEqual({})

    state.hidden = []
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const closedIssues = async (minutes: number) => {
      now += minutes * MINUTE
      state.lists = []
      await syncer.sync()
      return state.lists.filter((list) => list === 'issues CLOSED').length
    }
    expect(await closedIssues(1)).toBe(0)
    expect(await closedIssues(4)).toBe(1)
    expect(store.items.get('I3')?.state).toBe('closed')
    expect(await closedIssues(60)).toBe(0)
  })

  it("waits longer each time GitHub still won't show a closed history, and asks again at once on a refresh", async () => {
    const { store, state, syncer } = await setup()
    state.hidden = ['issues']
    await syncer.sync()
    // No second try right after the first, as the next slice of the history would be.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(state.lists.filter((list) => list === 'issues CLOSED')).toHaveLength(1)

    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const tries: number[] = []
    for (let minute = 1; minute <= 30; minute++) {
      now += MINUTE
      state.lists = []
      await syncer.sync()
      if (state.lists.includes('issues CLOSED')) tries.push(minute)
    }
    // After five minutes, then ten more, then twenty more.
    expect(tries).toEqual([5, 15])

    state.hidden = []
    now += 11 * MINUTE
    await syncer.sync(true)
    expect(store.items.get('I1')?.state).toBe('open')
    expect(store.items.get('I3')?.state).toBe('closed')
  })

  it('finds the pull requests that ask the viewer for a review every five minutes', async () => {
    const { store, state, syncer } = await setup()
    state.requested = ['P2']
    await syncer.sync()
    expect(store.me.login).toBe('ali')
    expect([...store.me.requested]).toEqual(['P2'])

    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    state.requested = []
    state.calls = []
    now += 4 * MINUTE
    await syncer.sync()
    expect(state.calls).not.toContain('requested')
    now += MINUTE
    await syncer.sync()
    expect(state.calls).toContain('requested')
    expect(store.me.requested.size).toBe(0)
  })
})

describe('Syncer after review', () => {
  it("waits its turn for a pull request GitHub doesn't return, instead of asking every minute", async () => {
    const { state, syncer } = await setup()
    await syncer.sync()
    state.hiddenStatus = ['P2']
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const checks: number[] = []
    for (let minute = 0; minute < 20; minute++) {
      now += MINUTE
      state.calls = []
      await syncer.sync()
      checks.push(state.calls.filter((call) => call === 'checks').length)
    }
    // Only the fifteen-minute turn of a passing pull request.
    expect(checks.reduce((sum, n) => sum + n, 0)).toBe(1)
  })

  it("prunes one kind's open items while GitHub hides the other kind's list", async () => {
    const { store, state, syncer } = await setup()
    await syncer.sync()
    state.issues = state.issues.filter((node) => node.id !== 'I1')
    state.issues.push(raw('I5', 'OPEN', ago(1)))
    state.missing = { I1: 'NOT_FOUND', P2: 'NOT_FOUND' }
    state.hidden = ['pullRequests']
    const later = Date.now() + HOUR
    vi.spyOn(Date, 'now').mockImplementation(() => later)
    await syncer.sync(true)
    expect(store.items.has('I1')).toBe(false)
    expect(store.items.has('P2')).toBe(true)
  })

  it('asks who the viewer is again when a workspace opens, since its token may have changed', async () => {
    // What another account's token saved a moment ago.
    const cache = {
      ...emptyCache(ws.id, sourcesKey(ws.sources)),
      login: 'someone-else',
      requested: ['P9'],
      requestedAt: Date.now(),
    }
    const { gh, state } = fakeGitHub()
    const store: SyncStore = {
      repos: new Map(),
      items: new Map(),
      me: { login: null, requested: new Set() },
      changed: () => {},
    }
    saved.cache = cache
    const syncer = await Syncer.open(ws, gh, store, idleStatus())
    await syncer.start()
    expect(state.calls).toContain('requested')
    expect(store.me).toEqual({ login: 'ali', requested: new Set() })
  })
})

// The workspace with only these repositories of the organization picked, and an item changed just now in one.
const picking = (...only: string[]): Workspace => ({ ...ws, sources: [{ kind: 'org', name: 'acme', only }] })
const change = (id: string, repo: string) => ({
  ...raw(id, 'OPEN', new Date().toISOString()),
  repository: { id: repo },
})

// The window a search for changes looks back over, from one second on.
const sinceOf = (q: string) => /updated:>=(\S+)/.exec(q)?.[1]

describe('Syncer searching for changes', () => {
  it('searches the issues and the pull requests apart, over the same window, once each', async () => {
    const { state, syncer } = await setup()
    await syncer.sync()
    state.queries = []
    await syncer.sync()
    const since = sinceOf(state.queries[0] ?? '')
    expect(since).toBeDefined()
    expect(state.queries).toEqual([`org:acme is:issue updated:>=${since}`, `org:acme is:pr updated:>=${since}`])
  })

  it('pages through each search with its own cursor', async () => {
    const fake = await setup()
    const { store, state, syncer } = fake
    await syncer.sync()
    const now = new Date().toISOString()
    state.searchResults = [
      raw('I1', 'CLOSED', now),
      raw('I3', 'OPEN', now),
      raw('P2', 'MERGED', now, true),
      raw('P4', 'CLOSED', now, true),
    ]
    state.searchPage = 1
    const pages: string[] = []
    const query = fake.gh.query.bind(fake.gh)
    fake.gh.query = async <T>(text: string, variables: Record<string, unknown> = {}) => {
      if (text === SEARCH)
        pages.push(`${/is:\w+/.exec(variables.q as string)?.[0]} ${(variables.after as string | null) ?? 'first'}`)
      return query<T>(text, variables)
    }
    await syncer.sync()
    expect(pages).toEqual(['is:issue first', 'is:issue 1', 'is:pr first', 'is:pr 1'])
    expect(['I1', 'I3', 'P2', 'P4'].map((id) => store.items.get(id)?.state)).toEqual([
      'closed',
      'open',
      'merged',
      'closed',
    ])
  })

  it('looks back as far again after the pull requests’ search fails, taking nothing from the issues’', async () => {
    const fake = await setup()
    const { store, state, status, syncer } = fake
    await syncer.sync()
    const start = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => start + 2 * MINUTE)
    state.searchResults = [raw('I1', 'CLOSED', new Date(start + MINUTE).toISOString())]
    let failing = true
    const query = fake.gh.query.bind(fake.gh)
    fake.gh.query = async <T>(text: string, variables: Record<string, unknown> = {}) => {
      if (failing && text === SEARCH && (variables.q as string).includes('is:pr'))
        throw new GitHubError('GitHub answered 502', 'server')
      return query<T>(text, variables)
    }
    state.queries = []
    await syncer.sync()
    expect(status.error).toBe('server')
    // Nothing of a look that didn't finish is taken.
    expect(store.items.get('I1')?.state).toBe('open')
    const [failed] = state.queries.map(sinceOf)

    vi.spyOn(Date, 'now').mockImplementation(() => start + 4 * MINUTE)
    failing = false
    state.queries = []
    await syncer.sync()
    expect(state.queries.map(sinceOf)).toEqual([failed, failed])
    expect(store.items.get('I1')?.state).toBe('closed')
  })
})

describe('Syncer with only some repositories picked', () => {
  it('reads only the repositories picked', async () => {
    const { store, state, syncer } = await setup(picking('R1'))
    state.more = ['api']
    await syncer.sync()
    expect([...store.repos.keys()]).toEqual(['R1'])
    expect(new Set(state.itemsOf)).toEqual(new Set(['web']))
  })

  it('drops changes in repositories left out, and reads the repositories again for them only once', async () => {
    const { store, state, syncer, fresh } = await setup(picking('R1'))
    state.more = ['api']
    await syncer.sync()
    state.searchResults = [change('I9', 'api')]
    state.calls = []
    await syncer.sync()
    expect(state.calls).toEqual([...LOOK, 'repos'])
    state.calls = []
    await syncer.sync()
    expect(state.calls).not.toContain('repos')
    expect(store.items.has('I9')).toBe(false)
    expect(fresh).toEqual([])
  })

  it('searches the one repository picked for a second that holds more changes than a search lists, and counts only its own', async () => {
    const fake = await setup(picking('R1'))
    const { state, store, syncer } = fake
    state.more = ['api']
    await syncer.sync()
    await vi.waitFor(() => expect(fake.status.historyDone).toBe(true))
    const now = Date.now() + MINUTE
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fake.gh.probe = async () => 'changed'
    // 1,001 issues opened in one second in a repository left out.
    const once = new Date(now - 30 * 1000).toISOString()
    state.searchResults = Array.from({ length: 1001 }, (_, index) => ({
      ...raw(`I${100 + index}`, 'OPEN', once),
      repository: { id: 'api' },
    }))
    state.itemsOf = []
    await syncer.sync()
    syncer.stop()
    expect(store.repos.get('R1')?.openIssues).toBe(1)
    expect(state.itemsOf).toEqual([])
  })

  it('still adds a new repository of an account that brings all of them', async () => {
    const { store, state, syncer } = await setup()
    await syncer.sync()
    state.more = ['api']
    state.searchResults = [change('I9', 'api')]
    await syncer.sync()
    expect(store.repos.has('api')).toBe(true)
    expect(store.items.has('I9')).toBe(true)
  })

  it('drops what the sources no longer bring as soon as the workspace opens, and reloads it all when picked again', async () => {
    const { gh, state } = fakeGitHub()
    state.more = ['api']
    saved.cache = emptyCache(ws.id, '')
    const open = async (...only: string[]) => {
      const store: SyncStore = { repos: new Map(), items: new Map(), me: noOne(), changed: () => {} }
      const status = idleStatus()
      const syncer = await Syncer.open(picking(...only), gh, store, status)
      let shown: string[] | null = null
      state.onQuery = () => (shown ??= [...store.repos.keys()])
      await syncer.start()
      syncer.stop()
      expect(status.historyDone).toBe(true)
      return { store, shown }
    }
    expect([...(await open('R1')).store.items.keys()].toSorted()).toEqual(['I1', 'I3', 'P2', 'P4'])
    const other = await open('api')
    expect(other.shown).toEqual([])
    expect([...other.store.items.keys()].toSorted()).toEqual(['api-I1', 'api-I3', 'api-P2', 'api-P4'])
    // Its closed history too, which it had loaded before it was left out.
    expect([...(await open('R1')).store.items.keys()].toSorted()).toEqual(['I1', 'I3', 'P2', 'P4'])
  })
})

// A workspace past its first sync, and a minute passing in it: which searches and free checks each minute made.
async function settled() {
  const test = await setup()
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const minute = async (manual = false) => {
    now += MINUTE
    test.state.calls = []
    await test.syncer.sync(manual)
    return test.state.calls.filter((call) => call === 'search' || call === 'probe')
  }
  await test.syncer.sync()
  return { ...test, minute }
}
describe('Syncer in a quiet workspace', () => {
  const ORG = '/orgs/acme/issues?state=all&sort=updated&direction=desc&per_page=1&filter=all'
  const REPO = '/repos/acme/web/issues?state=all&sort=updated&direction=desc&per_page=1'

  it('skips the search while GitHub says nothing changed, and searches at least every five minutes', async () => {
    const { minute } = await settled()
    expect(await minute()).toEqual(LOOK)
    // The first question has nothing to compare with yet.
    expect(await minute()).toEqual(['probe', ...LOOK])
    expect(await minute()).toEqual(['probe'])
    expect(await minute()).toEqual(['probe'])
    expect(await minute()).toEqual(['probe'])
    expect(await minute()).toEqual(['probe'])
    expect(await minute()).toEqual(LOOK)
    // A refresh always searches.
    expect(await minute(true)).toEqual(LOOK)
  })

  it('searches when GitHub says something changed, and keeps searching while search catches up', async () => {
    const { state, minute } = await settled()
    await minute()
    await minute()
    expect(await minute()).toEqual(['probe'])
    state.probes[ORG] = 'changed'
    expect(await minute()).toEqual(['probe', ...LOOK])
    state.probes[ORG] = 'same'
    expect(await minute()).toEqual(LOOK)
    expect(await minute()).toEqual(LOOK)
    expect(await minute()).toEqual(['probe'])
  })

  it("doesn't ask while searches keep finding changes", async () => {
    const { state, minute } = await settled()
    await minute()
    state.searchResults = [raw('I1', 'OPEN', new Date(Date.now() + MINUTE).toISOString())]
    expect(await minute()).toEqual(['probe', ...LOOK])
    expect(await minute()).toEqual(LOOK)
    // That search found nothing new, so the next minute asks first.
    expect(await minute()).toEqual(['probe'])
  })

  it("asks about each repository when the token can't read the organization's list", async () => {
    const { state, minute } = await settled()
    await minute()
    state.probes[ORG] = 'unsupported'
    expect(await minute()).toEqual(['probe', ...LOOK])
    state.probed = []
    expect(await minute()).toEqual(['probe', ...LOOK])
    expect(await minute()).toEqual(['probe'])
    expect(state.probed).toEqual([REPO, REPO])
  })

  it("only searches once a repository can't be asked either", async () => {
    const { state, minute } = await settled()
    await minute()
    state.probes[ORG] = 'unsupported'
    state.probes[REPO] = 'unsupported'
    expect(await minute()).toEqual(['probe', ...LOOK])
    expect(await minute()).toEqual(['probe', ...LOOK])
    expect(await minute()).toEqual(LOOK)
    expect(await minute()).toEqual(LOOK)
  })
})
