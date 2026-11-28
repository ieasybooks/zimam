import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SetupFlow from '@/components/SetupFlow.vue'
import type { Viewer } from '@/lib/sources'
import { i18n } from '@/locale'
import { settings } from '@/stores/settings'

// jsdom has no media queries.
vi.hoisted(() => {
  globalThis.matchMedia = () => ({ matches: true, addEventListener: () => {} }) as unknown as MediaQueryList
})

// Nuxt UI's components need its Vite plugin. Plain stand-ins do here: a button that can be turned off, a field that
// holds what's typed.
const { stand } = vi.hoisted(() => ({
  stand: (tag: string) => async () => {
    const vue = await import('vue')
    return {
      default: vue.defineComponent({
        props: {
          label: { type: String, default: undefined },
          title: { type: String, default: undefined },
          disabled: { type: Boolean, default: false },
          modelValue: { type: String, default: undefined },
          type: { type: String, default: undefined },
        },
        emits: ['update:modelValue', 'click'],
        setup:
          (props, { slots, emit }) =>
          () =>
            tag === 'input'
              ? vue.h('input', {
                  value: props.modelValue,
                  type: props.type,
                  onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
                })
              : vue.h(
                  tag,
                  {
                    disabled: tag === 'button' ? props.disabled : undefined,
                    type: props.type,
                    onClick: () => emit('click'),
                  },
                  props.label ?? props.title ?? slots.default?.(),
                ),
      }),
    }
  },
}))
vi.mock('@nuxt/ui/components/Alert.vue', stand('div'))
vi.mock('@nuxt/ui/components/Avatar.vue', stand('span'))
vi.mock('@nuxt/ui/components/Button.vue', stand('button'))
vi.mock('@nuxt/ui/components/FormField.vue', stand('div'))
vi.mock('@nuxt/ui/components/Icon.vue', stand('span'))
vi.mock('@nuxt/ui/components/Input.vue', stand('input'))
vi.mock('@nuxt/ui/components/Tooltip.vue', stand('span'))
vi.mock('@nuxt/ui/components/Checkbox.vue', stand('span'))
vi.mock('@nuxt/ui/components/FieldGroup.vue', stand('div'))
vi.mock('@nuxt/ui/components/Skeleton.vue', stand('div'))
vi.mock('@nuxt/ui/components/Popover.vue', stand('span'))
vi.mock('@nuxt/ui/components/DropdownMenu.vue', stand('span'))

// GitHub knows one account by each token it accepts, and answers when a test lets it.
const github = vi.hoisted(() => ({
  accounts: new Map<string, string>(),
  held: new Map<string, () => void>(),
}))
// The workspace a test opens starts syncing, which this GitHub turns down.
vi.mock('@/lib/github', async (original) => {
  const real = await original<typeof import('@/lib/github')>()
  const refused = () => Promise.reject(new real.GitHubError('Bad credentials', 'auth'))
  return {
    ...real,
    createGitHub: (token: string) => ({
      token,
      scopes: () => ['repo'],
      rate: () => null,
      query: refused,
      request: refused,
      rest: refused,
      probe: async () => 'failed',
    }),
  }
})
vi.mock('@/lib/sources', async (original) => ({
  ...(await original<typeof import('@/lib/sources')>()),
  findViewer: async ({ token }: { token: string }): Promise<Viewer> => {
    await new Promise<void>((resolve) => (github.held.has(token) ? github.held.set(token, resolve) : resolve()))
    const login = github.accounts.get(token)
    if (!login) throw new Error('Bad credentials')
    return { login, name: null, avatarUrl: '', organizations: [{ login: 'acme', name: null, avatarUrl: '' }] }
  },
}))

let wrapper: VueWrapper | null = null

function setUp() {
  wrapper = mount(SetupFlow, {
    global: {
      plugins: [i18n],
      stubs: { BrandMark: true, ChoiceGroup: true, LanguageSwitch: true, RepoPicker: true, SetupPreview: true },
    },
    attachTo: document.body,
  })
  return wrapper
}

const field = () => wrapper!.find('input[type="password"]')
const typed = async (token: string) => field().setValue(token)
const checkToken = async () => {
  await wrapper!.find('form').trigger('submit')
  await flushPromises()
}
const openButton = () => wrapper!.findAll('button').find((button) => button.text() === 'Open the workspace')!

beforeEach(() => {
  i18n.global.locale.value = 'en'
  settings.workspaces = []
  settings.activeWorkspaceId = null
  github.accounts = new Map([
    ['token-a', 'ali'],
    ['token-b', 'sara'],
  ])
  github.held = new Map()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

describe('the token step', () => {
  it("won't open a workspace once the token checked is changed, even to nothing", async () => {
    setUp()
    await typed('token-a')
    await checkToken()
    expect(openButton().attributes('disabled')).toBeUndefined()
    await typed('')
    expect(openButton().attributes('disabled')).toBeDefined()
    // Continue is off with nothing to check, so the page doesn't ask for it.
    expect(wrapper!.text()).not.toContain('Press Continue')
  })

  it('opens a workspace with a changed token only once GitHub accepts it', async () => {
    setUp()
    await typed('token-a')
    await checkToken()
    await typed('token-wrong')
    expect(wrapper!.text()).toContain('The token changed. Press Continue to check it.')
    expect(openButton().attributes('disabled')).toBeDefined()
    await checkToken()
    expect(wrapper!.text()).toContain("GitHub didn't accept this token")
    expect(wrapper!.findAll('button').some((button) => button.text() === 'Open the workspace')).toBe(false)

    await typed('token-b')
    await checkToken()
    await openButton().trigger('click')
    expect(settings.workspaces.map((ws) => ws.token)).toEqual(['token-b'])
  })

  it('lets go of an answer about a token checked before the last one', async () => {
    setUp()
    // GitHub is slow to answer about the first token.
    github.held.set('token-a', () => {})
    await typed('token-a')
    await checkToken()
    await typed('token-b')
    await checkToken()
    github.held.get('token-a')!()
    await flushPromises()
    expect(wrapper!.text()).toContain('sara')
    await openButton().trigger('click')
    expect(settings.workspaces.map((ws) => ws.token)).toEqual(['token-b'])
  })
})
