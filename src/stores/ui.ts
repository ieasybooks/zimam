import { reactive, ref } from 'vue'

export const ui = reactive({
  menuOpen: false,
  settingsOpen: false,
  keysOpen: false,
  setup: null as 'new' | 'edit' | null,
  /** Whether the setup opens on the repositories the person contributed to. */
  contributions: false,
})

// From 80rem, Tailwind's `xl`, an issue opens beside the list, where another row is a click away. Narrower screens lay
// it over the list.
const WIDE = matchMedia('(min-width: 80rem)')
/** Whether the screen is wide enough to read an issue beside the list. */
export const wide = ref(WIDE.matches)
WIDE.addEventListener('change', (event) => (wide.value = event.matches))

// From 64rem, Tailwind's `lg`, a pull request's parts sit in a column beside its diff; narrower, in a sheet.
// Below 40rem, Tailwind's `sm`, a diff shows unified, with no room for two sides.
const LARGE = matchMedia('(min-width: 64rem)')
const PHONE = matchMedia('(max-width: 40rem)')
export const large = ref(LARGE.matches)
export const phone = ref(PHONE.matches)
LARGE.addEventListener('change', (event) => (large.value = event.matches))
PHONE.addEventListener('change', (event) => (phone.value = event.matches))

export function openSetup(mode: 'new' | 'edit', contributions = false) {
  Object.assign(ui, { menuOpen: false, settingsOpen: false, setup: mode, contributions })
}

export function openSettings() {
  Object.assign(ui, { menuOpen: false, settingsOpen: true })
}

export function openKeys() {
  Object.assign(ui, { menuOpen: false, keysOpen: true })
}
