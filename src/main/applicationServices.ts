import { BillingService } from './billingService'
import { getBillingConfig, setBillingConfig } from './store'

/** IPC 和 HTTP 服务复用的单一账单服务实例。 */
export const billingService = new BillingService({
  load: getBillingConfig,
  save: setBillingConfig
})
