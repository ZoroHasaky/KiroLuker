<script setup lang="ts">
/**
 * 设置项开关：把「读取设置字段 + 写回设置」这段样板收敛到一处。
 * 设置页里近十个开关都只有字段名不同，逐个手写容易漏掉 !! 归一。
 */
import { useSettingsStore } from '@/stores/settings'
import type { AppSettings } from '@shared/types'

/** 只允许绑定值为 boolean 的设置字段 */
type BooleanSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never
}[keyof AppSettings]

const props = defineProps<{ field: BooleanSettingKey }>()

const settingsStore = useSettingsStore()

function change(value: unknown): void {
  void settingsStore.update({ [props.field]: !!value } as Partial<AppSettings>)
}
</script>

<template>
  <a-switch :checked="settingsStore.settings[props.field]" @change="change" />
</template>
