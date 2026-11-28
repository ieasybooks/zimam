import type { Repo, RepoBasics, Source } from '@/types'

import { GitHubError, type GitHub, type QueryError } from './github'
import {
  CONTRIBUTED,
  ONE_REPO,
  opened,
  ORG_REPOS,
  OWNER,
  toRepo,
  toRepoBasics,
  USER_REPOS,
  VIEWER,
  type Page,
  type RawRepo,
  type RawRepoBasics,
} from './queries'

interface Owner {
  login: string
  name: string | null
  avatarUrl: string
}

export interface Viewer extends Owner {
  organizations: Owner[]
}

export interface SourceChoice {
  source: Source
  label: string
  avatar?: string
}

/** What tells a source apart. GitHub doesn't mind the case of a name. */
export const sourceKey = (source: Source) => `${source.kind}:${source.name.toLowerCase()}`

export const sameSource = (a: Source, b: Source) => sourceKey(a) === sourceKey(b)

/** Whether a repository, by its `owner/name`, belongs to a source: it is the source, or its owner is. */
export function belongsTo(fullName: string, source: Source): boolean {
  const name = source.name.toLowerCase()
  const repo = fullName.toLowerCase()
  return source.kind === 'repo' ? repo === name : repo.split('/')[0] === name
}

/** Whether a source brings a repository into its workspace: it belongs to the source, and was picked if any were. */
export function brings(source: Source, repo: RepoBasics): boolean {
  return belongsTo(repo.fullName, source) && (!source.only || source.only.includes(repo.id))
}

/** The search qualifier that finds a source's issues and pull requests, such as `org:acme`. */
export function qualifier(source: Source): string {
  return `${source.kind}:${source.name}`
}

export function sourcesKey(sources: Source[]): string {
  return JSON.stringify(sources)
}

export async function findViewer(gh: GitHub): Promise<Viewer> {
  const { viewer } = await gh.query<{ viewer: Owner & { organizations: { nodes: Owner[] } } }>(VIEWER)
  return { ...viewer, organizations: viewer.organizations.nodes }
}

/** Looks up what someone typed or pasted: an owner, `owner/repo`, or a github.com link to either. */
export async function findSource(gh: GitHub, typed: string): Promise<SourceChoice | null> {
  const value = typed
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\/+$/, '')
  if (!value) return null
  if (value.includes('/')) {
    const [owner, name] = value.split('/')
    const { repository } = await gh.query<{ repository: RawRepo | null }>(ONE_REPO, { owner, name })
    return repository && { source: { kind: 'repo', name: repository.nameWithOwner }, label: repository.nameWithOwner }
  }
  const { repositoryOwner: owner } = await gh.query<{
    repositoryOwner: { kind: string; login: string; avatarUrl: string } | null
  }>(OWNER, { login: value })
  if (!owner) return null
  const kind = owner.kind === 'Organization' ? 'org' : 'user'
  return { source: { kind, name: owner.login }, label: owner.login, avatar: owner.avatarUrl }
}

/** Every repository a source covers. A source GitHub can't find throws a `query` error. */
export async function reposOf(gh: GitHub, source: Source): Promise<Repo[]> {
  if (source.kind === 'repo') {
    const [owner, name] = source.name.split('/')
    const data = await gh.query<{ repository: RawRepo | null }>(ONE_REPO, { owner, name })
    if (!data.repository) throw new GitHubError(source.name, 'query')
    return [toRepo(data.repository)]
  }
  const key = source.kind === 'org' ? 'organization' : 'user'
  const repos: Repo[] = []
  let after: string | null = null
  do {
    const data: Record<string, { repositories: Page<RawRepo | null> } | null> = await gh.query(
      source.kind === 'org' ? ORG_REPOS : USER_REPOS,
      { login: source.name, after },
    )
    const owner = data[key]
    if (!owner) throw new GitHubError(source.name, 'query')
    for (const raw of owner.repositories.nodes) if (raw) repos.push(toRepo(raw))
    after = owner.repositories.pageInfo.hasNextPage ? owner.repositories.pageInfo.endCursor : null
  } while (after)
  return repos
}

export const CONTRIBUTION_KINDS = ['commit', 'pr', 'issue', 'review'] as const
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number]

/** A repository someone contributed to: how, how many pull requests and issues they opened in it, and when last. */
export interface Contribution {
  repo: RepoBasics
  kinds: ContributionKind[]
  prs: number
  issues: number
  /** When they last opened a pull request or issue in it. Unknown for commits and reviews alone. */
  lastAt: string | null
}

/** How many pages of 100 of what someone opened are read, the latest first. */
export const OPENED_PAGES = 10

export type OpenedKind = Extract<ContributionKind, 'pr' | 'issue'>

/** The repositories someone contributed to, and how much of what GitHub knows reached them. */
export interface Discovery {
  contributions: Contribution[]
  /**
   * Some repositories may be missing: GitHub listed more recent commits or reviews than it gives, or what they opened
   * went on past the pages read. Recent pull requests and issues past the cap don't count: their history finds them.
   */
  reposCut: boolean
  /** What they opened went on past the pages read, so its counts, in all and in each repository, are at least these. */
  countsCut: OpenedKind[]
}

// A repository the token may not read, or that is gone, is only left out: GitHub says so under `nodes`. Any other
// error, about a list or an item in it, means something wasn't read that should have been.
const LEFT_OUT = new Set(['FORBIDDEN', 'NOT_FOUND'])
const unread = (errors: QueryError[]) =>
  errors.some((error) => !(LEFT_OUT.has(error.type ?? '') && error.path?.includes('nodes')))

/**
 * The repositories someone contributed to, that the token can read. GitHub lists the recent ones by kind of
 * contribution, 100 of each at most, and what they opened finds the older ones. A list GitHub doesn't give throws a
 * `query` error, to try again, rather than passing for an empty one. `signal` stops it between requests.
 */
export async function contributionsOf(gh: GitHub, login: string, signal?: AbortSignal): Promise<Discovery> {
  const ask = async <T>(text: string, variables: Record<string, unknown>) => {
    signal?.throwIfAborted()
    const answer = await gh.request<T>(text, variables)
    signal?.throwIfAborted()
    if (unread(answer.errors)) throw new GitHubError(answer.errors[0].message, 'query')
    return answer.data
  }
  const found = new Map<string, Contribution>()
  const add = (raw: RawRepoBasics, kind: ContributionKind) => {
    let entry = found.get(raw.id)
    if (!entry) found.set(raw.id, (entry = { repo: toRepoBasics(raw), kinds: [], prs: 0, issues: 0, lastAt: null }))
    if (!entry.kinds.includes(kind)) entry.kinds.push(kind)
    return entry
  }
  type User<T> = { user: T | null }
  type Listed = { totalCount: number; nodes: (RawRepoBasics | null)[] } | null
  const recent = (await ask<User<Record<ContributionKind, Listed>>>(CONTRIBUTED, { login })).user
  if (!recent) throw new GitHubError(login, 'query')
  let reposCut = false
  for (const kind of CONTRIBUTION_KINDS) {
    const listed = recent[kind]
    if (!listed) throw new GitHubError(`${login}: ${kind}`, 'query')
    for (const raw of listed.nodes) if (raw) add(raw, kind)
    if ((kind === 'commit' || kind === 'review') && listed.totalCount > listed.nodes.length) reposCut = true
  }
  const countsCut: OpenedKind[] = []
  for (const [kind, list] of [
    ['pr', 'pullRequests'],
    ['issue', 'issues'],
  ] as const) {
    let after: string | null = null
    for (let pages = 0; pages < OPENED_PAGES; pages++) {
      type Opened = { createdAt: string; repository: RawRepoBasics | null } | null
      const page: Page<Opened> | undefined =
        (await ask<User<{ list: Page<Opened> | null }>>(opened(list), { login, after })).user?.list ?? undefined
      if (!page) throw new GitHubError(`${login}: ${list}`, 'query')
      for (const node of page.nodes) {
        if (!node?.repository) continue
        const entry = add(node.repository, kind)
        if (kind === 'pr') entry.prs++
        else entry.issues++
        if (!entry.lastAt || node.createdAt > entry.lastAt) entry.lastAt = node.createdAt
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
      if (!after) break
    }
    if (after !== null) countsCut.push(kind)
  }
  for (const entry of found.values())
    entry.kinds.sort((a, b) => CONTRIBUTION_KINDS.indexOf(a) - CONTRIBUTION_KINDS.indexOf(b))
  return { contributions: [...found.values()], reposCut: reposCut || countsCut.length > 0, countsCut }
}
