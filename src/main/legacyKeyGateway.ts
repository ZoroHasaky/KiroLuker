import type { KeyGatewayData } from '../shared/types'

interface LegacyGatewayRepository {
  load: () => KeyGatewayData
  save: (data: KeyGatewayData) => void
  restore: (data: KeyGatewayData) => Promise<unknown>
}

/** 仅清理旧版本接管状态，永远不启动网关、不删除历史 Key 或统计文件。 */
export async function retireLegacyKeyGateway(repository: LegacyGatewayRepository): Promise<boolean> {
  const data = repository.load()
  const pending = data.enabled || !!data.originalEndpoints || !!data.settingsPath
  if (!pending) {
    if (data.activeKeyId) repository.save({ ...data, enabled: false, activeKeyId: null })
    return false
  }

  // 先停用历史开关，但保留恢复信息；磁盘写入失败时下次启动仍可继续清理。
  repository.save({ ...data, enabled: false, activeKeyId: null })
  await repository.restore(data)

  const latest = repository.load()
  repository.save({
    ...latest,
    enabled: false,
    activeKeyId: null,
    originalEndpoints: undefined,
    settingsPath: undefined
  })
  return true
}
