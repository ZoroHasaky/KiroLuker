<script setup lang="ts">
import BatchSubscriptionPanel from '@/components/accounts/BatchSubscriptionPanel.vue'
import { useAccountsStore } from '@/stores/accounts'

const accountsStore = useAccountsStore()
</script>

<template>
  <div class="link-extraction-page">
    <BatchSubscriptionPanel :accounts="accountsStore.accounts" :disabled="accountsStore.loading" />
  </div>
</template>

<style scoped>
.link-extraction-page { height: 100%; min-height: 0; overflow: hidden; }
</style>
