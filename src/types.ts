export const LOCALES = ['ar', 'en'] as const
export const THEMES = ['system', 'light', 'dark'] as const
export const DENSITIES = ['comfortable', 'compact'] as const
export const ROW_PARTS = ['labels', 'author', 'assignees', 'comments', 'review', 'checks', 'size'] as const
export const PRESETS = ['open', 'issues', 'prs', 'awaiting', 'mine', 'quiet', 'archive'] as const

export const ITEM_KINDS = ['issue', 'pr'] as const
export const ITEM_STATES = ['open', 'closed', 'merged'] as const
/** `required` waits on a review GitHub requires. `optional` needs none: the branch doesn't require one. */
export const REVIEWS = ['draft', 'required', 'optional', 'approved', 'changes'] as const
export const CHECKS = ['success', 'failure', 'pending'] as const
/** Whether an open pull request conflicts with its base branch. */
export const MERGES = ['conflicts', 'clean'] as const
/** How an item involves the person whose token reads it. */
export const INVOLVEMENTS = ['review', 'assigned', 'authored'] as const

export type Locale = (typeof LOCALES)[number]
export type Theme = (typeof THEMES)[number]
export type Density = (typeof DENSITIES)[number]
export type RowPart = (typeof ROW_PARTS)[number]
export type RowParts = Record<RowPart, boolean>
export type Preset = (typeof PRESETS)[number]

export type ItemKind = (typeof ITEM_KINDS)[number]
export type ItemState = (typeof ITEM_STATES)[number]
/** An issue is open, or closed as done, as not planned or as a duplicate. */
export type IssueState = 'open' | 'completed' | 'notPlanned' | 'duplicate'
/** A pull request is open, a draft, merged, or closed without merging. */
export type PullState = 'open' | 'draft' | 'merged' | 'closed'
export type Review = (typeof REVIEWS)[number]
/** Where a pull request stands on review: a verdict, someone still asked to review, or what its branch's rules ask. */
export type ReviewStanding = 'approved' | 'changes' | 'awaiting' | Review
export type Checks = (typeof CHECKS)[number]
export type Merge = (typeof MERGES)[number]
export type Involvement = (typeof INVOLVEMENTS)[number]

export const SOURCE_KINDS = ['org', 'user', 'repo'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export interface Source {
  kind: SourceKind
  /** A user or organization login, or `owner/name` for a single repository. */
  name: string
  /** The ids of the only repositories an account brings. Without it, it brings all of them, new ones too. */
  only?: string[]
}

export interface View {
  id: string
  /** A name the person typed. Views Zimam made have a `preset` instead, so they follow the language. */
  name?: string
  preset?: Preset
  /** The filters, as the URL's search string. */
  query: string
}

export interface Workspace {
  id: string
  name: string
  token: string
  sources: Source[]
  views: View[]
  /** Repositories kept at the top of the repositories page, by id, in the order they were put in. */
  pinned: string[]
}

// How posts and diffs read: bots' posts, in the issue panel too, then the pull request page's own.
export const BOT_POSTS = ['show', 'collapse', 'hide'] as const
export const LONG_LINES = ['wrap', 'scroll'] as const
export const DIFF_VIEWS = ['split', 'unified'] as const
export const FILE_MODES = ['all', 'one'] as const
export type BotPosts = (typeof BOT_POSTS)[number]
export type LongLines = (typeof LONG_LINES)[number]
export type DiffView = (typeof DIFF_VIEWS)[number]
export type FileMode = (typeof FILE_MODES)[number]

export interface Settings {
  /** Which of the changes in settings.ts these settings have had. */
  version: number
  /** How posts by bots show: as any other, folded to a line, or not at all. */
  bots: BotPosts
  longLines: LongLines
  diffView: DiffView
  /** Every changed file in one scroll, or one at a time. A pull request can override it. */
  files: FileMode
  /** Hide changes in whitespace alone. */
  ignoreSpace: boolean
  /** Paths to treat as generated, besides GitHub's own list and each repository's .gitattributes. */
  generated: string[]
  locale: Locale
  theme: Theme
  density: Density
  show: RowParts
  workspaces: Workspace[]
  activeWorkspaceId: string | null
}

/** A repository without its counts, as the lists of what someone contributed to show it. */
export interface RepoBasics {
  id: string
  owner: string
  ownerAvatar: string
  name: string
  fullName: string
  description: string | null
  language: Language | null
  isPrivate: boolean
  isArchived: boolean
  /** The last push to any branch. */
  pushedAt: string | null
}

export interface Repo extends RepoBasics {
  openIssues: number
  openPrs: number
  issues: number
  prs: number
}

/** The person whose token reads a workspace, and the open pull requests that ask them, or a team of theirs, to review. */
export interface Me {
  login: string | null
  requested: Set<string>
}

/** Nobody yet: before the first answer names the person. */
export const noOne = (): Me => ({ login: null, requested: new Set() })

export interface Language {
  name: string
  color: string | null
}

export interface Person {
  login: string
  avatarUrl: string
}

export interface Label {
  name: string
  color: string
}

export interface Item {
  id: string
  kind: ItemKind
  repoId: string
  number: number
  title: string
  url: string
  state: ItemState
  notPlanned: boolean
  author: Person | null
  assignees: Person[]
  labels: Label[]
  comments: number
  createdAt: string
  updatedAt: string
  review: Review | null
  checks: Checks | null
  /** Unknown until GitHub has worked it out, and for issues. */
  merge: Merge | null
  /** Lines added and removed, for pull requests. */
  diff: { additions: number; deletions: number } | null
}
