// Shared runtime shape for fresh and persisted pools. Hydrate in place so cached
// runtime pools, persistence and timers continue to observe the same object.
// `tokenUsage` is Map<credentialRef, {used, resetAt}> for this pool's local
// model token budget; adding it here is what lets a state persisted by an older
// version hydrate without error (the field is simply created empty, which means
// "no local budget recorded" rather than "budget exhausted").
const MAP_FIELDS = [
  'failedUntil', 'failCounts', 'authFailCounts', 'brokenUntil', 'costPerKey',
  'lastUsedAt', 'usageCounts', 'byModel', 'usageDays', 'quotaWindows', 'costDays',
  'tokenUsage',
];

export function initializePoolState(state = {}) {
  for (const key of MAP_FIELDS) {
    if (!(state[key] instanceof Map)) state[key] = new Map();
  }
  if (!Array.isArray(state.events)) state.events = [];
  if (!Number.isSafeInteger(state.pointer) || state.pointer < 0) state.pointer = 0;
  if (typeof state.lastUsed !== 'string') state.lastUsed = null;
  return state;
}

// Startup disk I/O can finish after requests have already used a pool. In that
// case the live state wins: replaying an older cooldown/cursor can undo success.
// A pool that has already charged model tokens also counts as active — replaying
// an older snapshot over it would silently refund spent budget.
export function hasPoolActivity(state) {
  return state.pointer !== 0 || state.lastUsed !== null || state.events.length > 0 ||
    MAP_FIELDS.some((key) => state[key].size > 0) ||
    (state.lastSuccessAt?.size ?? 0) > 0;
}
