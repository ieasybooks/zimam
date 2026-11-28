import { describe, expect, it, vi } from 'vitest'

import type { Answer, GitHub, QueryError } from '@/lib/github'
import { CONTRIBUTED, opened, type RawRepoBasics } from '@/lib/queries'
import { defaultContributionFilters, pickContributions } from '@/lib/repos'
import { contributionsOf, OPENED_PAGES, type Contribution } from '@/lib/sources'
import type { RepoBasics } from '@/types'

function raw(fullName: string, overrides: Partial<RawRepoBasics> = {}): RawRepoBasics {
  const [owner, name] = fullName.split('/')
  return {
    id: fullName,
    name,
    nameWithOwner: fullName,
    description: null,
    isPrivate: false,
    isArchived: false,
    pushedAt: null,
    owner: { login: owner, avatarUrl: '' },
    primaryLanguage: null,
    ...overrides,
  }
}

type Opened = { createdAt: string; repository: RawRepoBasics | null }
type List = 'pullRequests' | 'issues'

interface Story {
  /** Recent contributions by kind. A kind given as null comes back null, as a list GitHub didn't give. */
  recent?: Partial<Record<'commit' | 'pr' | 'issue' | 'review', (RawRepoBasics | null)[] | null>>
  /** How many GitHub says each recent kind has, when more than it gives. */
  totals?: Partial<Record<'commit' | 'pr' | 'issue' | 'review', number>>
  /** Pages of what was opened. A page given as null comes back without the person. */
  opened?: Partial<Record<List, (Opened[] | null)[]>>
  /** Errors GitHub sends with a page's data, by `list:page`. */
  errors?: Record<string, QueryError[]>
}

const done = <T>(data: T, errors: QueryError[] = []): Answer<T> => ({ data, errors })

/** A GitHub that tells `story`, and notes each request as `recent` or `list:page`. */
function github(story: Story, wait?: (call: string) => Promise<void>): GitHub & { asked: string[] } {
  const asked: string[] = []
  const request = async (text: string, variables: Record<string, unknown> = {}) => {
    if (text === CONTRIBUTED) {
      asked.push('recent')
      await wait?.('recent')
      const user = Object.fromEntries(
        (['commit', 'pr', 'issue', 'review'] as const).map((kind) => {
          const list = story.recent?.[kind]
          if (list === null) return [kind, null]
          const nodes = list ?? []
          return [kind, { totalCount: story.totals?.[kind] ?? nodes.length, nodes }]
        }),
      )
      return done({ user }, story.errors?.recent)
    }
    const list: List = text.includes('list: pullRequests') ? 'pullRequests' : 'issues'
    const index = Number(variables.after ?? 0)
    const call = `${list}:${index}`
    asked.push(call)
    await wait?.(call)
    const pages = story.opened?.[list] ?? [[]]
    const nodes = pages[index]
    if (nodes === null) return done({ user: null }, story.errors?.[call])
    const hasNextPage = index + 1 < pages.length
    const page = { pageInfo: { hasNextPage, endCursor: hasNextPage ? String(index + 1) : null }, nodes: nodes ?? [] }
    return done({ user: { list: page } }, story.errors?.[call])
  }
  return {
    asked,
    request,
    query: async (...args: Parameters<typeof request>) => (await request(...args)).data,
  } as never
}

/** A promise to settle by hand. */
function deferred() {
  const settle: { resolve?: () => void } = {}
  const promise = new Promise<void>((settled) => (settle.resolve = settled))
  return { promise, resolve: () => settle.resolve?.() }
}

const at = (createdAt: string, repository: RawRepoBasics | null): Opened => ({ createdAt, repository })

describe('contributionsOf', () => {
  // GitHub works out a repository's counts in each repository, and refuses a query with a few hundred of them.
  it('asks for no counts of the repositories it lists', () => {
    for (const text of [CONTRIBUTED, opened('pullRequests'), opened('issues')])
      expect(text).not.toMatch(/openIssues|openPrs|allIssues|allPrs/)
  })

  it('merges the recent contributions by kind with what was opened, by repository', async () => {
    const web = raw('acme/web')
    const api = raw('nuxt/api')
    const old = raw('old/tool')
    const gh = github({
      recent: { commit: [web, null], pr: [web, api], review: [api] },
      opened: {
        pullRequests: [
          [
            at('2026-03-01T00:00:00Z', api),
            at('2026-05-01T00:00:00Z', api),
            at('2020-01-01T00:00:00Z', old),
            at('2026-01-01T00:00:00Z', null),
          ],
        ],
        issues: [[at('2026-04-01T00:00:00Z', web)]],
      },
    })
    const { contributions, reposCut, countsCut } = await contributionsOf(gh, 'ali')
    expect({ reposCut, countsCut }).toEqual({ reposCut: false, countsCut: [] })
    const byName = Object.fromEntries(contributions.map((found) => [found.repo.fullName, found]))
    expect(Object.keys(byName).toSorted()).toEqual(['acme/web', 'nuxt/api', 'old/tool'])
    expect(byName['acme/web']).toMatchObject({
      kinds: ['commit', 'pr', 'issue'],
      prs: 0,
      issues: 1,
      lastAt: '2026-04-01T00:00:00Z',
    })
    expect(byName['nuxt/api']).toMatchObject({ kinds: ['pr', 'review'], prs: 2, lastAt: '2026-05-01T00:00:00Z' })
    expect(byName['old/tool']).toMatchObject({ kinds: ['pr'], prs: 1 })
  })

  it('takes an empty history as complete', async () => {
    const gh = github({ opened: { pullRequests: [[]], issues: [[]] } })
    expect(await contributionsOf(gh, 'ali')).toEqual({ contributions: [], reposCut: false, countsCut: [] })
  })

  it('counts exactly when the history reads every pull request, though the recent list was cut', async () => {
    const repos = Array.from({ length: 101 }, (_, index) => raw(`acme/r${index}`))
    const gh = github({
      recent: { pr: repos.slice(0, 100) },
      totals: { pr: 101 },
      opened: {
        pullRequests: [
          repos.slice(0, 100).map((repo) => at('2026-01-01T00:00:00Z', repo)),
          [at('2025-01-01T00:00:00Z', repos[100])],
        ],
      },
    })
    const { contributions, reposCut, countsCut } = await contributionsOf(gh, 'ali')
    expect({ reposCut, countsCut }).toEqual({ reposCut: false, countsCut: [] })
    expect(contributions).toHaveLength(101)
    expect(contributions.reduce((sum, found) => sum + found.prs, 0)).toBe(101)
  })

  it('says repositories may be missing when recent commits or reviews were cut', async () => {
    const gh = github({ recent: { review: [raw('acme/web')] }, totals: { review: 120 } })
    expect(await contributionsOf(gh, 'ali')).toMatchObject({ reposCut: true, countsCut: [] })
  })

  it('stops after its pages of what was opened, and says those counts are at least what was read', async () => {
    const web = raw('acme/web')
    const page = [at('2026-01-01T00:00:00Z', web)]
    const gh = github({ opened: { pullRequests: Array.from({ length: OPENED_PAGES + 2 }, () => page) } })
    const { contributions, reposCut, countsCut } = await contributionsOf(gh, 'ali')
    expect({ reposCut, countsCut }).toEqual({ reposCut: true, countsCut: ['pr'] })
    expect(contributions[0].prs).toBe(OPENED_PAGES)
    expect(gh.asked.filter((call) => call.startsWith('pullRequests'))).toHaveLength(OPENED_PAGES)
  })

  it.each([
    ['the first page of the history', { opened: { pullRequests: [null] } }],
    [
      'a page after one that was read',
      { opened: { pullRequests: [[at('2026-01-01T00:00:00Z', raw('acme/web'))], null] } },
    ],
    ['a recent kind', { recent: { commit: null } }],
    [
      'a page GitHub sends with an error about the list',
      { errors: { 'issues:0': [{ type: 'INTERNAL', message: 'Something went wrong', path: ['user', 'list'] }] } },
    ],
  ] satisfies [string, Story][])('fails, to try again, when GitHub doesn’t give %s', async (_, story) => {
    await expect(contributionsOf(github(story), 'ali')).rejects.toMatchObject({ kind: 'query' })
  })

  it('leaves out a repository it can’t read, with or without an error about it', async () => {
    const web = raw('acme/web')
    const gh = github({
      recent: { commit: [null, web] },
      opened: { issues: [[at('2026-01-01T00:00:00Z', null), at('2026-02-01T00:00:00Z', web)]] },
      errors: {
        'issues:0': [{ type: 'FORBIDDEN', message: 'No access', path: ['user', 'list', 'nodes', 0, 'repository'] }],
      },
    })
    const { contributions } = await contributionsOf(gh, 'ali')
    expect(contributions.map((found) => [found.repo.fullName, found.issues])).toEqual([['acme/web', 1]])
  })

  // Where GitHub would say a repository can't be read: in the recent list, and in the history.
  const NODE_ERRORS: { where: string; story: Story; call: string; path: (string | number)[] }[] = [
    {
      where: 'recent',
      story: { recent: { commit: [null, raw('acme/web')] } },
      call: 'recent',
      path: ['user', 'commit', 'nodes', 0],
    },
    {
      where: 'history',
      story: {
        opened: { pullRequests: [[at('2026-01-01T00:00:00Z', null), at('2026-02-01T00:00:00Z', raw('acme/web'))]] },
      },
      call: 'pullRequests:0',
      path: ['user', 'list', 'nodes', 0, 'repository'],
    },
  ]
  const told = ({ story, call, path }: (typeof NODE_ERRORS)[number], type: string) =>
    github({ ...story, errors: { [call]: [{ type, message: type, path }] } })

  it.each(
    NODE_ERRORS.flatMap((place) => ['FORBIDDEN', 'NOT_FOUND'].map((type) => [place.where, type, place] as const)),
  )('leaves out a repository the %s list says is %s, and reads on', async (_, type, place) => {
    const { contributions, reposCut, countsCut } = await contributionsOf(told(place, type), 'ali')
    expect(contributions.map((found) => found.repo.fullName)).toEqual(['acme/web'])
    expect({ reposCut, countsCut }).toEqual({ reposCut: false, countsCut: [] })
  })

  it.each(NODE_ERRORS.map((place) => [place.where, place] as const))(
    'fails, to try again, on an unexpected error about an item in the %s list',
    async (_, place) => {
      await expect(contributionsOf(told(place, 'INTERNAL'), 'ali')).rejects.toMatchObject({ kind: 'query' })
    },
  )

  it('asks for no more pages once stopped, and gives nothing', async () => {
    const page = [at('2026-01-01T00:00:00Z', raw('acme/web'))]
    const { promise: pending, resolve: release } = deferred()
    const gh = github({ opened: { pullRequests: [page, page, page] } }, (call) =>
      call === 'pullRequests:0' ? pending : Promise.resolve(),
    )
    const controller = new AbortController()
    const discovery = contributionsOf(gh, 'ali', controller.signal)
    await vi.waitFor(() => expect(gh.asked).toContain('pullRequests:0'))
    controller.abort()
    release()
    await expect(discovery).rejects.toThrow()
    expect(gh.asked).toEqual(['recent', 'pullRequests:0'])
  })
})

function entry(fullName: string, overrides: Partial<Contribution> = {}, repo: Partial<RepoBasics> = {}): Contribution {
  const [owner, name] = fullName.split('/')
  return {
    repo: {
      id: fullName,
      owner,
      ownerAvatar: '',
      name,
      fullName,
      description: null,
      language: null,
      isPrivate: false,
      isArchived: false,
      pushedAt: null,
      ...repo,
    },
    kinds: ['pr'],
    prs: 1,
    issues: 0,
    lastAt: null,
    ...overrides,
  }
}

const names = (shown: Contribution[]) => shown.map((each) => each.repo.fullName)

describe('pickContributions', () => {
  const list = [
    entry('acme/web', { kinds: ['commit'], prs: 0, lastAt: null }, { pushedAt: '2026-06-01T00:00:00Z' }),
    entry('acme/api', { kinds: ['pr', 'issue'], prs: 5, issues: 2, lastAt: '2026-02-01T00:00:00Z' }),
    entry('nuxt/nuxt', { kinds: ['pr', 'review'], prs: 1, lastAt: '2026-09-01T00:00:00Z' }, { description: 'Vue' }),
    entry('old/tool', { kinds: ['issue'], prs: 0, issues: 1, lastAt: '2026-10-01T00:00:00Z' }, { isArchived: true }),
  ]
  const pick = (filters: Partial<ReturnType<typeof defaultContributionFilters>>) =>
    pickContributions(list, { ...defaultContributionFilters(), ...filters })

  it('shows the active ones, the last opened first, and those without a date after them', () => {
    expect(names(pick({}).shown)).toEqual(['nuxt/nuxt', 'acme/api', 'acme/web'])
  })

  it('sorts by what was opened most, or by name', () => {
    expect(names(pick({ sort: 'most', status: [] }).shown)).toEqual(['acme/api', 'nuxt/nuxt', 'old/tool', 'acme/web'])
    expect(names(pick({ sort: 'name', status: [] }).shown)).toEqual(['acme/api', 'acme/web', 'nuxt/nuxt', 'old/tool'])
  })

  it('searches full names and descriptions', () => {
    expect(names(pick({ q: 'vue' }).shown)).toEqual(['nuxt/nuxt'])
    expect(names(pick({ q: 'acme/' }).shown)).toEqual(['acme/api', 'acme/web'])
  })

  it('keeps any of the kinds picked, and counts each facet with the others applied', () => {
    const { shown, kinds, owners, statuses } = pick({ kinds: ['review', 'commit'], owners: ['acme'] })
    expect(names(shown)).toEqual(['acme/web'])
    expect(kinds).toEqual({ commit: 1, pr: 1, issue: 1, review: 0 })
    expect(Object.fromEntries([...owners].map(([owner, { count }]) => [owner, count]))).toEqual({ acme: 1, nuxt: 1 })
    expect(statuses).toEqual({ active: 1, archived: 0 })
    expect(pick({ owners: ['old'] }).statuses).toEqual({ active: 0, archived: 1 })
  })

  it('keeps a picked account in the menu with nothing matching, to unpick it with the search kept', () => {
    const filters = { ...defaultContributionFilters(), q: 'nuxt', owners: ['acme'], kinds: ['pr' as const] }
    const { shown, owners } = pickContributions(list, filters)
    expect(shown).toEqual([])
    expect(owners.get('acme')).toEqual({ count: 0, avatar: '' })
    expect(owners.get('nuxt')?.count).toBe(1)
    filters.owners = filters.owners.filter((owner) => owner !== 'acme')
    expect(names(pickContributions(list, filters).shown)).toEqual(['nuxt/nuxt'])
    expect(filters.q).toBe('nuxt')
  })
})
