export interface PendingAccountPatch<T extends { id: string }> {
  version: number
  patch: Partial<T>
}

/** Keep local account edits visible while a newer server snapshot is committed. */
export function overlayPendingAccountPatches<T extends { id: string }>(
  accounts: T[],
  pending: ReadonlyMap<string, PendingAccountPatch<T>>
): T[] {
  return accounts.map((account) => {
    const pendingPatch = pending.get(account.id)?.patch
    return pendingPatch ? { ...account, ...pendingPatch } : account
  })
}

/** A save response can acknowledge only the mutation version it actually submitted. */
export function acknowledgePendingAccountPatches<T extends { id: string }>(
  pending: Map<string, PendingAccountPatch<T>>,
  submitted: ReadonlyMap<string, PendingAccountPatch<T>>
): void {
  for (const [accountId, sent] of submitted) {
    if (pending.get(accountId)?.version === sent.version) pending.delete(accountId)
  }
}
