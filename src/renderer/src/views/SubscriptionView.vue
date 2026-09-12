<script setup lang="ts">
import { ref } from 'vue'
import BatchSubscriptionPanel from '@/components/accounts/BatchSubscriptionPanel.vue'
import FreeSubscriptionPanel from '@/components/accounts/FreeSubscriptionPanel.vue'
import { useAccountsStore } from '@/stores/accounts'

const accountsStore = useAccountsStore()
const activePanel = ref<'links' | 'free'>('links')
</script>

<template>
  <div class="subscription-page">
    <div class="subscription-tabs" role="tablist" aria-label="订阅管理功能">
      <a-button :type="activePanel === 'links' ? 'primary' : 'default'" @click="activePanel = 'links'">
        提链
      </a-button>
      <a-button :type="activePanel === 'free' ? 'primary' : 'default'" @click="activePanel = 'free'">
        切Free
      </a-button>
    </div>
    <div class="subscription-content">
      <BatchSubscriptionPanel
        v-show="activePanel === 'links'"
        :accounts="accountsStore.accounts"
        :disabled="accountsStore.loading"
      />
      <FreeSubscriptionPanel
        v-show="activePanel === 'free'"
        :accounts="accountsStore.accounts"
        :disabled="accountsStore.loading"
      />
    </div>
  </div>
</template>

<style scoped>
.subscription-page { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 12px; }
.subscription-tabs { display: flex; flex: 0 0 auto; gap: 8px; }
.subscription-content { flex: 1 1 auto; min-height: 0; overflow: hidden; }
</style>
