import type { Item, Repo, RepoBasics } from '@/types'

import {
  defaultFilters,
  matcher,
  pickChoice,
  REPO_STATUSES,
  statusOf,
  timesOf,
  type Context,
  type Filters,
  type RepoStatus,
} from './filters'
import { KINDS, LIST_KINDS } from './queries'
import { CONTRIBUTION_KINDS, type Contribution, type ContributionKind } from './sources'
import type { SyncStatus } from './sync'
import { normalize } from './text'

const WEEK = 7 * 86_400_000
/** How many weeks of new issues and pull requests each repository shows: about six months. */
export const WEEKS = 26

interface CountOf {
  /** The list that shows what it counts. */
  filters: Partial<Filters>
  /**
   * GitHub's own total, which counts while the repository's open items load, and when GitHub didn't show those of their
   * kind. Every count tallies the items read so far that match the filters once they have: the total is only as fresh
   * as the last read of the repositories.
   */
  total?: (repo: Repo) => number
}

/** What each repository counts, in the order of its columns. */
export const COUNTS = {
  issues: { filters: { kind: ['issue'] }, total: (repo) => repo.openIssues },
  prs: { filters: { kind: ['pr'] }, total: (repo) => repo.openPrs },
  awaiting: { filters: { kind: ['pr'], review: ['required'] } },
  failing: { filters: { kind: ['pr'], checks: ['failure'] } },
  conflicts: { filters: { kind: ['pr'], merge: ['conflicts'] } },
} satisfies Record<string, CountOf>

export type Count = keyof typeof COUNTS

export const COUNT_KEYS = Object.keys(COUNTS) as Count[]

/** The counts that come from the items read so far alone, with no total from GitHub to show while they load. */
export const TALLIED = COUNT_KEYS.filter((key) => !(COUNTS[key] as CountOf).total)

export type RepoSort = 'activity' | 'name' | Count

export const REPO_SORTS: readonly RepoSort[] = ['activity', 'name', ...COUNT_KEYS]

export interface RepoRow {
  repo: Repo
  counts: Record<Count, number>
  /** The last push, or the last change to one of its issues or pull requests, whichever came later. */
  activeAt: number
  /** Issues and pull requests opened in each of the last WEEKS weeks, oldest first. The last week ends now. */
  weeks: number[]
  /** Its open pull requests haven't loaded yet, so the tallied counts aren't known. */
  countsLoading: boolean
  /** Some of what was opened in it over the last WEEKS weeks may not have loaded yet. */
  weeksLoading: boolean
}

export interface RepoFilters {
  q: string
  /** None picked means both. */
  status: RepoStatus[]
  sort: RepoSort
}

export function defaultRepoFilters(): RepoFilters {
  return { q: '', status: ['active'], sort: 'activity' }
}

/** Whether a search or a status other than the default narrows the repositories. */
export const isFiltered = ({ q, status }: Pick<RepoFilters, 'q' | 'status'>) =>
  q.trim() !== '' || status.join() !== defaultRepoFilters().status.join()

/**
 * Counted as the list counts, in `ctx`, with what each repository still has to load and what GitHub didn't show of it,
 * as the sync says.
 */
export function repoRows(
  items: Iterable<Item>,
  ctx: Context,
  { left = {}, hidden = {} }: Partial<Pick<SyncStatus, 'left' | 'hidden'>> = {},
): RepoRow[] {
  const { now } = ctx
  const tallies = new Map<string, { row: RepoRow; oldestClosed: Record<Item['kind'], number> }>()
  for (const repo of ctx.repos.values()) {
    const pushedAt = repo.pushedAt ? Date.parse(repo.pushedAt) : 0
    const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) as Record<Count, number>
    const row: RepoRow = {
      repo,
      counts,
      activeAt: pushedAt,
      weeks: Array<number>(WEEKS).fill(0),
      countsLoading: false,
      weeksLoading: false,
    }
    tallies.set(repo.id, { row, oldestClosed: { issue: Infinity, pr: Infinity } })
  }
  // In an archived repository too, so the counts don't depend on the list's default of active ones.
  const tallied = COUNT_KEYS.map(
    (key) => [key, matcher({ ...defaultFilters(), status: [], ...COUNTS[key].filters }, ctx)] as const,
  )
  for (const item of items) {
    const tally = tallies.get(item.repoId)
    if (!tally) continue
    const { row } = tally
    const { updated: updatedAt, created } = timesOf(item)
    row.activeAt = Math.max(row.activeAt, updatedAt)
    const week = Math.floor((now - created) / WEEK)
    if (week >= 0 && week < WEEKS) row.weeks[WEEKS - 1 - week]++
    if (item.state !== 'open') {
      tally.oldestClosed[item.kind] = Math.min(tally.oldestClosed[item.kind], updatedAt)
      continue
    }
    for (const [key, counts] of tallied) if (counts(item)) row.counts[key]++
  }
  // The closed history loads the latest change first. Nothing changes before it is opened, so once it reaches a change
  // from before the first week shown, all that was opened since is in.
  const start = now - WEEKS * WEEK
  for (const { row, oldestClosed } of tallies.values()) {
    const kinds = left[row.repo.id] ?? []
    const open = kinds.includes('open')
    const unseen = hidden[row.repo.id] ?? []
    for (const key of COUNT_KEYS) {
      const { total, filters } = COUNTS[key] as CountOf
      if (total && (open || unseen.some((kind) => filters.kind?.includes(kind)))) row.counts[key] = total(row.repo)
    }
    if (!kinds.length) continue
    const { openIssues, openPrs } = row.repo
    row.countsLoading = open && openPrs > 0
    row.weeksLoading =
      (open && openIssues + openPrs > 0) ||
      LIST_KINDS.some((kind) => kinds.includes(kind) && oldestClosed[KINDS[kind].item] > start)
  }
  return [...tallies.values()].map((tally) => tally.row)
}

const searchText = new WeakMap<Repo, string>()

// The repositories page shows a repository's name and description, so its search reads both.
function pageText(repo: Repo): string {
  let text = searchText.get(repo)
  if (text === undefined) {
    text = normalize(`${repo.fullName} ${repo.description ?? ''}`)
    searchText.set(repo, text)
  }
  return text
}

const byName = (a: RepoRow, b: RepoRow) => a.repo.fullName.localeCompare(b.repo.fullName)
const most = (count: (row: RepoRow) => number) => (a: RepoRow, b: RepoRow) =>
  count(b) - count(a) || b.activeAt - a.activeAt || byName(a, b)

const ORDER = {
  activity: most((row) => row.activeAt),
  name: byName,
  ...Object.fromEntries(COUNT_KEYS.map((key) => [key, most((row) => row.counts[key])])),
} as Record<RepoSort, (a: RepoRow, b: RepoRow) => number>

/**
 * The rows the filters keep, with how many rows the search finds in each status. The pinned ones come first, in the
 * order of `pinned`, and the rest in the filters' order.
 */
export function pickRows(rows: RepoRow[], filters: RepoFilters, pinned: string[] = []) {
  const { kept: picked, counts } = findRepos(rows, (row) => row.repo, filters, pageText)
  const place = new Map(pinned.map((id, index) => [id, index]))
  const at = (row: RepoRow) => place.get(row.repo.id) ?? -1
  return {
    pinned: picked.filter((row) => at(row) >= 0).toSorted((a, b) => at(a) - at(b)),
    rest: picked.filter((row) => at(row) < 0).toSorted(ORDER[filters.sort]),
    counts,
  }
}

/**
 * What a search and a status pick keep of `entries`, with how many the search finds in each status. The search reads
 * `textOf`: what the list shows of a repository, normalized.
 */
export function findRepos<T, R extends RepoBasics>(
  entries: Iterable<T>,
  repoOf: (entry: T) => R,
  { q, status }: Pick<RepoFilters, 'q' | 'status'>,
  textOf: (repo: R) => string,
) {
  const terms = normalize(q).split(/\s+/).filter(Boolean)
  const counts: Record<RepoStatus, number> = { active: 0, archived: 0 }
  const kept: T[] = []
  for (const entry of entries) {
    const repo = repoOf(entry)
    if (terms.length && !terms.every((term) => textOf(repo).includes(term))) continue
    const each = statusOf(repo)
    counts[each]++
    if (!status.length || status.includes(each)) kept.push(entry)
  }
  return { kept, counts }
}

/** Puts the pinned repositories shown in the order given. Those a search hides keep their places. */
export function arrange(pinned: string[], shown: string[]): string[] {
  const moving = new Set(shown)
  const next = shown.values()
  return pinned.map((id) => (moving.has(id) ? (next.next().value ?? id) : id))
}

/** Picks or unpicks a status. Picking one drops the other. */
export function toggleStatus(filters: Pick<RepoFilters, 'status'>, status: RepoStatus) {
  filters.status = pickChoice(filters.status, status, REPO_STATUSES)
}

export const CONTRIBUTION_SORTS = ['recent', 'most', 'name'] as const
export type ContributionSort = (typeof CONTRIBUTION_SORTS)[number]

export interface ContributionFilters {
  q: string
  /** None picked means both. */
  status: RepoStatus[]
  /** Any of them. None picked means any contribution. */
  kinds: ContributionKind[]
  /** None picked means any owner. */
  owners: string[]
  sort: ContributionSort
}

export function defaultContributionFilters(): ContributionFilters {
  return { q: '', status: defaultRepoFilters().status, kinds: [], owners: [], sort: 'recent' }
}

const contributionText = new WeakMap<RepoBasics, string>()

// The picker shows a repository's full name and description, so its search reads both.
function pickerText(repo: RepoBasics): string {
  let text = contributionText.get(repo)
  if (text === undefined) {
    text = normalize(`${repo.fullName} ${repo.description ?? ''}`)
    contributionText.set(repo, text)
  }
  return text
}

const opened = (entry: Contribution) => entry.prs + entry.issues
const byFullName = (a: Contribution, b: Contribution) => a.repo.fullName.localeCompare(b.repo.fullName)

// Commits and reviews alone carry no date, so they come after what has one, the latest pushed first.
const CONTRIBUTION_ORDER: Record<ContributionSort, (a: Contribution, b: Contribution) => number> = {
  recent: (a, b) =>
    (b.lastAt ?? '').localeCompare(a.lastAt ?? '') ||
    (b.repo.pushedAt ?? '').localeCompare(a.repo.pushedAt ?? '') ||
    byFullName(a, b),
  most: (a, b) => opened(b) - opened(a) || b.kinds.length - a.kinds.length || byFullName(a, b),
  name: byFullName,
}

/**
 * The contributions the filters keep, in their order, with how many each status, kind and owner would keep. Each facet
 * counts with the others applied, as the list's do.
 */
export function pickContributions(entries: Contribution[], filters: ContributionFilters) {
  const { kept: searched } = findRepos(entries, (entry) => entry.repo, { q: filters.q, status: [] }, pickerText)
  const ofStatus = (entry: Contribution) => !filters.status.length || filters.status.includes(statusOf(entry.repo))
  const ofKind = (entry: Contribution) =>
    !filters.kinds.length || entry.kinds.some((kind) => filters.kinds.includes(kind))
  const ofOwner = (entry: Contribution) => !filters.owners.length || filters.owners.includes(entry.repo.owner)
  const statuses: Record<RepoStatus, number> = { active: 0, archived: 0 }
  const kinds = Object.fromEntries(CONTRIBUTION_KINDS.map((kind) => [kind, 0])) as Record<ContributionKind, number>
  const owners = new Map<string, { count: number; avatar: string }>()
  for (const entry of searched) {
    const [status, kind, owner] = [ofStatus(entry), ofKind(entry), ofOwner(entry)]
    if (kind && owner) statuses[statusOf(entry.repo)]++
    if (status && owner) for (const each of entry.kinds) kinds[each]++
    if (status && kind) {
      const tally = owners.get(entry.repo.owner) ?? { count: 0, avatar: entry.repo.ownerAvatar }
      tally.count++
      owners.set(entry.repo.owner, tally)
    }
  }
  // A picked account stays in the menu, to unpick, though nothing it has matches now.
  for (const owner of filters.owners) {
    if (owners.has(owner)) continue
    const avatar = entries.find((entry) => entry.repo.owner === owner)?.repo.ownerAvatar ?? ''
    owners.set(owner, { count: 0, avatar })
  }
  const shown = searched
    .filter((entry) => ofStatus(entry) && ofKind(entry) && ofOwner(entry))
    .toSorted(CONTRIBUTION_ORDER[filters.sort])
  return { shown, statuses, kinds, owners }
}
