<script setup lang="ts">
import FreeSubscriptionPanel from '@/components/accounts/FreeSubscriptionPanel.vue'
import { useAccountsStore } from '@/stores/accounts'

const accountsStore = useAccountsStore()
</script>

<template>
  <div class="free-switch-page">
    <FreeSubscriptionPanel :accounts="accountsStore.accounts" :disabled="accountsStore.loading" />
  </div>
</template>

<style scoped>
.free-switch-page { height: 100%; min-height: 0; overflow: hidden; }
</style>
