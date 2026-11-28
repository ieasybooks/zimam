import type {
  Checks,
  IssueState,
  Item,
  ItemKind,
  ItemState,
  Language,
  Merge,
  Person,
  PullState,
  Repo,
  RepoBasics,
  Review,
} from '@/types'

export const PERSON = 'login avatarUrl(size: 64)'
export const ASSIGNEES = `assignees(first: 10) { nodes { ${PERSON} } }`
// Every label an item has, as far as one list goes: GitHub charges a list inside each item the same whatever its size.
export const LABELS = 'labels(first: 100) { nodes { name color } }'

const SHARED = `
    id number title url state createdAt updatedAt
    author { ${PERSON} }
    ${ASSIGNEES}
    ${LABELS}
    comments { totalCount }
    repository { id }`

const ISSUE = `fragment IssueFields on Issue { kind: __typename stateReason ${SHARED} }`
const PR = `fragment PrFields on PullRequest { kind: __typename isDraft reviewDecision additions deletions ${SHARED} }`

// What changes on an open pull request without changing its update time: its checks, and whether it conflicts with a
// base branch that moved. Asking for `mergeable` makes GitHub work it out, so closed pull requests don't ask. Every
// query that can return an open pull request asks for these: the sync counts one as checked when it arrives.
const STATUS = 'mergeable commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }'

// GitHub charges a point for every 100 lists a query could open, rounded to the nearest point: the page's own list
// once, and each list inside an item once per item. So a page costs one point while that comes to 148 at most.
const lists = (fields: string) => fields.match(/\b(?:first|last):\s*\d+/g)?.length ?? 0
const pageSize = (...fields: string[]) => Math.floor(148 / Math.max(...fields.map(lists)))

const BASICS = `id name nameWithOwner description isPrivate isArchived pushedAt owner { ${PERSON} }
    primaryLanguage { name color }`

const REPO = `
  fragment RepoFields on Repository {
    ${BASICS}
    openIssues: issues(states: OPEN) { totalCount }
    openPrs: pullRequests(states: OPEN) { totalCount }
    allIssues: issues { totalCount }
    allPrs: pullRequests { totalCount }
  }`

// The lists of what someone contributed to leave the counts out: GitHub works each one out per repository, and over the
// few hundred repositories of one query it refuses the query.
const REPO_BASICS = `fragment RepoBasics on Repository { ${BASICS} }`

const PAGE = 'pageInfo { hasNextPage endCursor }'

export const VIEWER = `
  query {
    viewer {
      login name avatarUrl(size: 96)
      organizations(first: 100) { nodes { login name avatarUrl(size: 96) } }
    }
  }`

export const OWNER = `
  query($login: String!) {
    repositoryOwner(login: $login) { kind: __typename login avatarUrl(size: 96) }
  }`

export const ORG_REPOS = `
  query($login: String!, $after: String) {
    organization(login: $login) { repositories(first: 100, after: $after) { ${PAGE} nodes { ...RepoFields } } }
  }
  ${REPO}`

export const USER_REPOS = `
  query($login: String!, $after: String) {
    user(login: $login) {
      repositories(first: 100, after: $after, ownerAffiliations: [OWNER]) { ${PAGE} nodes { ...RepoFields } }
    }
  }
  ${REPO}`

export const ONE_REPO = `
  query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ...RepoFields } }
  ${REPO}`

// Recent contributions, by kind: GitHub keeps no full history here, so the search of what the person opened adds the
// rest. Repositories the token can't read come back null.
const contributed = (kind: string, type: string) =>
  `${kind}: repositoriesContributedTo(first: 100, includeUserRepositories: true, contributionTypes: [${type}]) {
    totalCount nodes { ...RepoBasics }
  }`

export const CONTRIBUTED = `
  query($login: String!) {
    user(login: $login) {
      ${contributed('commit', 'COMMIT')}
      ${contributed('pr', 'PULL_REQUEST')}
      ${contributed('issue', 'ISSUE')}
      ${contributed('review', 'PULL_REQUEST_REVIEW')}
    }
  }
  ${REPO_BASICS}`

/** A page of the pull requests or issues someone opened, the latest first, with where. */
export const opened = (list: 'pullRequests' | 'issues') => `
  query($login: String!, $after: String) {
    user(login: $login) {
      list: ${list}(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        ${PAGE} nodes { createdAt repository { ...RepoBasics } }
      }
    }
  }
  ${REPO_BASICS}`

/**
 * Issues and pull requests, by what each part calls them: the items, a repository's counts of the open and of all of
 * them, the states a closed one can be in, the cache's history of them, and how GitHub's list of them is read. An open
 * pull request's page carries its status too.
 */
export const KINDS = {
  issues: {
    item: 'issue',
    open: 'openIssues',
    all: 'issues',
    closed: ['CLOSED'],
    history: 'issues',
    states: 'IssueState',
    fragment: ISSUE,
    fields: '...IssueFields',
    openStatus: false,
  },
  pullRequests: {
    item: 'pr',
    open: 'openPrs',
    all: 'prs',
    closed: ['CLOSED', 'MERGED'],
    history: 'prs',
    states: 'PullRequestState',
    fragment: PR,
    fields: '...PrFields',
    openStatus: true,
  },
} as const satisfies Record<
  string,
  {
    item: ItemKind
    open: keyof Repo
    all: keyof Repo
    closed: readonly string[]
    history: string
    states: string
    fragment: string
    fields: string
    openStatus: boolean
  }
>
export type ListKind = keyof typeof KINDS
export const LIST_KINDS = Object.keys(KINDS) as ListKind[]

/** Whether a repository has closed issues, or closed pull requests. */
export const hasClosed = (repo: Repo, kind: ListKind) => repo[KINDS[kind].all] > repo[KINDS[kind].open]

/** A page of a repository's issues or pull requests, and the most items it may ask for at one point. */
export function repoItems(kind: ListKind, open: boolean): { query: string; size: number } {
  const { states, fragment, fields, openStatus } = KINDS[kind]
  const status = open && openStatus ? STATUS : ''
  const query = `
    query($owner: String!, $name: String!, $states: [${states}!], $first: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        ${kind}(first: $first, after: $after, states: $states, orderBy: { field: UPDATED_AT, direction: DESC }) {
          ${PAGE} nodes { ${fields} ${status} }
        }
      }
    }
    ${fragment}`
  return { query, size: pageSize(fragment + status) }
}

export const SEARCH = `
  query($q: String!, $after: String) {
    search(type: ISSUE, query: $q, first: ${pageSize(ISSUE, PR + STATUS)}, after: $after) {
      issueCount ${PAGE}
      nodes { ... on Issue { ...IssueFields } ... on PullRequest { ...PrFields ${STATUS} } }
    }
  }
  ${ISSUE} ${PR}`

export const NODES = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) { id ... on Issue { ...IssueFields } ... on PullRequest { ...PrFields ${STATUS} } }
  }
  ${ISSUE} ${PR}`

export const PR_STATUS = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) { ... on PullRequest { id isDraft reviewDecision ${STATUS} } }
  }`

/** The open pull requests that ask for a review from the viewer, or from a team of theirs. Each costs a point. */
export const REVIEW_REQUESTED = `
  query($q: String!, $after: String) {
    viewer { login }
    search(type: ISSUE, query: $q, first: 100, after: $after) { ${PAGE} nodes { ... on PullRequest { id } } }
  }`

export interface Page<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: T[]
}

export interface RawRepoBasics {
  id: string
  name: string
  nameWithOwner: string
  description: string | null
  isPrivate: boolean
  isArchived: boolean
  pushedAt: string | null
  owner: { login: string; avatarUrl: string }
  primaryLanguage: Language | null
}

export interface RawRepo extends RawRepoBasics {
  openIssues: { totalCount: number }
  openPrs: { totalCount: number }
  allIssues: { totalCount: number }
  allPrs: { totalCount: number }
}

export function toRepoBasics(raw: RawRepoBasics): RepoBasics {
  return {
    id: raw.id,
    owner: raw.owner.login,
    ownerAvatar: raw.owner.avatarUrl,
    name: raw.name,
    fullName: raw.nameWithOwner,
    description: raw.description,
    language: raw.primaryLanguage,
    isPrivate: raw.isPrivate,
    isArchived: raw.isArchived,
    pushedAt: raw.pushedAt,
  }
}

export function toRepo(raw: RawRepo): Repo {
  return {
    ...toRepoBasics(raw),
    openIssues: raw.openIssues.totalCount,
    openPrs: raw.openPrs.totalCount,
    issues: raw.allIssues.totalCount,
    prs: raw.allPrs.totalCount,
  }
}

export interface RawItem {
  kind: 'Issue' | 'PullRequest'
  id: string
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  stateReason?: string | null
  isDraft?: boolean
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  additions?: number
  deletions?: number
  createdAt: string
  updatedAt: string
  author: Person | null
  assignees: { nodes: Person[] }
  labels: { nodes: { name: string; color: string }[] } | null
  comments: { totalCount: number }
  repository: { id: string }
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
}

export function toItem(raw: RawItem): Item {
  const isPr = raw.kind === 'PullRequest'
  return {
    id: raw.id,
    kind: isPr ? 'pr' : 'issue',
    repoId: raw.repository.id,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: toState(raw.state),
    notPlanned: closedAs(raw.stateReason) !== 'completed',
    author: raw.author,
    assignees: raw.assignees.nodes,
    labels: raw.labels?.nodes ?? [],
    comments: raw.comments.totalCount,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(isPr ? toStatus(raw, raw.state === 'OPEN') : { review: null, checks: null, merge: null }),
    diff: isPr ? { additions: raw.additions ?? 0, deletions: raw.deletions ?? 0 } : null,
  }
}

/** What a pull request's status says. */
export const STATUS_FIELDS = ['review', 'checks', 'merge'] as const

export type RawStatus = Pick<RawItem, 'isDraft' | 'reviewDecision' | 'mergeable' | 'commits'>

/** A closed pull request has no checks or conflicts that still matter, so it shows none. */
export function toStatus(raw: RawStatus, open: boolean): Pick<Item, (typeof STATUS_FIELDS)[number]> {
  const state = raw.commits?.nodes[0]?.commit.statusCheckRollup?.state
  return { review: toReview(raw), checks: open ? toChecks(state) : null, merge: open ? toMerge(raw) : null }
}

// GitHub gives no decision where the branch doesn't require a review, even after someone approves.
export function toReview(raw: Pick<RawItem, 'isDraft' | 'reviewDecision'>): Review {
  if (raw.isDraft) return 'draft'
  if (raw.reviewDecision === 'APPROVED') return 'approved'
  if (raw.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  if (raw.reviewDecision === 'REVIEW_REQUIRED') return 'required'
  return 'optional'
}

export function toMerge(raw: Pick<RawItem, 'mergeable'>): Merge | null {
  if (raw.mergeable === 'CONFLICTING') return 'conflicts'
  if (raw.mergeable === 'MERGEABLE') return 'clean'
  return null
}

type ClosedAs = Exclude<IssueState, 'open'>
const CLOSED_AS: Partial<Record<string, ClosedAs>> = { NOT_PLANNED: 'notPlanned', DUPLICATE: 'duplicate' }

/** Why a closed issue was closed, as GitHub's `stateReason` says. Done, unless it says otherwise. */
export const closedAs = (reason: string | null | undefined): ClosedAs => CLOSED_AS[reason ?? ''] ?? 'completed'

/** An issue's or pull request's state, as GitHub's `state` says. */
export const toState = (state: RawItem['state']): ItemState =>
  state === 'OPEN' ? 'open' : state === 'MERGED' ? 'merged' : 'closed'

/** A pull request's state, with a draft apart from the others that are open. */
export const pullState = (state: ItemState, draft: boolean): PullState => (state === 'open' && draft ? 'draft' : state)

/** The state of an issue as toItem() keeps it, which counts a duplicate as not planned. */
export const stateOf = (item: Pick<Item, 'state' | 'notPlanned'>): Exclude<IssueState, 'duplicate'> =>
  item.state === 'open' ? 'open' : item.notPlanned ? 'notPlanned' : 'completed'

/** A combined or single commit status, as GitHub states it. */
export function toChecks(state: string | null | undefined): Checks | null {
  if (state === 'SUCCESS') return 'success'
  if (state === 'FAILURE' || state === 'ERROR') return 'failure'
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
  return null
}
