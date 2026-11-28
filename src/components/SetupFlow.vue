<script setup lang="ts">
import UAlert from '@nuxt/ui/components/Alert.vue'
import UAvatar from '@nuxt/ui/components/Avatar.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UTooltip from '@nuxt/ui/components/Tooltip.vue'
import { computed, nextTick, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import BrandMark from '@/components/BrandMark.vue'
import ChoiceGroup from '@/components/ChoiceGroup.vue'
import ContribPicker from '@/components/ContribPicker.vue'
import LanguageSwitch from '@/components/LanguageSwitch.vue'
import RepoPicker from '@/components/RepoPicker.vue'
import SetupPreview from '@/components/SetupPreview.vue'
import { DEV_TOKEN_PATH } from '@/dev'
import { createGitHub, GitHubError, type GitHub } from '@/lib/github'
import { findSource, findViewer, sameSource, sourceKey, type SourceChoice, type Viewer } from '@/lib/sources'
import { activeWorkspace, createWorkspace, updateWorkspace } from '@/stores/settings'
import { ui } from '@/stores/ui'
import type { Source } from '@/types'

const { t } = useI18n()

const workspace = ui.setup === 'edit' ? activeWorkspace.value : null
const cancellable = !!activeWorkspace.value

const isDev = import.meta.env.DEV
// Zimam's own code, for anyone who wants to check what happens to their token.
const CODE = 'https://github.com/ieasybooks/zimam'
// Contents is for a pull request's diff: its comparison and its files' texts. Statuses is for its checks.
const FINE_GRAINED =
  'https://github.com/settings/personal-access-tokens/new?name=Zimam&description=Read-only+access+for+Zimam&expires_in=90&contents=read&issues=read&pull_requests=read&metadata=read&statuses=read'
const CLASSIC = 'https://github.com/settings/tokens/new?scopes=repo,read:org&description=Zimam'

const token = ref(activeWorkspace.value?.token ?? '')
const gh = shallowRef<GitHub | null>(null)
const viewer = ref<Viewer | null>(null)
const scopes = ref<string[] | null>(null)
const checking = ref(false)
const tokenError = ref('')
// The token GitHub last accepted. What the field holds counts only while it's that token: one changed since is checked
// before it's saved, so a token GitHub didn't accept, or no token, never takes a working one's place.
const checkedToken = ref('')
const checked = computed(() => !!viewer.value && token.value.trim() === checkedToken.value)
// Each check's turn.
let checks = 0
const picked = ref<Source[]>(workspace ? [...workspace.sources] : [])
const extra = ref<SourceChoice[]>([])
const another = ref('')
const anotherError = ref('')
const adding = ref(false)
const name = ref(workspace?.name ?? '')
// Settings can open the setup on the repositories the person contributed to.
const contributing = ref(ui.contributions)
const contributions = ref<HTMLElement | null>(null)

const choices = computed<SourceChoice[]>(() => {
  if (!viewer.value) return []
  const known: SourceChoice[] = [
    {
      source: { kind: 'user', name: viewer.value.login },
      label: t('setup.yourAccount'),
      avatar: viewer.value.avatarUrl,
    },
    ...viewer.value.organizations.map((org) => ({
      source: { kind: 'org' as const, name: org.login },
      label: org.name || org.login,
      avatar: org.avatarUrl,
    })),
  ]
  const unknown = picked.value
    .filter((source) => ![...known, ...extra.value].some((choice) => sameSource(choice.source, source)))
    .map((source) => ({ source, label: source.name }))
  return [...known, ...extra.value, ...unknown]
})

// About the token checked, so only while the field still holds it.
const noPrivate = computed(() => checked.value && scopes.value !== null && !scopes.value.includes('repo'))
const defaultName = computed(() => {
  const first = picked.value[0]
  if (!first) return viewer.value?.login ?? 'Zimam'
  return (
    choices.value.find((choice) => sameSource(choice.source, first) && choice.source.kind === 'org')?.label ??
    first.name
  )
})

if (workspace) void check()

async function check() {
  const asked = token.value.trim()
  const turn = ++checks
  checking.value = true
  tokenError.value = ''
  try {
    const client = createGitHub(asked)
    const found = await findViewer(client)
    if (turn !== checks) return
    viewer.value = found
    scopes.value = client.scopes()
    gh.value = client
    checkedToken.value = asked
    if (contributing.value) void nextTick(() => contributions.value?.scrollIntoView({ block: 'start' }))
    if (!picked.value.length) {
      const org = viewer.value.organizations[0]
      picked.value = [org ? { kind: 'org', name: org.login } : { kind: 'user', name: viewer.value.login }]
    }
  } catch (error) {
    if (turn !== checks) return
    viewer.value = null
    gh.value = null
    checkedToken.value = ''
    tokenError.value =
      error instanceof GitHubError && error.kind === 'network' ? t('setup.offline') : t('setup.badToken')
  } finally {
    if (turn === checks) checking.value = false
  }
}

async function useGhToken() {
  const response = await fetch(DEV_TOKEN_PATH)
  if (!response.ok) {
    tokenError.value = t('setup.badToken')
    return
  }
  token.value = await response.text()
  await check()
}

function isPicked(source: Source) {
  return picked.value.some((other) => sameSource(other, source))
}

function toggle(source: Source) {
  picked.value = isPicked(source)
    ? picked.value.filter((other) => !sameSource(other, source))
    : [...picked.value, source]
}

// An account brings all its repositories, new ones too, or only those picked.
const accounts = computed(() => picked.value.filter((source) => source.kind !== 'repo'))
const unpicked = computed(() => picked.value.some((source) => source.only?.length === 0))
const BRINGS = ['all', 'some'] as const

function bringOnly(source: Source, only: string[] | undefined) {
  picked.value = picked.value.map((other) =>
    sameSource(other, source) ? { kind: other.kind, name: other.name, ...(only && { only }) } : other,
  )
}

// What each account had picked before switching to all, so switching back brings it back.
const pickedBefore = new Map<string, string[]>()

function bring(source: Source, which: string) {
  const key = sourceKey(source)
  if (which === 'all' && source.only) pickedBefore.set(key, source.only)
  bringOnly(source, which === 'some' ? (source.only ?? pickedBefore.get(key) ?? []) : undefined)
}

async function addAnother() {
  if (!another.value.trim() || !gh.value) return
  adding.value = true
  anotherError.value = ''
  try {
    const choice = await findSource(gh.value, another.value)
    if (!choice) throw new Error('Not found')
    if (!choices.value.some((known) => sameSource(known.source, choice.source))) extra.value.push(choice)
    if (!isPicked(choice.source)) picked.value.push(choice.source)
    another.value = ''
  } catch {
    anotherError.value = t('setup.notFound', { name: another.value.trim() })
  } finally {
    adding.value = false
  }
}

function finish() {
  const fields = { name: name.value.trim() || defaultName.value, token: checkedToken.value, sources: picked.value }
  if (workspace) updateWorkspace(workspace.id, fields)
  else createWorkspace(fields)
  ui.setup = null
}
</script>

<template>
  <main class="enter min-h-dvh bg-default" :class="!workspace && 'lg:grid lg:grid-cols-2'">
    <div class="flex flex-col px-6 py-6 sm:px-12 lg:min-h-dvh lg:px-16">
      <header class="flex h-10 items-center justify-between">
        <BrandMark />
        <div class="flex items-center gap-1">
          <LanguageSwitch />
          <UTooltip :text="t('setup.code')">
            <UButton
              :href="CODE"
              target="_blank"
              rel="noopener"
              icon="i-octicon-mark-github-16"
              color="neutral"
              variant="ghost"
              :aria-label="t('setup.code')"
              :ui="{ leadingIcon: 'text-toned' }"
            />
          </UTooltip>
        </div>
      </header>

      <div class="w-full max-w-lg pt-12 pb-16 lg:my-auto lg:py-16" :class="workspace && 'mx-auto'">
        <h1 class="text-[28px] leading-9 font-medium text-highlighted sm:text-4xl sm:leading-11">
          {{ t('setup.title') }}
        </h1>
        <p class="mt-4 text-lg leading-7 text-toned">{{ t('setup.intro') }}</p>

        <section class="mt-10 space-y-4">
          <h2 class="font-medium text-highlighted">{{ t('setup.tokenStep') }}</h2>
          <form class="flex gap-2" @submit.prevent="check">
            <UInput
              v-model="token"
              type="password"
              dir="ltr"
              autocomplete="off"
              placeholder="github_pat_…"
              class="flex-1"
              :aria-label="t('setup.tokenLabel')"
            />
            <UButton
              type="submit"
              color="neutral"
              :loading="checking"
              :disabled="!token.trim()"
              :label="t('setup.continue')"
            />
          </form>
          <p class="text-sm leading-relaxed text-toned">{{ t('setup.tokenHelp') }}</p>
          <ul class="space-y-1 text-sm">
            <li>
              <a :href="FINE_GRAINED" target="_blank" rel="noopener" class="font-medium text-primary hover:underline">{{
                t('setup.fineGrained')
              }}</a>
              <span class="text-muted"> · {{ t('setup.fineGrainedHelp') }}</span>
            </li>
            <li>
              <a :href="CLASSIC" target="_blank" rel="noopener" class="text-primary hover:underline">{{
                t('setup.classic')
              }}</a>
            </li>
          </ul>
          <UButton
            v-if="isDev"
            variant="outline"
            color="neutral"
            size="sm"
            icon="i-octicon-terminal-16"
            class="text-toned"
            :label="t('setup.useGh')"
            :ui="{ leadingIcon: 'text-muted' }"
            @click="useGhToken"
          />
          <UAlert
            v-if="tokenError"
            class="enter"
            color="error"
            variant="subtle"
            icon="i-octicon-alert-16"
            :title="tokenError"
          />
          <div v-if="viewer && checked" class="enter flex items-center gap-2 text-sm text-toned">
            <UAvatar :src="viewer.avatarUrl" :alt="viewer.login" size="2xs" />
            <span>{{ t('setup.readingAs', { login: viewer.name || viewer.login }) }}</span>
          </div>
          <p v-else-if="viewer && !checking && token.trim()" class="enter text-sm text-toned">
            {{ t('setup.checkAgain') }}
          </p>
          <UAlert
            v-if="noPrivate"
            color="warning"
            variant="subtle"
            icon="i-octicon-alert-16"
            :title="t('setup.noPrivate')"
          />
        </section>

        <section v-if="viewer" class="enter-below mt-8 space-y-4 border-t border-default pt-8">
          <h2 class="font-medium text-highlighted">{{ t('setup.sourcesStep') }}</h2>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              v-for="choice in choices"
              :key="`${choice.source.kind}:${choice.source.name}`"
              type="button"
              class="flex min-w-0 items-center gap-3 rounded-lg border p-3 text-start transition-colors"
              :class="
                isPicked(choice.source)
                  ? 'border-primary bg-primary/5'
                  : 'border-default hover:border-accented hover:bg-elevated/50'
              "
              :aria-pressed="isPicked(choice.source)"
              @click="toggle(choice.source)"
            >
              <UAvatar
                :src="choice.avatar"
                :alt="choice.source.name"
                :icon="choice.source.kind === 'repo' ? 'i-octicon-repo-16' : undefined"
                size="sm"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium text-highlighted rtl:text-right" dir="auto">{{
                  choice.label
                }}</span>
                <span class="block truncate font-mono text-xs text-muted rtl:text-right" dir="ltr">{{
                  choice.source.name
                }}</span>
              </span>
              <UIcon v-if="isPicked(choice.source)" name="i-octicon-check-16" class="size-4 shrink-0 text-primary" />
            </button>
          </div>
          <div
            v-for="source in accounts"
            :key="`${source.kind}:${source.name}`"
            class="rounded-lg border border-default"
          >
            <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3">
              <span class="min-w-0">
                <i18n-t keypath="setup.which" tag="span" scope="global" class="block text-sm text-highlighted">
                  <template #name>
                    <bdi class="font-mono text-[13px]">{{ source.name }}</bdi>
                  </template>
                </i18n-t>
                <span class="block text-xs text-muted">{{ t(source.only ? 'setup.someHelp' : 'setup.allHelp') }}</span>
              </span>
              <ChoiceGroup
                :label="t('setup.which', { name: source.name })"
                :choices="BRINGS.map((value) => ({ value, label: t(`setup.${value}`) }))"
                :picked="(value) => (value === 'some') === !!source.only"
                @pick="bring(source, $event)"
              />
            </div>
            <RepoPicker
              v-if="source.only && gh"
              :gh="gh"
              :source="source"
              :only="source.only"
              class="border-t border-default"
              @update:only="bringOnly(source, $event)"
            />
          </div>
          <div ref="contributions" class="scroll-mt-6 rounded-lg border border-default">
            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-lg p-3 text-start transition-colors hover:bg-elevated/50"
              :aria-expanded="contributing"
              @click="contributing = !contributing"
            >
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium text-highlighted">{{ t('contrib.title') }}</span>
                <span class="block text-xs text-muted">{{ t('contrib.help') }}</span>
              </span>
              <UIcon
                name="i-octicon-chevron-down-16"
                class="size-4 shrink-0 text-muted transition-transform"
                :class="contributing && 'rotate-180'"
              />
            </button>
            <ContribPicker
              v-if="contributing && gh"
              v-model:picked="picked"
              :gh="gh"
              :login="viewer.login"
              class="border-t border-default"
            />
          </div>
          <form class="space-y-2" @submit.prevent="addAnother">
            <label for="another" class="text-sm text-toned">{{ t('setup.another') }}</label>
            <div class="flex gap-2">
              <UInput
                id="another"
                v-model="another"
                dir="ltr"
                :placeholder="t('setup.anotherPlaceholder')"
                class="flex-1"
              />
              <UButton
                type="submit"
                color="neutral"
                variant="outline"
                :loading="adding"
                :disabled="!another.trim()"
                :label="t('setup.add')"
              />
            </div>
            <p v-if="anotherError" class="text-sm text-error">{{ anotherError }}</p>
          </form>
        </section>

        <section v-if="viewer && picked.length" class="enter-below mt-8 space-y-4 border-t border-default pt-8">
          <h2 class="font-medium text-highlighted">{{ t('setup.nameStep') }}</h2>
          <UFormField :label="t('setup.nameLabel')" :ui="{ label: 'font-normal text-toned' }">
            <UInput v-model="name" :placeholder="defaultName" class="w-full" />
          </UFormField>
        </section>

        <div v-if="viewer || cancellable" class="mt-8 flex justify-end gap-2">
          <UButton
            v-if="cancellable"
            color="neutral"
            variant="ghost"
            size="lg"
            :label="t('setup.cancel')"
            @click="ui.setup = null"
          />
          <UButton
            v-if="viewer"
            color="neutral"
            size="lg"
            :disabled="!checked || !picked.length || unpicked"
            :label="workspace ? t('setup.save') : t('setup.open')"
            trailing-icon="i-octicon-arrow-right-16"
            :ui="{ base: 'h-11 px-5', trailingIcon: 'rtl:rotate-180' }"
            @click="finish"
          />
        </div>
      </div>

      <footer class="space-y-1.5 text-xs leading-5 text-muted" :class="workspace && 'text-center'">
        <p>{{ t('app.about') }}</p>
        <a
          :href="CODE"
          target="_blank"
          rel="noopener"
          class="inline-flex items-center gap-1.5 rounded-sm text-toned focus-ring transition-colors hover:text-highlighted"
        >
          <UIcon name="i-octicon-mark-github-16" class="size-3.5" />
          {{ t('setup.openSource') }}
        </a>
      </footer>
    </div>

    <aside
      v-if="!workspace"
      class="flex items-center justify-center border-t border-default bg-muted px-6 py-12 sm:px-12 lg:sticky lg:top-0 lg:h-dvh lg:border-s lg:border-t-0"
    >
      <SetupPreview />
    </aside>
  </main>
</template>
