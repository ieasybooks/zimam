import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'

import ContribPicker from '@/components/ContribPicker.vue'
import type { GitHub } from '@/lib/github'
import type { Discovery } from '@/lib/sources'
import { i18n } from '@/locale'

// What discovery finds, set by each test.
const found = vi.hoisted(() => ({ discovery: null as Discovery | null }))
vi.mock('@/lib/sources', async (original) => ({
  ...(await original<typeof import('@/lib/sources')>()),
  contributionsOf: async () => found.discovery,
}))
// Nuxt UI's components need its Vite plugin, and the empty picker shows none of theirs that matter here.
const { nothing } = vi.hoisted(() => ({
  nothing: async () => {
    const vue = await import('vue')
    return { default: vue.defineComponent(() => () => null) }
  },
}))
vi.mock('@nuxt/ui/components/Avatar.vue', nothing)
vi.mock('@nuxt/ui/components/Button.vue', nothing)
vi.mock('@nuxt/ui/components/Checkbox.vue', nothing)
vi.mock('@nuxt/ui/components/DropdownMenu.vue', nothing)
vi.mock('@nuxt/ui/components/FieldGroup.vue', nothing)
vi.mock('@nuxt/ui/components/Icon.vue', nothing)
vi.mock('@nuxt/ui/components/Input.vue', nothing)
vi.mock('@nuxt/ui/components/Popover.vue', nothing)
vi.mock('@nuxt/ui/components/Skeleton.vue', nothing)

let wrapper: VueWrapper | null = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

async function picker(discovery: Discovery) {
  found.discovery = discovery
  wrapper = mount(ContribPicker, {
    props: { gh: {} as GitHub, login: 'ali', picked: [] },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return wrapper.text()
}

const { t } = i18n.global

it('says there are no contributions when everything was read', async () => {
  const text = await picker({ contributions: [], reposCut: false, countsCut: [] })
  expect(text).toContain(t('contrib.none'))
  expect(text).not.toContain(t('contrib.noneRead'))
  expect(text).not.toContain(t('contrib.reposCut'))
})

it('says nothing was found in what was read, with why there may be more, when the read was cut', async () => {
  const text = await picker({ contributions: [], reposCut: true, countsCut: ['pr'] })
  expect(text).toContain(t('contrib.noneRead'))
  expect(text).not.toContain(t('contrib.none'))
  expect(text).toContain(t('contrib.reposCut'))
  expect(text).toContain(t('contrib.countsCut'))
})

it('lists what it found, with the notices of a cut read above it', async () => {
  const repo = {
    id: 'R1',
    owner: 'acme',
    ownerAvatar: '',
    name: 'web',
    fullName: 'acme/web',
    description: null,
    language: null,
    isPrivate: false,
    isArchived: false,
    pushedAt: null,
    openIssues: 0,
    openPrs: 0,
    issues: 0,
    prs: 0,
  }
  const contributions = [{ repo, kinds: ['pr' as const], prs: 3, issues: 0, lastAt: null }]
  const text = await picker({ contributions, reposCut: false, countsCut: ['pr'] })
  expect(text).toContain('acme/web')
  expect(text).toContain(t('contrib.prsAtLeast', 3))
  expect(text).toContain(t('contrib.countsCut'))
  expect(text).not.toContain(t('contrib.none'))
})
