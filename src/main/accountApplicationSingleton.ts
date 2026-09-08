import { AccountApplicationService } from './accountApplicationService'
import { checkAccountStatus, refreshAccountToken, verifyCredentials } from './accountService'
import { getAccountData, setAccountData } from './store'
import { pruneUsageHistory } from './usageHistory'

/** Electron 主进程实际使用的账户服务单例；测试可直接注入内存仓储构造纯服务。 */
export const accountApplicationService = new AccountApplicationService(
  { load: getAccountData, save: setAccountData },
  { verify: verifyCredentials, refresh: refreshAccountToken, check: checkAccountStatus }
)

accountApplicationService.onChanged(({ data, removedIds }) => {
  if (removedIds.length) pruneUsageHistory(data.accounts.map((account) => account.id))
})
