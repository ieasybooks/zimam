# Zimam

Every issue and pull request across your GitHub organizations, in one fast, filterable list.

**[zimam.ieasybooks.com](https://zimam.ieasybooks.com)** · Arabic and English

[![CI](https://github.com/ieasybooks/zimam/actions/workflows/ci.yml/badge.svg)](https://github.com/ieasybooks/zimam/actions/workflows/ci.yml)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.webp">
  <img alt="Zimam showing the open issues and pull requests of the nuxt organization" src="docs/screenshot-light.webp">
</picture>

## Features

- **One list across sources.** A workspace mixes organizations, user accounts and single repositories. An account brings all its repositories, new ones included, or only those you pick. Keep as many workspaces as you like.
- **Find your contributions.** A workspace's sources can include the repositories you contributed to anywhere on GitHub: committed to, opened pull requests or issues in, or reviewed. Search them by name or description, filter by kind of contribution, account and archived state, sort by what you opened last or most, and add the ones you want. Settings has a shortcut to them.
- **Faceted filters with live counts.** Type, state, active or archived repository, account, repository, label, author, assignee, what involves you, review, checks, conflicts and last activity. Each value shows how many items picking it would give.
- **Typed filters.** The search box takes qualifiers like `author:name`, `label:bug,docs`, `repo:name`, `is:draft` and `no:assignee`, and a minus before one leaves its matches out: `-author:renovate`.
- **Pull requests at a glance.** Each open pull request shows its checks, whether a review is required, approved or asked to change, whether it conflicts with its base branch, and its size. Its checks icon opens the list of checks with links to their logs. Sorting by "Ready to merge" puts approved, passing pull requests first.
- **Read issues in Zimam.** Click an issue to read its description and comments beside the list, or over it on a smaller screen, in Zimam's type and colors. Its ↑ and ↓ buttons go to the previous or next issue in the list, and the address names the open one. Reading is read-only: replying stays on GitHub.
- **Review pull requests in Zimam.** A pull request opens on its own page, at GitHub's address on Zimam's host. Zimam diffs each changed file itself, with highlighted code and review threads under their lines, and keeps the files, conversation, commits and checks in a column beside the diff. Pick a commit, or a run of them with Shift, to see only what they changed. Tick files as viewed in all the changes or commit by commit: ticks on the commits add up to all the changes, a folder whose files are all viewed folds, and they're remembered in the browser with what's new since your last visit. Generated files are left out, by GitHub's list, the repository's `.gitattributes` and your own patterns. Reviewing is read-only: comments and approvals stay on GitHub.
- **People.** Every name and picture links to the person's GitHub page, with a card about them on hover or focus.
- **Keyboard.** `?` lists the shortcuts. `/` searches, `1`–`9` open saved views, and `j` and `k` move through rows, issues and a diff's changes. A pull request has keys for its parts, its commits and its files. Shortcuts follow where the keys are, so they work with an Arabic layout too.
- **What involves you.** Pull requests that ask you or your team for a review, and what you opened or are assigned to.
- **Repositories page.** Every repository in the workspace with its open issues and pull requests, those awaiting a required review, failing checks or conflicting, its last activity, and bars of what was opened each week over six months. Each count opens the list it counts. Pin the repositories you watch to keep them on top, in the order you drag them into, whatever the sort.
- **Views are URLs.** Save filter sets in the sidebar; every screen is a link you can share or bookmark.
- **Near-live.** Changes appear within a minute while the tab is open, and the rows that changed are marked.
- **Fast.** Opens from a local cache in under a second and scrolls thousands of rows with virtual rendering.
- **Installable.** Install it as an app on a computer or phone. It opens without a network and shows what was saved.
- **Arabic and English.** Right-to-left layout, Arabic plural forms, and search that folds Arabic spelling variants (hamza, tā' marbūṭa, diacritics).
- Light and dark themes, comfortable or compact rows.

## How it works

Zimam is a static single-page app with no backend: the browser calls GitHub's GraphQL API directly, with the token you give it.

- **First load.** Open issues and pull requests load first, per repository, four at a time. The closed history then loads in the background, in 45-second slices with a check for changes before each one, and resumes where it stopped. Each page holds as many items as still cost one point: 74 issues, or 49 open pull requests with their checks.
- **Updates.** Every minute, a search for issues and one for pull requests per eight sources find everything updated since the last check (`updated:>=`, with a 10-minute overlap for the search index's lag). They're apart because a fine-grained token's search finds nothing without `is:issue` or `is:pr`. Rows that changed are marked for a few seconds. An account with only some repositories picked is still searched as a whole, and changes elsewhere in it are dropped; the repositories it leaves out are never read.
- **Quiet minutes are free.** When the last search found nothing, Zimam first asks GitHub's REST API for each source's most recently updated issue, with the ETag of its last answer. An unchanged answer costs nothing, and when every source is unchanged the search is skipped. It still runs at least every 5 minutes. Organizations use one address for all their repositories when the token may read it, and each active repository otherwise.
- **What search can't see.** A finished CI run doesn't change a pull request's `updatedAt`, and neither does its base branch moving on, so the checks, reviews and conflicts of open pull requests in active repositories are read again on their own, 50 at a time: every minute while checks run, every 5 minutes while they fail, every 15 otherwise. Review requests can go to a team, so a search for `review-requested:@me` finds them every 5 minutes. Deleted and transferred items are caught by refetching the open items every 6 hours, and only what GitHub reports as gone is removed.
- **Rate limits.** GitHub's hourly allowance is shared by every tool on your account. Zimam leaves 2% of it for the others, loads history only while more than 15% remains, and pauses until the reset time GitHub reports. When GitHub asks for a pause without a time, each pause in a row doubles, from 30 seconds up to 15 minutes. A request with no answer after 30 seconds is given up on.
- **Finding your contributions.** GitHub lists the repositories you recently committed to, opened pull requests or issues in, or reviewed, in one query. Your pull requests and issues, the latest 1,000 of each, 100 a page, add the older ones and the counts. A fine-grained token can't read GitHub's contribution calendar, so Zimam doesn't use it. What you add becomes a repository of its own in the workspace.
- **Reading an issue.** One query reads the issue and its first 100 comments as GitHub renders them, for one point, and each further 100 comments cost another. GitHub signs the image links in that HTML for five minutes, so an answer is reused for a minute at most, and read again when the list sees the issue change.
- **Reading a pull request.** One query reads the pull request with its conversation and review threads, for about 2 points. Its changed files come from one REST comparison of its base and head, which lists up to 300 files; a larger pull request lists them 100 at a time. The files' texts come from GraphQL, 100 files for 1 point, each cut at 512 KB. A commit's own changes are one more comparison, read the first time they're shown, and a person's card reads their profile once a session, for 1 point.
- **Offline.** A service worker keeps the app's own files, never GitHub's responses, so the app opens without a network and shows the cached list. Syncing resumes as soon as the connection is back. A new version waits until you reload.
- **Storage.** Each workspace's items are cached in IndexedDB, settings and views in `localStorage`. With several tabs open, one tab syncs (Web Locks) and the others pick up its cache (BroadcastChannel).
- **Filtering** is one pass over the cached items, so results and counts update as you click. Filters live in the URL's query string.

## Security

- Your token stays in your browser's storage and is sent only to `api.github.com`.
- A Content Security Policy enforces it: the page can connect only to GitHub's API and Cloudflare Web Analytics, and load images only from GitHub's image hosts (`*.githubusercontent.com`), which also proxy the outside images people link to.
- Issue text is cleaned again with DOMPurify before it is shown, though GitHub cleans it too: only text, links, images, code, tables and lists stay. Links open in a new tab that can't reach Zimam's page.
- Settings exports leave tokens out.

## Tokens

Read access is enough. Each workspace keeps its own token.

| Token                                                                                                                                                                                                           | Reaches                                   | Permissions                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| [Fine-grained](https://github.com/settings/personal-access-tokens/new?name=Zimam&description=Read-only+access+for+Zimam&expires_in=90&contents=read&issues=read&pull_requests=read&metadata=read&statuses=read) | One organization or account, as its owner | Contents, issues, pull requests, metadata and commit statuses: read-only |
| [Classic](https://github.com/settings/tokens/new?scopes=repo,read:org&description=Zimam)                                                                                                                        | Every organization you belong to          | `repo` and `read:org` (without `repo`, public repositories only)         |

## Stack

Vue 3, Nuxt UI, vue-i18n, TanStack Virtual, DOMPurify, jsdiff, Shiki, Vite, Bun, Vitest, oxlint and oxfmt. Hosted as static assets on Cloudflare Workers.

## Development

```sh
mise install     # pinned Bun and Node
bun install
mise dev         # http://127.0.0.1:5190
mise check       # format, lint and types
mise test        # unit tests
```

In development, the setup screen can use your `gh` CLI's token, so there is nothing to paste.

`main` deploys to Cloudflare Workers from GitHub Actions once its checks pass.

## The name

Zimam (زمام) means "reins". In 162 AH (778–79 CE), the Abbasid caliph al-Mahdī created the Dīwān al-Zimām, the office that oversaw all the others.
