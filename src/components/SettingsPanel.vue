<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import USeparator from '@nuxt/ui/components/Separator.vue'
import USlideover from '@nuxt/ui/components/Slideover.vue'
import USwitch from '@nuxt/ui/components/Switch.vue'
import UTextarea from '@nuxt/ui/components/Textarea.vue'
import { useToast } from '@nuxt/ui/composables'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { setLook } from '@/components/motion'
import SettingChoice from '@/components/SettingChoice.vue'
import { badPatterns } from '@/lib/generated'
import { languageName, sides } from '@/locale'
import { install, installed, installPrompt, manualInstall } from '@/pwa'
import { deleteWorkspace, reloadWorkspace } from '@/stores/data'
import { activeWorkspace, exportSettings, importSettings, settings, updateWorkspace } from '@/stores/settings'
import { openSetup, ui } from '@/stores/ui'
import {
  BOT_POSTS,
  DENSITIES,
  DIFF_VIEWS,
  FILE_MODES,
  LOCALES,
  LONG_LINES,
  ROW_PARTS,
  THEMES,
  type Settings,
  type Workspace,
} from '@/types'

const { t } = useI18n()
const toast = useToast()

type Choosable = 'locale' | 'theme' | 'density' | 'bots' | 'longLines' | 'diffView' | 'files'
const LOOKS = ['locale', 'theme', 'density'] as const

/** A setting picked from a few choices: where Settings keep it, its values, and how it and each value read. */
function choice<K extends Choosable>(
  key: K,
  values: readonly Settings[K][],
  title: string,
  label: (value: Settings[K]) => string,
) {
  return {
    key,
    title,
    choices: values.map((value) => ({ value, label: label(value), lang: key === 'locale' ? value : undefined })),
    picked: (value: string) => settings[key] === value,
    // How the whole page looks changes with a crossfade.
    pick: (value: string) =>
      (LOOKS as readonly string[]).includes(key)
        ? setLook(key as (typeof LOOKS)[number], value as never)
        : (settings[key] = value as Settings[K]),
  }
}

const display = computed(() => [
  choice('locale', LOCALES, t('settings.language'), languageName),
  choice('theme', THEMES, t('settings.theme'), (value) => t(`settings.themes.${value}`)),
  choice('density', DENSITIES, t('settings.density'), (value) => t(`settings.densities.${value}`)),
])
const reading = computed(() => [
  choice('bots', BOT_POSTS, t('settings.pull.bots.title'), (value) => t(`settings.pull.bots.${value}`)),
  choice('longLines', LONG_LINES, t('settings.pull.longLines.title'), (value) => t(`settings.pull.longLines.${value}`)),
  choice('diffView', DIFF_VIEWS, t('settings.pull.diffView.title'), (value) => t(`pull.views.${value}`)),
  choice('files', FILE_MODES, t('settings.pull.files.title'), (value) => t(`pull.modes.${value}`)),
])
const generatedText = computed({
  get: () => settings.generated.join('\n'),
  set: (text: string) =>
    (settings.generated = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)),
})

const badGenerated = computed(() => badPatterns(settings.generated))

async function reload() {
  ui.settingsOpen = false
  await reloadWorkspace()
}

async function remove(ws: Workspace) {
  if (!confirm(t('settings.deleteConfirm', { name: ws.name }))) return
  ui.settingsOpen = false
  await deleteWorkspace()
}

function download() {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([exportSettings()], { type: 'application/json' }))
  link.download = 'zimam-settings.json'
  link.click()
  URL.revokeObjectURL(link.href)
}

async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    importSettings(await file.text())
    toast.add({ title: t('settings.imported'), icon: 'i-octicon-check-16' })
  } catch {
    toast.add({ title: t('settings.importFailed'), color: 'error', icon: 'i-octicon-alert-16' })
  }
}
</script>

<template>
  <USlideover v-model:open="ui.settingsOpen" :title="t('settings.title')" :side="sides.end">
    <template #body>
      <div class="space-y-6">
        <section class="space-y-4">
          <h3 class="font-medium text-highlighted">{{ t('settings.display') }}</h3>
          <SettingChoice
            v-for="group in display"
            :key="group.key"
            :title="group.title"
            :choices="group.choices"
            :picked="group.picked"
            @pick="group.pick"
          />
          <fieldset class="space-y-2 pointer-coarse:space-y-0">
            <legend class="mb-2 text-sm text-toned">{{ t('settings.rows') }}</legend>
            <USwitch
              v-for="part in ROW_PARTS"
              :key="part"
              v-model="settings.show[part]"
              :label="t(`settings.parts.${part}`)"
              :ui="{ root: 'items-center', label: 'font-normal pointer-coarse:py-3' }"
            />
          </fieldset>
        </section>

        <USeparator />
        <section class="space-y-4">
          <h3 class="font-medium text-highlighted">{{ t('settings.pull.title') }}</h3>
          <SettingChoice
            v-for="group in reading"
            :key="group.key"
            :title="group.title"
            :choices="group.choices"
            :picked="group.picked"
            @pick="group.pick"
          />
          <UFormField
            :label="t('settings.pull.generated.title')"
            :help="t('settings.pull.generated.help')"
            :error="
              badGenerated.length ? t('settings.pull.generated.bad', { patterns: badGenerated.join(' ') }) : false
            "
          >
            <UTextarea
              v-model.lazy="generatedText"
              :rows="3"
              autoresize
              class="w-full font-mono"
              placeholder="packages/*/dist/**"
            />
          </UFormField>
        </section>

        <template v-if="activeWorkspace">
          <USeparator />
          <section class="space-y-3">
            <h3 class="font-medium text-highlighted">{{ t('settings.workspace') }}</h3>
            <UFormField :label="t('setup.nameLabel')">
              <UInput
                :model-value="activeWorkspace.name"
                class="w-full"
                @change="
                  (event: Event) =>
                    updateWorkspace(activeWorkspace!.id, { name: (event.target as HTMLInputElement).value })
                "
              />
            </UFormField>
            <UButton
              color="neutral"
              variant="outline"
              block
              :label="t('settings.editSources')"
              @click="openSetup('edit')"
            />
            <UButton
              color="neutral"
              variant="outline"
              block
              :label="t('contrib.open')"
              @click="openSetup('edit', true)"
            />
            <div>
              <UButton color="neutral" variant="outline" block :label="t('settings.reload')" @click="reload" />
              <p class="mt-1 text-xs text-muted">{{ t('settings.reloadHelp') }}</p>
            </div>
            <UButton
              color="error"
              variant="ghost"
              block
              :label="t('settings.delete')"
              @click="remove(activeWorkspace)"
            />
          </section>
        </template>

        <USeparator />
        <section class="space-y-2">
          <h3 class="font-medium text-highlighted">{{ t('settings.data') }}</h3>
          <p class="text-xs text-muted">{{ t('settings.exportHelp') }}</p>
          <div class="flex gap-2">
            <UButton color="neutral" variant="outline" :label="t('settings.export')" @click="download" />
            <UButton
              as="label"
              color="neutral"
              variant="outline"
              class="focus-within:outline-2 focus-within:outline-primary"
            >
              {{ t('settings.import') }}
              <input type="file" accept="application/json" class="sr-only" @change="upload" />
            </UButton>
          </div>
        </section>

        <template v-if="!installed && (installPrompt || manualInstall)">
          <USeparator />
          <section class="space-y-2">
            <h3 class="font-medium text-highlighted">{{ t('settings.app') }}</h3>
            <p class="text-xs text-muted">{{ t('settings.installHelp') }}</p>
            <UButton
              v-if="installPrompt"
              color="neutral"
              variant="outline"
              icon="i-octicon-download-16"
              :label="t('settings.install')"
              @click="install"
            />
            <p v-else class="text-sm">{{ t(`settings.installVia.${manualInstall}`) }}</p>
          </section>
        </template>
      </div>
    </template>
  </USlideover>
</template>
