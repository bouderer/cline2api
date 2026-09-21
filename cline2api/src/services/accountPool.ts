/** Account selection: round-robin with failover across logged-in accounts. */
import type { AccountStore } from "../store.js";
import type { StoredAccount } from "../cline/types.js";

export class AccountPool {
  private cursor = 0;

  constructor(private readonly store: AccountStore) {}

  /**
   * All usable accounts, rotated so that consecutive requests start with a
   * different account. Callers walk the list and fail over on errors.
   */
  candidates(): StoredAccount[] {
    const active = this.store.listActive();
    if (active.length === 0) return [];
    const start = this.cursor % active.length;
    this.cursor = (this.cursor + 1) % active.length;
    return [...active.slice(start), ...active.slice(0, start)];
  }
}
