<script setup lang="ts">
import FreeSubscriptionPanel from '@/components/accounts/FreeSubscriptionPanel.vue'
import { useAccountsStore } from '@/stores/accounts'

const accountsStore = useAccountsStore()
</script>

<template>
  <div class="subscription-page">
    <FreeSubscriptionPanel :accounts="accountsStore.accounts" :disabled="accountsStore.loading" />
  </div>
</template>

<style scoped>
.subscription-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
</style>
