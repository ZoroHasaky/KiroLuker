<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [string]
}>()

const commonColors = [
  '#1677ff',
  '#2f54eb',
  '#722ed1',
  '#eb2f96',
  '#ff4d4f',
  '#fa8c16',
  '#faad14',
  '#52c41a',
  '#13c2c2',
  '#8c8c8c'
]

const normalizedValue = computed(() => props.modelValue.trim().toLowerCase())
</script>

<template>
  <div class="color-selector">
    <div class="color-swatches" aria-label="常用标签颜色">
      <button
        v-for="color in commonColors"
        :key="color"
        type="button"
        class="color-swatch"
        :class="{ selected: normalizedValue === color }"
        :style="{ backgroundColor: color }"
        :title="color"
        :aria-label="`选择颜色 ${color}`"
        :aria-pressed="normalizedValue === color"
        @click="emit('update:modelValue', color)"
      >
        <span v-if="normalizedValue === color">✓</span>
      </button>
    </div>
    <a-input
      :value="props.modelValue"
      class="color-value"
      size="small"
      :maxlength="7"
      placeholder="#1677ff"
      @update:value="(value: string) => emit('update:modelValue', value)"
    >
      <template #prefix>
        <span
          class="color-preview"
          :style="{ backgroundColor: /^#[0-9a-f]{6}$/i.test(props.modelValue) ? props.modelValue : 'transparent' }"
        />
      </template>
    </a-input>
  </div>
</template>

<style scoped>
.color-selector {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.color-swatches {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.color-swatch {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  transition: transform 0.14s ease, box-shadow 0.14s ease;
}

.color-swatch:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 7px rgba(0, 0, 0, 0.2);
}

.color-swatch.selected {
  border-color: var(--kal-card-bg);
  box-shadow: 0 0 0 2px var(--kal-primary);
}

.color-value {
  width: 118px;
  font-family: 'SFMono-Regular', Consolas, monospace;
}

.color-preview {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 1px solid var(--kal-border);
  border-radius: 3px;
}
</style>
