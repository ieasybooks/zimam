<script setup lang="ts">
import UAvatar from '@nuxt/ui/components/Avatar.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCheckbox from '@nuxt/ui/components/Checkbox.vue'
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue'
import type { DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import USkeleton from '@nuxt/ui/components/Skeleton.vue'
import { computed, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import ChoiceGroup from '@/components/ChoiceGroup.vue'
import FacetMenu from '@/components/FacetMenu.vue'
import { REPO_STATUSES, type RepoStatus } from '@/lib/filters'
import type { GitHub } from '@/lib/github'
import { CONTRIBUTION_SORTS, defaultContributionFilters, pickContributions, toggleStatus } from '@/lib/repos'
import {
  brings,
  CONTRIBUTION_KINDS,
  contributionsOf,
  sameSource,
  type Contribution,
  type ContributionKind,
  type OpenedKind,
} from '@/lib/sources'
import { formatNumber, relativeTime } from '@/locale'
import { now } from '@/stores/clock'
import type { RepoBasics, Source } from '@/types'

// The repositories someone contributed to, to add each as a repository of its own.
const props = defineProps<{ gh: GitHub; login: string }>()
const picked = defineModel<Source[]>('picked', { required: true })
const { t } = useI18n()

const ICONS: Record<ContributionKind, string> = {
  commit: 'i-octicon-git-commit-16',
  pr: 'i-octicon-git-pull-request-16',
  issue: 'i-octicon-issue-opened-16',
  review: 'i-octicon-code-review-16',
}

const entries = shallowRef<Contribution[] | null>(null)
const reposCut = ref(false)
const countsCut = ref<OpenedKind[]>([])
const failed = ref(false)

// Only the latest load reads on and shows: one for an earlier token stops before its next page.
let current: AbortController | null = null
async function load() {
  current?.abort()
  const controller = (current = new AbortController())
  failed.value = false
  entries.value = null
  try {
    const found = await contributionsOf(props.gh, props.login, controller.signal)
    if (controller.signal.aborted) return
    entries.value = found.contributions
    reposCut.value = found.reposCut
    countsCut.value = found.countsCut
  } catch {
    if (!controller.signal.aborted) failed.value = true
  }
}
void load()
onUnmounted(() => current?.abort())
// A new token may see other repositories, or be someone else's.
watch(() => [props.gh, props.login], load)

const filters = reactive(defaultContributionFilters())
const result = computed(() => pickContributions(entries.value ?? [], filters))
const shown = computed(() => result.value.shown)

const totals = computed(() => {
  const list = entries.value ?? []
  return {
    repos: list.length,
    prs: list.reduce((sum, entry) => sum + entry.prs, 0),
    issues: list.reduce((sum, entry) => sum + entry.issues, 0),
    owners: new Set(list.map((entry) => entry.repo.owner)).size,
  }
})

const statuses = computed(() =>
  REPO_STATUSES.map((value) => ({ value, label: t(`filters.status.${value}`), count: result.value.statuses[value] })),
)
const kinds = computed(() =>
  CONTRIBUTION_KINDS.map((value) => ({ value, label: t(`contrib.kinds.${value}`), count: result.value.kinds[value] })),
)
const owners = computed(() =>
  [...result.value.owners].map(([value, { count, avatar }]) => ({ value, label: value, count, avatar })),
)
const sortItems = computed<DropdownMenuItem[]>(() =>
  CONTRIBUTION_SORTS.map((sort) => ({
    label: t(`contrib.sorts.${sort}`),
    type: 'checkbox',
    checked: filters.sort === sort,
    onSelect: () => (filters.sort = sort),
  })),
)

function toggleIn<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((other) => other !== value) : [...list, value]
}

const asSource = (repo: RepoBasics): Source => ({ kind: 'repo', name: repo.fullName })
const isPicked = (repo: RepoBasics) => picked.value.some((source) => sameSource(source, asSource(repo)))
/** The account the workspace already brings the repository with, if any. */
const broughtBy = (repo: RepoBasics) =>
  picked.value.find((source) => source.kind !== 'repo' && brings(source, repo))?.name ?? null

function tick(repo: RepoBasics, on: boolean | 'indeterminate') {
  const others = picked.value.filter((source) => !sameSource(source, asSource(repo)))
  picked.value = on === true ? [...others, asSource(repo)] : others
}

const free = (entry: Contribution) => !broughtBy(entry.repo) && !isPicked(entry.repo)
const pickedHere = computed(() => (entries.value ?? []).filter((entry) => isPicked(entry.repo)))
const hidden = computed(() => {
  const visible = new Set(shown.value)
  return pickedHere.value.filter((entry) => !visible.has(entry)).length
})
const addable = computed(() => shown.value.filter(free))

function tickShown() {
  picked.value = [...picked.value, ...addable.value.map((entry) => asSource(entry.repo))]
}

function clearHere() {
  const here = new Set(pickedHere.value.map((entry) => entry.repo.fullName.toLowerCase()))
  picked.value = picked.value.filter((source) => source.kind !== 'repo' || !here.has(source.name.toLowerCase()))
}

const filtered = computed(
  () =>
    filters.q.trim() !== '' ||
    filters.kinds.length > 0 ||
    filters.owners.length > 0 ||
    filters.status.join() !== defaultContributionFilters().status.join(),
)

function resetFilters() {
  Object.assign(filters, { ...defaultContributionFilters(), sort: filters.sort })
}

// Past the pages read, a repository may hold more of what was opened than were counted.
const count = (kind: OpenedKind, n: number) =>
  t(`contrib.${kind === 'pr' ? 'prs' : 'issues'}${countsCut.value.includes(kind) ? 'AtLeast' : ''}`, n)

/** Each way someone contributed to a repository, with a figure for the pull requests and issues they opened in it. */
function tallies(entry: Contribution) {
  return entry.kinds.map((kind) => {
    const n = kind === 'pr' ? entry.prs : kind === 'issue' ? entry.issues : 0
    if (n && (kind === 'pr' || kind === 'issue'))
      return { kind, figure: formatNumber(n) + (countsCut.value.includes(kind) ? '+' : ''), label: count(kind, n) }
    return { kind, figure: '', label: t(`contrib.kinds.${kind}`) }
  })
}

const lastOpened = (entry: Contribution) =>
  entry.lastAt ? t('contrib.lastOpened', { time: relativeTime(Date.parse(entry.lastAt), now.value) }) : ''
</script>

<template>
  <div class="space-y-3 p-3">
    <div v-if="failed" class="flex flex-col items-center gap-2 py-6 text-center">
      <p class="text-sm text-toned">{{ t('contrib.failed') }}</p>
      <UButton color="neutral" variant="outline" size="sm" :label="t('sync.retry')" @click="load" />
    </div>
    <div v-else-if="!entries" class="space-y-3" aria-busy="true">
      <p class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-octicon-sync-16" class="size-4 animate-spin motion-reduce:animate-none" />
        {{ t('contrib.loading') }}
      </p>
      <div class="space-y-3 rounded-md border border-default p-3">
        <USkeleton v-for="index in 5" :key="index" class="h-4" :style="{ width: `${30 + ((index * 17) % 40)}%` }" />
      </div>
    </div>
    <template v-else>
      <!-- Nothing found in a cut read may only mean nothing found yet, so the notices show either way. -->
      <p v-if="!entries.length" class="py-6 text-center text-sm text-muted">
        {{ t(reposCut ? 'contrib.noneRead' : 'contrib.none') }}
      </p>
      <dl v-else class="enter grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div
          v-for="stat in [
            { key: 'repos', value: totals.repos, capped: reposCut },
            { key: 'owners', value: totals.owners, capped: reposCut },
            { key: 'prs', value: totals.prs, capped: countsCut.includes('pr') },
            { key: 'issues', value: totals.issues, capped: countsCut.includes('issue') },
          ]"
          :key="stat.key"
          class="rounded-md bg-elevated/50 px-3 py-2"
        >
          <dt class="truncate text-xs text-muted">{{ t(`contrib.stats.${stat.key}`) }}</dt>
          <dd class="font-mono text-lg font-medium text-highlighted tabular-nums">
            {{ formatNumber(stat.value) }}<span v-if="stat.capped">+</span>
          </dd>
        </div>
      </dl>
      <p v-if="reposCut" class="text-xs text-muted">{{ t('contrib.reposCut') }}</p>
      <p v-if="countsCut.length" class="text-xs text-muted">{{ t('contrib.countsCut') }}</p>

      <template v-if="entries.length">
        <div class="flex flex-wrap items-center gap-2">
          <UInput
            v-model="filters.q"
            icon="i-octicon-search-16"
            :placeholder="t('contrib.search')"
            :aria-label="t('contrib.search')"
            class="min-w-40 flex-1"
          />
          <UDropdownMenu :items="sortItems" :content="{ align: 'end' }">
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-octicon-sort-desc-16"
              :label="t(`contrib.sorts.${filters.sort}`)"
              :aria-label="t('filters.sort')"
              :ui="{ base: 'text-toned', leadingIcon: 'text-muted' }"
            />
          </UDropdownMenu>
        </div>
        <div
          class="-mx-3 flex [scrollbar-width:none] items-center gap-2 overflow-x-auto px-3 *:shrink-0 sm:flex-wrap sm:overflow-visible"
        >
          <ChoiceGroup
            :label="t('contrib.kindsTitle')"
            :choices="kinds"
            :picked="(value) => filters.kinds.includes(value as ContributionKind)"
            @pick="filters.kinds = toggleIn(filters.kinds, $event as ContributionKind)"
          />
          <FacetMenu
            v-if="owners.length > 1 || filters.owners.length"
            :title="t('filters.owner.title')"
            :options="owners"
            :picked="filters.owners"
            @toggle="filters.owners = toggleIn(filters.owners, $event)"
          />
          <ChoiceGroup
            :label="t('filters.status.title')"
            :choices="statuses"
            :picked="(value) => filters.status.includes(value as RepoStatus)"
            @pick="toggleStatus(filters, $event as RepoStatus)"
          />
          <UButton
            v-if="filtered"
            color="neutral"
            variant="link"
            size="sm"
            :label="t('filters.clear')"
            @click="resetFilters"
          />
        </div>

        <div
          class="enter max-h-96 overflow-y-auto rounded-md border border-default"
          role="group"
          :aria-label="t('contrib.title')"
        >
          <label
            v-for="entry in shown"
            :key="entry.repo.id"
            class="flex cursor-pointer items-start gap-3 border-b border-default px-3 py-3 transition-colors last:border-b-0 hover:bg-elevated/50"
            :class="broughtBy(entry.repo) && 'cursor-default'"
          >
            <UCheckbox
              class="mt-0.5"
              :model-value="isPicked(entry.repo) || !!broughtBy(entry.repo)"
              :disabled="!!broughtBy(entry.repo)"
              @update:model-value="tick(entry.repo, $event)"
            />
            <UAvatar :src="entry.repo.ownerAvatar" :alt="entry.repo.owner" size="2xs" class="mt-0.5" />
            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 items-center gap-2">
                <bdi class="min-w-0 truncate text-sm text-highlighted" dir="ltr">
                  <span class="text-toned">{{ entry.repo.owner }}/</span>{{ entry.repo.name }}
                </bdi>
                <UIcon
                  v-if="entry.repo.isPrivate"
                  name="i-octicon-lock-16"
                  class="size-4 shrink-0 text-muted"
                  :aria-label="t('contrib.private')"
                />
                <span
                  v-if="entry.repo.isArchived"
                  class="inline-flex h-5 shrink-0 items-center rounded-sm px-1.5 text-xs text-toned ring-1 ring-default ring-inset"
                  >{{ t('item.archived') }}</span
                >
                <span
                  v-if="broughtBy(entry.repo)"
                  class="inline-flex h-5 shrink-0 items-center rounded-sm px-1.5 text-xs text-toned ring-1 ring-default ring-inset"
                  >{{ t('contrib.via', { name: broughtBy(entry.repo) }) }}</span
                >
              </span>
              <span v-if="entry.repo.description" class="mt-0.5 block truncate text-xs text-muted" dir="auto">{{
                entry.repo.description
              }}</span>
              <span class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-toned">
                <span
                  v-for="tally in tallies(entry)"
                  :key="tally.kind"
                  class="inline-flex items-center gap-1.5"
                  :title="tally.label"
                >
                  <UIcon :name="ICONS[tally.kind]" class="size-4 text-muted" />
                  <span v-if="tally.figure" class="font-mono tabular-nums" aria-hidden="true">{{ tally.figure }}</span>
                  <span class="sr-only">{{ tally.label }}</span>
                </span>
                <span v-if="entry.repo.language" class="flex items-center gap-1">
                  <span
                    class="size-2 rounded-full"
                    :style="{ background: entry.repo.language.color ?? 'currentColor' }"
                    aria-hidden="true"
                  />
                  {{ entry.repo.language.name }}
                </span>
                <span v-if="entry.lastAt" class="text-muted">{{ lastOpened(entry) }}</span>
              </span>
            </span>
          </label>
          <p v-if="!shown.length" class="px-3 py-6 text-center text-sm text-muted">{{ t('filters.nothing') }}</p>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
          <span class="text-toned">
            {{ t('contrib.pickedCount', { n: formatNumber(pickedHere.length) }, pickedHere.length) }}
            <span v-if="hidden" class="text-muted"
              >· {{ t('contrib.hidden', { n: formatNumber(hidden) }, hidden) }}</span
            >
          </span>
          <span class="flex items-center gap-3">
            <UButton
              color="neutral"
              variant="link"
              size="sm"
              class="p-0"
              :disabled="!addable.length"
              :label="t('contrib.pickShown', { n: formatNumber(addable.length) }, addable.length)"
              @click="tickShown"
            />
            <UButton
              color="neutral"
              variant="link"
              size="sm"
              class="p-0"
              :disabled="!pickedHere.length"
              :label="t('setup.clearPicked')"
              @click="clearHere"
            />
          </span>
        </div>
      </template>
    </template>
  </div>
</template>
