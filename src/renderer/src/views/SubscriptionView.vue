<script setup lang="ts">
import { ref } from 'vue'
import BatchSubscriptionPanel from '@/components/accounts/BatchSubscriptionPanel.vue'
import FreeSubscriptionPanel from '@/components/accounts/FreeSubscriptionPanel.vue'
import { useAccountsStore } from '@/stores/accounts'

const accountsStore = useAccountsStore()
const activePanel = ref<'batch' | 'manage'>('batch')
</script>

<template>
  <div class="subscription-page">
    <div class="subscription-tabs">
      <a-button :type="activePanel === 'batch' ? 'primary' : 'default'" @click="activePanel = 'batch'">
        批量订阅
      </a-button>
      <a-button :type="activePanel === 'manage' ? 'primary' : 'default'" @click="activePanel = 'manage'">
        订阅生命周期管理
      </a-button>
    </div>
    <div class="subscription-content">
      <BatchSubscriptionPanel
        v-show="activePanel === 'batch'"
        :accounts="accountsStore.accounts"
        :disabled="accountsStore.loading"
      />
      <FreeSubscriptionPanel
        v-show="activePanel === 'manage'"
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
