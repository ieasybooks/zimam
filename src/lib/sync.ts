import type { Item, Me, Repo, Source, Workspace } from '@/types'

import {
  bucketOf,
  emptyCache,
  newRevision,
  readCache,
  savedMarker,
  setMarker,
  syncedMarker,
  writeCache,
  type Cache,
} from './cache'
import { GitHubError, type ErrorKind, type GitHub, type RateLimit } from './github'
import {
  hasClosed,
  KINDS,
  LIST_KINDS,
  type ListKind,
  NODES,
  type Page,
  PR_STATUS,
  type RawItem,
  type RawStatus,
  repoItems,
  REVIEW_REQUESTED,
  SEARCH,
  STATUS_FIELDS,
  toItem,
  toStatus,
} from './queries'
import { inSight } from './sight'
import { brings, qualifier, reposOf, sourcesKey } from './sources'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const TICK = MINUTE
// Runs start a few seconds apart from one tick to the next, so a step due every few minutes is due this much early.
const SLACK = TICK / 4
// The closed history can take many minutes to load, so it loads in slices this long, with a check for changes before
// each one.
const HISTORY_SLICE = 0.75 * TICK
// GitHub's search lags behind a change by a little, so each check looks this far before the last one.
const OVERLAP = 10 * MINUTE
// The most results a search lists, however many it finds.
const SEARCH_MOST = 1000
const REPOS_EVERY = 15 * MINUTE
// How often an open pull request's checks, review and conflicts are read again: running checks soon, failing ones in a
// while, the rest now and then. A conflict GitHub is still working out is asked again a few times at the shortest.
const CHECKS_EVERY = { running: MINUTE, failing: 5 * MINUTE, settled: 15 * MINUTE }
const UNKNOWN_TRIES = 3
// Reading the checks of 100 pull requests takes GitHub 5 to 10 seconds, close to its 10-second limit, so they are read
// fewer at a time. Each read costs a point however few it holds.
const STATUS_BATCH = 50
const REQUESTED_EVERY = 5 * MINUTE
// When nothing has changed, the search for changes still runs this often, in case a change got past the free checks.
const SEARCH_AT_LEAST = 5 * MINUTE
// Search lags behind a change by a little, so after a free check sees one, the search keeps running for this long.
const SETTLE = 3 * MINUTE
// Beyond this many free checks a minute, the search alone is simpler on GitHub.
const PROBE_LIMIT = 50
// Search can't report what disappeared, such as deleted or transferred issues, so open items are refetched now and then.
const RECONCILE_EVERY = 6 * HOUR
const RECONCILE_MANUAL = 10 * MINUTE
// A closed history GitHub won't show for now, as when an organization's SAML sign-on has lapsed, is asked for again
// after this long, twice as long each time after, up to the longest. A refresh asks again at once.
const HISTORY_RETRY = 5 * MINUTE
const HISTORY_RETRY_MOST = HOUR
// The hourly allowance is shared with every other tool on the same GitHub account, so some of it is always left.
const RESERVE = 0.02
const HISTORY_RESERVE = 0.15

/** What a repository can have left to load: its open items, its closed issues, its closed pull requests. */
export type Left = 'open' | ListKind

export interface SyncStatus {
  phase: 'idle' | 'repos' | 'open' | 'changes' | 'history'
  /** Whether the closed items this browser kept are still being read, after the open ones it shows already. */
  reading: boolean
  /** Repositories whose open items are fetched, while `phase` is 'open'. */
  done: number
  total: number
  syncedAt: number | null
  /** Repositories whose closed history is fetched, out of those that have one. */
  history: { done: number; total: number }
  historyDone: boolean
  /** Each repository with something left to load, by id. Open items read again, as a reconcile does, don't count. */
  left: Record<string, Left[]>
  /** The kinds of open items GitHub didn't show of each repository, by its id, when they were last read. */
  hidden: Record<string, Item['kind'][]>
  pausedUntil: number | null
  rate: RateLimit | null
  /** Rate limits pause instead: see `pausedUntil`. */
  error: Exclude<ErrorKind, 'rate'> | null
  failedSources: string[]
}

export function idleStatus(): SyncStatus {
  return {
    phase: 'idle',
    reading: false,
    done: 0,
    total: 0,
    syncedAt: null,
    history: { done: 0, total: 0 },
    historyDone: false,
    left: {},
    hidden: {},
    pausedUntil: null,
    rate: null,
    error: null,
    failedSources: [],
  }
}

/**
 * The in-memory data the screen reads. `changed` is called after every change, with the items that are news, and
 * `whole` when the store was filled anew from what this browser kept.
 */
export interface SyncStore {
  repos: Map<string, Repo>
  items: Map<string, Item>
  me: Me
  changed(fresh: string[], whole?: boolean): void
}

/** What a sync depends on: a change to any of it needs a new Syncer. */
export function syncKey(ws: Workspace): string {
  return `${ws.id} ${ws.token} ${sourcesKey(ws.sources)}`
}

export class Syncer {
  private stopped = false
  private current: Promise<void> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private channel: BroadcastChannel | null = null
  // The revision a tab last told the others it saved, as this tab last looked: until another is told, nothing is new.
  private toldRevision: string | null = null
  // The read of what another tab saved, while it's on its way: a run starting meanwhile waits for it, and goes on from
  // what it takes. And how many saves this tab made: a read from before one is older than what this tab holds.
  private adopting: Promise<boolean> | null = null
  private saves = 0
  private onSight = () => {
    if (inSight() && !this.current) void this.adoptStored()
  }
  private newsSince = Infinity
  private unsaved = false
  private settled = false
  private sliced = false
  // Repositories whose open items have loaded at least once.
  private opened = new Set<string>()
  // When this syncer last searched for changes, and whether that search found any.
  private searchedAt = 0
  private busy = false
  private settleUntil = 0
  // Organizations whose issue list this token can't read, so their repositories are checked one by one, and
  // repositories it can't read either, which only the search can watch.
  private noOrgProbe = new Set<string>()
  private unprobeable = new Set<string>()
  // When the current run started. What it reads counts as read then.
  private runStartedAt = 0
  // Which run this is, and the last one that read the repositories.
  private runs = 0
  private reposRun = 0
  // The review requests are asked for once per syncer, since a new one may come with a new token, and so a new person.
  private askedRequested = false
  // How many times in a row GitHub hasn't known whether a pull request conflicts.
  private unknownMerge = new Map<string, number>()
  // Closed histories GitHub wouldn't show, by repository and kind: when to ask again, and how long the wait was.
  private historyWaits = new Map<string, { until: number; wait: number }>()
  // Repositories the search finds changes in that the workspace doesn't hold, such as those left out of a source.
  private outside = new Set<string>()
  // The buckets of items changed since the last save, which the next one writes, or null for all of them.
  private changedBuckets: Set<string> | null = new Set()
  // Whether only the open items have been read from the cache yet, and the read of the rest, which syncs wait for.
  private closedLeft = false
  private closedRead: Promise<void> = Promise.resolve()

  static async open(ws: Workspace, gh: GitHub, store: SyncStore, status: SyncStatus): Promise<Syncer> {
    // The open items first, which most lists show: start() reads the closed ones.
    const stored = await readCache(ws.id, false)
    const syncer = new Syncer(ws, gh, store, status, stored ?? emptyCache(ws.id, sourcesKey(ws.sources)))
    syncer.toldRevision = stored?.revision ?? null
    // Without a cache to read, buckets an older one left behind go with the first save.
    if (!stored) syncer.changedBuckets = null
    syncer.closedLeft = !!stored
    syncer.fit()
    return syncer
  }

  private constructor(
    private readonly ws: Workspace,
    private readonly gh: GitHub,
    private readonly store: SyncStore,
    private readonly status: SyncStatus,
    private cache: Cache,
  ) {}

  /** Fits the cache to the workspace's sources, should they have changed since it was saved. */
  private fit() {
    const sources = sourcesKey(this.ws.sources)
    const { cache } = this
    if (cache.sources === sources) return
    cache.sources = sources
    cache.reposAt = null
    // What the sources no longer bring goes now, rather than once the repositories have loaded again.
    cache.repos = cache.repos.filter((repo) => this.ws.sources.some((source) => brings(source, repo)))
    const kept = new Set(cache.repos.map((repo) => repo.id))
    cache.items = cache.items.filter((item) => kept.has(item.repoId))
    this.changedBuckets = null
  }

  async start(): Promise<void> {
    this.show(this.cache)
    // The list shows the open items while the closed ones are read: they're all in before anything syncs, and a sync
    // asked for meanwhile waits, or what it saved would leave them out.
    if (this.closedLeft) {
      this.status.reading = true
      this.closedRead = this.readClosed()
      await this.closedRead
      if (this.stopped) return
    }
    // What another tab saves shows here at once, or, while this tab is out of sight, once it's back: reading the whole
    // cache again for each slice of another tab's history would cost a tab no one looks at for nothing.
    if ('BroadcastChannel' in globalThis) {
      this.channel = new BroadcastChannel('zimam')
      this.channel.addEventListener('message', (event: MessageEvent<{ ws: string }>) => {
        if (event.data.ws === this.ws.id) this.onSight()
      })
    }
    globalThis.document?.addEventListener('visibilitychange', this.onSight)
    return this.sync()
  }

  private async readClosed() {
    const all = await readCache(this.ws.id)
    this.status.reading = false
    if (this.stopped || !all) return
    this.cache = all
    this.fit()
    this.show(all)
  }

  stop() {
    this.stopped = true
    clearTimeout(this.saveTimer)
    this.channel?.close()
    globalThis.document?.removeEventListener('visibilitychange', this.onSight)
  }

  sync(manual = false): Promise<void> {
    this.current ??= this.closedRead
      .then(() => this.withLock(manual))
      .finally(() => {
        this.current = null
        const more = this.sliced
        this.sliced = false
        // The next slice of the history doesn't wait for a tick.
        if (more && !this.stopped) setTimeout(() => void this.sync(), 0)
      })
    return this.current
  }

  private async withLock(manual: boolean) {
    const locks = globalThis.navigator?.locks
    if (!locks) return this.run(manual)
    const ran = await locks.request(`zimam:${this.ws.id}`, { ifAvailable: true }, async (lock) => {
      if (lock) await this.run(manual)
      return !!lock
    })
    // A workspace that was just opened shouldn't wait a whole tick for a lock that is about to be free, such as the
    // one a syncer this tab just stopped is letting go of.
    if (!ran && !this.settled && !this.stopped) setTimeout(() => void this.sync(manual), 2000)
  }

  private async run(manual: boolean) {
    const started = Date.now()
    this.runStartedAt = started
    this.runs++
    // A refused token stays refused until it's replaced, which opens the workspace anew.
    if (this.stopped || this.status.error === 'auth' || (this.status.pausedUntil ?? 0) > started) return
    this.status.pausedUntil = null
    if (manual) this.historyWaits.clear()
    const peerJustSynced = (await this.adoptStored()) && started - syncedMarker(this.ws.id) < 0.75 * TICK
    if (peerJustSynced && !manual) return

    this.newsSince = this.cache.syncedAt === null ? Infinity : this.cache.syncedAt - OVERLAP
    const first = this.cache.watermark === null
    if (first) {
      this.cache.watermark = started
      this.cache.reconciledAt = started
    } else if (started - (this.cache.reconciledAt ?? 0) > (manual ? RECONCILE_MANUAL : RECONCILE_EVERY)) {
      this.cache.openDone = []
      this.cache.reconciledAt = started
    }

    const steps = [
      () => (manual || !this.cache.reposAt || started - this.cache.reposAt > REPOS_EVERY ? this.loadRepos() : null),
      () => this.loadOpen(),
      () => (first ? null : this.loadChanges(started, manual)),
      () => this.loadChecks(started, manual),
      () =>
        manual || !this.askedRequested || started - (this.cache.requestedAt ?? 0) >= REQUESTED_EVERY - SLACK
          ? this.loadRequested()
          : null,
      () => {
        this.cache.syncedAt = Date.now()
        this.status.syncedAt = this.cache.syncedAt
        return this.save()
      },
      () => this.loadHistory(),
    ]
    try {
      this.status.error = null
      for (const step of steps) {
        if (this.stopped) return
        await step()
      }
    } catch (error) {
      this.fail(error)
    } finally {
      this.settled = true
      this.status.phase = 'idle'
      this.status.rate = this.gh.rate()
      await this.save()
    }
  }

  private adoptStored(): Promise<boolean> {
    this.adopting ??= this.takeStored().finally(() => (this.adopting = null))
    return this.adopting
  }

  // What another tab saved since this one's copy, the history it loaded after its sync too. Only a save another tab told
  // of is read: a cache that isn't this tab's own copy is the other tab's, saved after it, unless this tab changed or
  // saved something while it was read.
  private async takeStored(): Promise<boolean> {
    const told = savedMarker(this.ws.id)
    if (!told || told === this.toldRevision) return false
    this.toldRevision = told
    const saves = this.saves
    const stored = await readCache(this.ws.id)
    if (this.stopped || this.unsaved || saves !== this.saves) return false
    if (!stored?.revision || stored.revision === this.cache.revision) return false
    this.cache = stored
    this.changedBuckets = new Set()
    this.show(stored)
    return true
  }

  private changed(fresh: string[]) {
    this.unsaved = true
    this.store.changed(fresh)
  }

  private show(cache: Cache) {
    this.store.repos.clear()
    this.store.items.clear()
    for (const repo of cache.repos) this.store.repos.set(repo.id, repo)
    for (const item of cache.items) this.store.items.set(item.id, item)
    this.store.me.login = cache.login
    this.store.me.requested = new Set(cache.requested)
    this.status.syncedAt = cache.syncedAt
    // Once a sync has finished, every repository's open items have loaded. Until then, only those in `openDone` have.
    this.opened = new Set(cache.syncedAt === null ? cache.openDone : cache.repos.map((repo) => repo.id))
    this.showProgress()
    this.store.changed([], true)
  }

  private fail(error: unknown) {
    if (this.stopped) return
    if (!(error instanceof GitHubError)) {
      console.error(error)
      this.status.error = 'query'
    } else if (error.kind === 'rate') {
      this.status.pausedUntil = error.retryAt ?? Date.now() + MINUTE
    } else {
      this.status.error = error.kind
    }
  }

  private hasBudget(reserve: number): boolean {
    const rate = this.gh.rate()
    this.status.rate = rate
    if (!rate || rate.remaining > rate.limit * reserve) return true
    if (rate.remaining <= rate.limit * RESERVE) this.status.pausedUntil = rate.resetAt
    return false
  }

  private async loadRepos() {
    this.status.phase = 'repos'
    const repos = new Map<string, Repo>()
    const failed: Source[] = []
    for (const source of this.ws.sources) {
      try {
        for (const repo of await reposOf(this.gh, source)) if (brings(source, repo)) repos.set(repo.id, repo)
      } catch (error) {
        if (!(error instanceof GitHubError) || error.kind !== 'query') throw error
        failed.push(source)
      }
    }
    this.status.failedSources = failed.map((source) => source.name)
    // A source GitHub couldn't read this time keeps its repositories, so one bad answer doesn't empty the list.
    for (const repo of this.store.repos.values()) {
      if (!repos.has(repo.id) && failed.some((source) => brings(source, repo))) repos.set(repo.id, repo)
    }
    for (const item of this.store.items.values()) if (!repos.has(item.repoId)) this.drop(item)
    this.store.repos.clear()
    for (const [id, repo] of repos) this.store.repos.set(id, repo)
    // A repository that comes back, such as one picked again, loads its items again.
    this.cache.openDone = this.cache.openDone.filter((id) => repos.has(id))
    for (const id of Object.keys(this.cache.history)) if (!repos.has(id)) delete this.cache.history[id]
    for (const id of Object.keys(this.cache.openHidden)) if (!repos.has(id)) delete this.cache.openHidden[id]
    this.cache.reposAt = Date.now()
    this.reposRun = this.runs
    this.showProgress()
    this.changed([])
  }

  private async loadOpen() {
    const pending = [...this.store.repos.values()].filter((repo) => !this.cache.openDone.includes(repo.id))
    if (!pending.length) return
    this.status.phase = 'open'
    this.status.done = 0
    this.status.total = pending.length
    await pool(pending, 4, async (repo) => {
      if (this.stopped || !this.hasBudget(RESERVE)) return
      const fetched: Item[] = []
      const hidden = new Set<Item['kind']>()
      for (const kind of LIST_KINDS) {
        if (!repo[KINDS[kind].open]) continue
        for await (const page of this.pages(repo, kind, ['OPEN'])) {
          if (!page) hidden.add(KINDS[kind].item)
          else fetched.push(...page.items)
        }
      }
      if (this.stopped) return
      this.put(fetched)
      // What GitHub didn't show this time, such as a repository behind an organization's SAML sign-on, keeps its items.
      const seen = new Set(fetched.map((item) => item.id))
      const missing = [...this.store.items.values()].filter(
        (item) => item.repoId === repo.id && item.state === 'open' && !hidden.has(item.kind) && !seen.has(item.id),
      )
      if (missing.length) await this.refetch(missing.map((item) => item.id))
      if (hidden.size) this.cache.openHidden[repo.id] = [...hidden]
      else delete this.cache.openHidden[repo.id]
      this.cache.openDone.push(repo.id)
      this.opened.add(repo.id)
      this.showProgress()
      this.status.done++
      this.saveSoon()
    })
  }

  private async loadChanges(started: number, manual: boolean) {
    if (!this.hasBudget(RESERVE)) return
    this.status.phase = 'changes'
    if (!manual && (await this.unchanged(started))) return
    const since = Math.floor(((this.cache.watermark ?? started) - OVERLAP) / 1000)
    const crowded = this.cache.crowded
    for (const [q, { second }] of Object.entries(crowded)) if (second < since) delete crowded[q]
    const found: Found = { items: [], changed: false, tooMany: [], crowded: {} }
    const to = Math.floor(started / 1000)
    // With a fine-grained token, a search finds nothing unless it says `is:issue` or `is:pr`, so each kind has its own.
    const searches = chunk(this.ws.sources, 8).flatMap((sources) =>
      LIST_KINDS.map((kind): ChangesSearch => ({ sources, from: since, to, kind, open: null })),
    )
    for (const search of searches) {
      const searched = await this.findChanges(search, found)
      // What was found counts, but the next run looks over the same time again.
      if (searched === 'stopped') {
        if (!this.stopped) this.put(found.items.filter((item) => this.store.repos.has(item.repoId)))
        return
      }
    }
    // Repositories this run read are as they were when the changes the search found were made, or since.
    const reposRead = () => this.reposRun === this.runs
    if (found.tooMany.length) await this.readAgain(found.tooMany, reposRead())
    Object.assign(crowded, found.crowded)
    // A change in a repository the workspace doesn't hold may be in a new one, or in one it leaves out.
    const unknown = found.items.filter((item) => !this.store.repos.has(item.repoId) && !this.outside.has(item.repoId))
    if (unknown.length && !reposRead()) await this.loadRepos()
    for (const item of unknown) if (!this.store.repos.has(item.repoId)) this.outside.add(item.repoId)
    this.busy =
      this.put(found.items.filter((item) => this.store.repos.has(item.repoId))) ||
      found.changed ||
      !!found.tooMany.length
    if (unknown.length) await this.loadOpen()
    this.searchedAt = started
    this.cache.watermark = started
  }

  /**
   * Adds to `found` what changed in a search's sources between its two times: from `from` to now, while the search is
   * `whole`, or to `to` once the time is cut up. Search lists no more than 1,000 results, and after a long absence more
   * than that can change. GitHub says how many there are, so a search finding more is made of narrower ones, as many
   * times as it takes, as `narrower` cuts them, as when a thousand issues change at once. What one of those still finds
   * too many of goes into `found.tooMany`. Each search counts and is saved as soon as it's done, so a long search shows
   * what it finds as it goes and keeps it should it stop. Says how many changes GitHub counted, or that it stopped short.
   */
  private async findChanges(search: ChangesSearch, found: Found, whole = true): Promise<number | 'stopped'> {
    const { sources: group, from, to, kind, open } = search
    // The first search runs to now, so it also finds what changed since this run started, which the next one looks at
    // again anyway. The parts of a time cut up end where it ends.
    const span = whole ? `>=${isoSecond(from)}` : `${isoSecond(from)}..${isoSecond(to)}`
    const q = [...group.map(qualifier), ...kindTerms(search), `updated:${span}`].join(' ')
    const items: Item[] = []
    let after: string | null = null
    let count = 0
    do {
      if (this.stopped || !this.hasBudget(RESERVE)) return 'stopped'
      const data: Searched = await this.gh.query(SEARCH, { q, after })
      count = data.search.issueCount
      if (count > SEARCH_MOST) {
        const { by, searches } = narrower(search, count, (source) => this.reposIn(source))
        // A second of one part of a source comes up again while it's in the time each search looks back over. Read
        // again from its repository, it has nothing new for the search: the read had all of its changes, those the
        // search indexes late too, and what changes after leaves the second.
        const crowded = by === 'repo'
        const done = crowded ? this.cache.crowded[q] : undefined
        if (done?.repos === null) return count
        if (!searches.length && open !== null) {
          found.tooMany.push({ source: group[0], kind, open, count })
          found.crowded[q] = { second: from, repos: null }
          return count
        }
        // Searched repository by repository, it's searched so again, as the search may have indexed some of its changes
        // late, whether or not it holds more: in the repositories that held its changes, then in the others, unless
        // those still hold all it does.
        const repoOf = (each: ChangesSearch) => each.sources[0].name
        const held = done?.repos
        const first = held ? searches.filter((each) => held.includes(repoOf(each))) : searches
        const holding: string[] = []
        let counted = 0
        for (const each of [...first, ...searches.filter((other) => !first.includes(other))]) {
          if (!first.includes(each) && counted >= count) break
          const counts = await this.findChanges(each, found, false)
          if (counts === 'stopped') return 'stopped'
          counted += counts
          if (counts) holding.push(repoOf(each))
        }
        if (crowded) found.crowded[q] = { second: from, repos: holding }
        return count
      }
      for (const node of data.search.nodes) if (node && 'id' in node) items.push(toItem(node as RawItem))
      after = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null
    } while (after)
    found.items.push(...items)
    if (!whole && items.length) {
      found.changed = this.put(items.filter((item) => this.store.repos.has(item.repoId))) || found.changed
      await this.save(true)
    }
    return count
  }

  /** The repositories the workspace knows a source brings. */
  private known(source: Source): Repo[] {
    return [...this.store.repos.values()].filter((repo) => brings(source, repo))
  }

  /**
   * The repositories an account brings, as far as the workspace knows, as sources of their own, to search one by one,
   * even one: the account's search also counts those the workspace doesn't know of yet, and those it leaves out.
   */
  private reposIn(source: Source): Source[] {
    if (source.kind === 'repo') return []
    return this.known(source).map((repo) => ({ kind: 'repo', name: repo.fullName }))
  }

  /**
   * Reads again, from the repositories, the parts of sources that changed more in one second than a search lists: open
   * items now, and for closed ones, the closed history too, from its latest change, as it loads, so nothing changed
   * then is left out. Reading the open items again reads those closed then as they are now, history or not. What the
   * repositories count says what there is to read, so they're read first, unless this run read them already, `read`.
   * That count can still be from before the second, or one kept when the read failed: a repository counts at least what
   * its own search did, until the repositories are read again.
   */
  private async readAgain(parts: Found['tooMany'], read: boolean) {
    if (!read) await this.loadRepos()
    for (const { source, kind, open, count } of parts) {
      for (const repo of this.known(source)) {
        // Only a repository's own search counts what it holds.
        if (source.kind === 'repo') this.store.repos.set(repo.id, counting(repo, { kind, open }, count))
        this.cache.openDone = this.cache.openDone.filter((id) => id !== repo.id)
        if (open) continue
        const entry = this.cache.history[repo.id]
        if (entry) delete entry[KINDS[kind].history]
        this.historyWaits.delete(waitKey(repo, kind))
      }
    }
    this.showProgress()
    await this.loadOpen()
  }

  /**
   * Whether GitHub says nothing changed in any source since the last time it was asked, so the search can wait. The
   * answer is free when nothing changed. Busy workspaces skip asking: their searches keep finding something anyway.
   */
  private async unchanged(started: number): Promise<boolean> {
    if (this.busy || started < this.settleUntil || started - this.searchedAt >= SEARCH_AT_LEAST - SLACK) return false
    const probes = this.probes()
    if (!probes) return false
    const results = await Promise.all(probes.map((probe) => this.gh.probe(probe.path)))
    let same = true
    results.forEach((result, index) => {
      const { org, path } = probes[index]
      if (result === 'unsupported') {
        if (org) this.noOrgProbe.add(org)
        else this.unprobeable.add(path)
      }
      if (result === 'changed') this.settleUntil = started + SETTLE
      if (result !== 'same') same = false
    })
    return same
  }

  // Each address lists issues and pull requests, the latest updated first, so its first one changes with any of them.
  // An organization's list covers every repository in it, when the token may read it. Otherwise each repository that
  // can still change gets its own.
  private probes(): { path: string; org?: string }[] | null {
    if (this.status.failedSources.length) return null
    const list = 'issues?state=all&sort=updated&direction=desc&per_page=1'
    const probes: { path: string; org?: string }[] = []
    for (const source of this.ws.sources) {
      if (source.kind === 'org' && !this.noOrgProbe.has(source.name)) {
        probes.push({ path: `/orgs/${source.name}/${list}&filter=all`, org: source.name })
        continue
      }
      for (const repo of this.store.repos.values())
        if (brings(source, repo) && !repo.isArchived) probes.push({ path: `/repos/${repo.fullName}/${list}` })
    }
    const usable = probes.length <= PROBE_LIMIT && !probes.some((probe) => this.unprobeable.has(probe.path))
    return usable ? probes : null
  }

  // A finished CI run doesn't change a pull request's update time, and neither does its base branch moving on, so open
  // pull requests' checks and conflicts are asked for apart, each as often as it is likely to change.
  private async loadChecks(started: number, manual: boolean) {
    for (const id of Object.keys(this.cache.checkedAt)) {
      const item = this.store.items.get(id)
      if (item?.kind !== 'pr' || item.state !== 'open') delete this.cache.checkedAt[id]
    }
    // Nothing runs or moves in an archived repository, so its pull requests keep what they had.
    const due = [...this.store.items.values()].filter(
      (item) =>
        item.kind === 'pr' &&
        item.state === 'open' &&
        !this.store.repos.get(item.repoId)?.isArchived &&
        this.checksDue(item, started, manual),
    )
    for (const ids of chunk(
      due.map((item) => item.id),
      STATUS_BATCH,
    )) {
      if (this.stopped || !this.hasBudget(RESERVE)) return
      const data = await this.gh.query<{
        nodes: ((RawStatus & { id: string }) | null)[]
      }>(PR_STATUS, { ids })
      // Pull requests GitHub doesn't return, such as those behind SAML sign-on, wait their turn like the rest.
      for (const id of ids) this.cache.checkedAt[id] = started
      let patched = false
      for (const node of data.nodes) {
        const item = node && this.store.items.get(node.id)
        if (!node || !item) continue
        const status = toStatus(node, true)
        if (status.merge) this.unknownMerge.delete(item.id)
        else this.unknownMerge.set(item.id, (this.unknownMerge.get(item.id) ?? 0) + 1)
        const next = keepMerge({ ...item, ...status }, item)
        if (sameStatus(next, item)) continue
        this.keep(next, item)
        patched = true
      }
      if (patched) this.changed([])
    }
  }

  private checksDue(item: Item, started: number, manual: boolean): boolean {
    const checkedAt = this.cache.checkedAt[item.id] ?? 0
    // A refresh reads them all again, except those this run has just read.
    if (manual) return checkedAt < started
    // Unknown until the first answer, or since GitHub last answered "unknown", as it does after the base branch moves.
    const tries = this.unknownMerge.get(item.id)
    const unknown = (item.merge === null || tries !== undefined) && (tries ?? 0) < UNKNOWN_TRIES
    const every =
      item.checks === 'pending' || unknown
        ? CHECKS_EVERY.running
        : item.checks === 'failure'
          ? CHECKS_EVERY.failing
          : CHECKS_EVERY.settled
    return started - checkedAt >= every - SLACK
  }

  // A request for a review can go to a team, which the pull request names instead of its members, so GitHub's search,
  // which knows the viewer's teams, finds them. The answer names the viewer too.
  private async loadRequested() {
    if (!this.hasBudget(RESERVE)) return
    let login: string | null = null
    const requested: string[] = []
    type Requested = { viewer: { login: string }; search: Page<{ id?: string } | null> }
    for await (const data of this.search<Requested>(REVIEW_REQUESTED, 'is:pr is:open review-requested:@me')) {
      login = data.viewer.login
      for (const node of data.search.nodes) if (node?.id) requested.push(node.id)
    }
    const { me } = this.store
    const changed =
      login !== me.login || requested.length !== me.requested.size || requested.some((id) => !me.requested.has(id))
    this.askedRequested = true
    this.cache.requestedAt = Date.now()
    me.login = login
    me.requested = new Set(requested)
    if (changed) this.changed([])
  }

  // Several qualifiers in one search are OR'ed, and a query holds about eight before GitHub refuses it, so the sources
  // are searched eight at a time. Yields every page of every search.
  private async *search<T extends { search: Page<unknown> }>(query: string, terms: string): AsyncGenerator<T> {
    for (const group of chunk(this.ws.sources, 8)) {
      const q = `${group.map(qualifier).join(' ')} ${terms}`
      let after: string | null = null
      do {
        const data: T = await this.gh.query(query, { q, after })
        yield data
        after = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null
      } while (after)
    }
  }

  private async loadHistory() {
    const pending = this.showProgress()
    if (!pending.length || !this.hasBudget(HISTORY_RESERVE)) return
    this.status.phase = 'history'
    const until = Date.now() + HISTORY_SLICE
    const more = () => !this.stopped && Date.now() < until && this.hasBudget(HISTORY_RESERVE)
    await pool(pending, 2, async (repo) => {
      for (const kind of this.historyKinds(repo)) {
        if (!more()) return
        const entry = (this.cache.history[repo.id] ??= {})
        const key = KINDS[kind].history
        const saved = entry[key]
        const resume = typeof saved === 'string' ? saved : null
        let shown = true
        for await (const page of this.pages(repo, kind, KINDS[kind].closed, resume)) {
          if (!page) {
            shown = false
            break
          }
          this.historyWaits.delete(waitKey(repo, kind))
          this.put(page.items)
          entry[key] = page.cursor ?? true
          this.saveSoon()
          if (!more()) return
        }
        if (this.stopped) return
        // What GitHub won't show isn't all there is: it keeps its place, to be asked for again in a while.
        if (shown) entry[key] = true
        else this.waitForHistory(repo, kind)
        this.showProgress()
      }
    })
    this.sliced = this.showProgress().length > 0 && !this.stopped && this.hasBudget(HISTORY_RESERVE)
  }

  /** Shows what is left to load, and returns the repositories with some of their closed history left. */
  private showProgress(): Repo[] {
    const pending = this.historyLeft()
    const total = [...this.store.repos.values()].filter((repo) =>
      LIST_KINDS.some((kind) => hasClosed(repo, kind)),
    ).length
    this.status.history = { done: total - pending.length, total }
    this.status.historyDone = this.cache.syncedAt !== null && pending.length === 0
    const left: Record<string, Left[]> = {}
    for (const repo of this.store.repos.values()) {
      const kinds: Left[] = [...(this.opened.has(repo.id) ? [] : ['open' as const]), ...this.historyKinds(repo)]
      if (kinds.length) left[repo.id] = kinds
    }
    this.status.left = left
    this.status.hidden = { ...this.cache.openHidden }
    return pending
  }

  // Repositories still worked on come first, the latest pushed first, so what people look at fills in soonest.
  private historyLeft(): Repo[] {
    return [...this.store.repos.values()]
      .filter((repo) => this.historyKinds(repo).length > 0)
      .toSorted(
        (a, b) => Number(a.isArchived) - Number(b.isArchived) || (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''),
      )
  }

  // A history waiting to be asked for again doesn't count as left meanwhile: it isn't loading.
  private historyKinds(repo: Repo): ListKind[] {
    const entry = this.cache.history[repo.id] ?? {}
    const now = Date.now()
    return LIST_KINDS.filter(
      (kind) =>
        hasClosed(repo, kind) &&
        entry[KINDS[kind].history] !== true &&
        (this.historyWaits.get(waitKey(repo, kind))?.until ?? 0) <= now,
    )
  }

  private waitForHistory(repo: Repo, kind: ListKind) {
    const key = waitKey(repo, kind)
    const last = this.historyWaits.get(key)?.wait
    const wait = last ? Math.min(2 * last, HISTORY_RETRY_MOST) : HISTORY_RETRY
    this.historyWaits.set(key, { until: Date.now() + wait, wait })
  }

  // GitHub times out on heavy pages, so any page that times out is asked for again at half the size. A repository
  // GitHub doesn't show, because it is gone or the token may no longer read it, gives one null.
  private async *pages(
    repo: Repo,
    kind: ListKind,
    states: readonly string[],
    after: string | null = null,
  ): AsyncGenerator<{ items: Item[]; cursor: string | null } | null> {
    const open = states.includes('OPEN')
    const { query, size } = repoItems(kind, open)
    let first = size
    while (!this.stopped) {
      let page: Page<RawItem | null> | undefined
      try {
        const data = await this.gh.query<{ repository: Record<string, Page<RawItem | null>> | null }>(query, {
          owner: repo.owner,
          name: repo.name,
          states,
          first,
          after,
        })
        page = data.repository?.[kind]
      } catch (error) {
        if (error instanceof GitHubError && error.kind === 'server' && first > 25) {
          first = Math.floor(first / 2)
          continue
        }
        throw error
      }
      if (!page) {
        yield null
        return
      }
      const cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
      yield { items: page.nodes.filter((node): node is RawItem => node !== null).map(toItem), cursor }
      if (!cursor) return
      after = cursor
    }
  }

  private async refetch(ids: string[]) {
    for (const group of chunk(ids, 100)) {
      const { data, errors } = await this.gh.request<{ nodes: (RawItem | null)[] }>(NODES, { ids: group })
      // Only what GitHub says doesn't exist goes. What it won't show, such as items behind an organization's SAML
      // sign-on, stays until it can be read again.
      const gone = new Set(
        errors
          .filter((error) => error.type === 'NOT_FOUND' && error.path?.[0] === 'nodes')
          .map((error) => error.path?.[1]),
      )
      const found: Item[] = []
      let deleted = false
      data.nodes.forEach((node, index) => {
        if (node && 'id' in node) found.push(toItem(node))
        else if (gone.has(index)) {
          const old = this.store.items.get(group[index])
          if (old) this.drop(old)
          deleted ||= !!old
        }
      })
      if (!this.put(found) && deleted) this.changed([])
    }
  }

  /** Returns whether anything changed. */
  private put(items: Item[]): boolean {
    const fresh: string[] = []
    let changed = false
    for (const incoming of items) {
      const old = this.store.items.get(incoming.id)
      if (old && old.updatedAt > incoming.updatedAt) continue
      const item = keepMerge(incoming, old)
      // Open pull requests always come with their checks. One GitHub doesn't know yet whether it conflicts, as after a
      // push, is asked again soon, as when the checks find it so: the last answer it keeps meanwhile may no longer hold.
      if (item.kind === 'pr' && item.state === 'open') {
        this.cache.checkedAt[item.id] = this.runStartedAt
        if (incoming.merge === null) this.unknownMerge.set(item.id, this.unknownMerge.get(item.id) ?? 0)
        else this.unknownMerge.delete(item.id)
      }
      // A copy kept from before up to 100 labels were read can have fewer than GitHub gives now, with the same time.
      const same = old && old.updatedAt === item.updatedAt && old.labels.length === item.labels.length
      if (same && sameStatus(old, item)) continue
      this.keep(item, old)
      changed = true
      if (old?.updatedAt !== item.updatedAt && Date.parse(item.updatedAt) > this.newsSince) fresh.push(item.id)
    }
    if (changed) this.changed(fresh)
    return changed
  }

  /** Puts an item in place of the one it changes, if any, for the next save to write. */
  private keep(item: Item, old?: Item) {
    this.store.items.set(item.id, item)
    this.changedBuckets?.add(bucketOf(item))
    if (old) this.changedBuckets?.add(bucketOf(old))
  }

  private drop(item: Item) {
    this.store.items.delete(item.id)
    this.changedBuckets?.add(bucketOf(item))
  }

  private saveSoon() {
    if (this.stopped) return
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.save(), 2000)
  }

  // Other tabs only hear about saves with new data, so a quiet minute doesn't make each of them reread the cache. A quiet
  // save, as each part of a long search makes, tells them nothing: the save at the end of the run does, once.
  private async save(quiet = false) {
    clearTimeout(this.saveTimer)
    if (this.stopped) return
    const announce = !quiet && this.unsaved
    const changed = this.changedBuckets
    if (!quiet) this.unsaved = false
    this.changedBuckets = new Set()
    this.cache.repos = [...this.store.repos.values()]
    this.cache.items = [...this.store.items.values()]
    this.cache.login = this.store.me.login
    this.cache.requested = [...this.store.me.requested]
    const revision = this.cache.revision
    this.cache.revision = newRevision()
    if (!(await writeCache(this.cache, changed))) {
      // What wasn't saved waits for the next save.
      this.cache.revision = revision
      this.unsaved ||= announce
      this.changedBuckets = changed && this.changedBuckets && new Set([...changed, ...this.changedBuckets])
      return
    }
    this.saves++
    if (!announce) return
    this.toldRevision = this.cache.revision
    setMarker(this.ws.id, this.cache.syncedAt, this.cache.revision)
    this.channel?.postMessage({ ws: this.ws.id })
  }
}

// While GitHub works out whether an open pull request conflicts, it answers "unknown": the last answer stands until then.
const keepMerge = (next: Item, old: Item | undefined): Item =>
  next.state === 'open' && next.merge === null && old?.merge ? { ...next, merge: old.merge } : next

const waitKey = (repo: Repo, kind: ListKind) => `${repo.id} ${kind}`

const sameStatus = (a: Item, b: Item) => STATUS_FIELDS.every((field) => a[field] === b[field])

type Searched = { search: Page<RawItem | Record<string, never>> & { issueCount: number } }

/** Part of what changed in a source: one kind, open or closed. */
interface Part {
  kind: ListKind
  open: boolean
}

/**
 * What a search for changes found, whether what it already counted changed anything, the parts of a source that
 * changed more in one second than a search lists, with how many it counted, to read again from the repositories, and
 * the searches of such seconds, by query, as the cache keeps them.
 */
type Found = {
  items: Item[]
  changed: boolean
  tooMany: (Part & { source: Source; count: number })[]
  crowded: Cache['crowded']
}

/**
 * A search for changes: in some sources, from one second to another, both included, of one kind, and maybe only of its
 * open or its closed items.
 */
interface ChangesSearch {
  sources: Source[]
  from: number
  to: number
  kind: ListKind
  open: boolean | null
}
const kindTerms = ({ kind, open }: ChangesSearch) => [
  `is:${KINDS[kind].item}`,
  ...(open === null ? [] : [`is:${open ? 'open' : 'closed'}`]),
]

/**
 * The narrower searches that find what a search finds `count` of, more than it lists, and how they're cut. Its time
 * first, in parts of about 800 each, should the changes be spread evenly, with room for some more meanwhile, down to a
 * second. Then a second source by source, then open and closed apart, then repository by repository, as `reposIn`
 * gives a source's. None once there's no narrower search.
 */
function narrower(
  search: ChangesSearch,
  count: number,
  reposIn: (source: Source) => Source[],
): { by: 'time' | 'source' | 'part' | 'repo'; searches: ChangesSearch[] } {
  const { sources, from, to, open } = search
  if (to > from) {
    const size = Math.ceil((to - from + 1) / Math.min(to - from + 1, Math.ceil(count / (0.8 * SEARCH_MOST))))
    const searches = Array.from({ length: Math.ceil((to - from + 1) / size) }, (_, index) => ({
      ...search,
      from: from + index * size,
      to: Math.min(from + (index + 1) * size - 1, to),
    }))
    return { by: 'time', searches }
  }
  if (sources.length > 1) return { by: 'source', searches: sources.map((source) => ({ ...search, sources: [source] })) }
  if (open === null) return { by: 'part', searches: [true, false].map((each) => ({ ...search, open: each })) }
  return { by: 'repo', searches: reposIn(sources[0]).map((repo) => ({ ...search, sources: [repo] })) }
}

/** A repository counting at least `count` of a part, open or closed, as a search found, its other part as it was. */
function counting(repo: Repo, { kind, open }: Part, count: number): Repo {
  const { open: opened, all } = KINDS[kind]
  if (!open) return { ...repo, [all]: Math.max(repo[all], repo[opened] + count) }
  const more = Math.max(0, count - repo[opened])
  return { ...repo, [opened]: repo[opened] + more, [all]: repo[all] + more }
}

/** A time in seconds, as a search's `updated:` takes it. */
const isoSecond = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z')

function chunk<T>(list: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < list.length; index += size) chunks.push(list.slice(index, index + size))
  return chunks
}

async function pool<T>(list: T[], size: number, task: (item: T) => Promise<void>) {
  let next = 0
  let failure: { error: unknown } | null = null
  const worker = async () => {
    while (!failure && next < list.length) {
      try {
        await task(list[next++])
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, worker))
  if (failure) throw (failure as { error: unknown }).error
}
