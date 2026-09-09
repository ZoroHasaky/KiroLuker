export interface TagReference {
  id: string
  tagIds: string[]
}

/** Preserve an account's local tag edit while a newer server snapshot is rendered. */
export function overlayPendingTagIds<T extends TagReference>(
  accounts: T[],
  pending: ReadonlyMap<string, readonly string[]>
): T[] {
  return accounts.map((account) => {
    const tagIds = pending.get(account.id)
    return tagIds ? { ...account, tagIds: [...tagIds] } : account
  })
}

function sameTagIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Do not clear a newer local selection that was made while an earlier save was in flight. */
export function acknowledgePendingTagIds(
  pending: Map<string, string[]>,
  submitted: ReadonlyMap<string, readonly string[]>
): void {
  for (const [accountId, sentTagIds] of submitted) {
    const current = pending.get(accountId)
    if (current && sameTagIds(current, sentTagIds)) pending.delete(accountId)
  }
}
