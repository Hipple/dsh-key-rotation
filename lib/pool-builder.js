// lib/pool-builder.js — provider & per-model pool assembly and cleanup
import { bucketSweep } from './bucket.js';
import { isValidRef } from './pool.js';
import { normalizeModelQuotas } from './model-quota.js';
import { createPoolIndex, addProviderPools } from './pool-index.js';
import { initializePoolState } from './pool-state.js';

export function parseExpiry(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.length > 0) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

/**
 * Build a runtime pool item.
 *
 * Provider and model identity are carried explicitly (`provider`, `model`) so no
 * consumer ever has to reverse-engineer a model by splitting the pool base on
 * `::`. A provider-base pool has `model: null`; a per-model pool has both.
 * `quotas` holds the normalised local token budgets for this model pool and is
 * always a frozen (possibly empty) lookup, so the hot path can index it directly.
 */
export function buildPoolItem({
  base,
  keys,
  weights,
  poolCooldown,
  poolMax,
  expiresAt,
  poolStrategy,
  poolGuard,
  rpmLimit,
  makeState,
  provider = null,
  model = null,
  quotas = null,
  quotaResetWindow = null,
}) {
  const seen = new Set();
  const indexed = (Array.isArray(keys) ? keys : []).map((key, index) => ({ ref: typeof key === 'string' ? key.trim() : '', index }))
    .filter(({ ref }) => { if (!isValidRef(ref) || seen.has(ref)) return false; seen.add(ref); return true; });
  const refs = indexed.map(item => item.ref);
  if (refs.length === 0) return null;
  const w = indexed.map(({ index }) => {
    const value = Array.isArray(weights) ? weights[index] : undefined;
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(1000, Math.floor(value))) : 1;
  });
  const weightedRefs = [];
  for (let i = 0; i < refs.length; i++) {
    const ww = typeof w[i] === 'number' && w[i] > 0 ? Math.floor(w[i]) : 1;
    for (let k = 0; k < ww; k++) weightedRefs.push(refs[i]);
  }
  const parsedExpiry = {};
  if (Array.isArray(expiresAt)) {
    for (let i = 0; i < refs.length; i++) {
      const exp = parseExpiry(expiresAt[indexed[i].index]);
      if (exp !== undefined) parsedExpiry[refs[i]] = exp;
    }
  }
  const normalizedQuotas = normalizeModelQuotas(quotas);
  return {
    base,
    provider,
    model,
    quotas: normalizedQuotas,
    // Precomputed so the per-request eligibility check is a boolean read.
    hasModelQuota: Object.keys(normalizedQuotas).length > 0,
    quotaResetWindow,
    refs,
    weights: refs.map((_, i) => (typeof w[i] === 'number' && w[i] > 0 ? Math.floor(w[i]) : 1)),
    weightedRefs: weightedRefs.length > 0 ? weightedRefs : refs,
    state: makeState(base),
    cooldownMs: poolCooldown,
    maxCooldownMs: poolMax,
    expiresAt: parsedExpiry,
    rpmLimit,
    routingStrategy: poolStrategy,
    proactiveRateLimitGuard: poolGuard,
  };
}

/**
 * Assemble the whole runtime pool set from a resolved config section.
 *
 * This is the single construction path shared by the plugin runtime and the
 * tests, so what unit tests exercise is exactly what production builds:
 * provider-base pools, `provider::model` sub-pools carrying their model
 * identity and normalised `quotas`, the complete pool inventory, and the
 * ref-ownership index used by the credential resolver.
 *
 * @returns {{index: object, pools: object[], poolByRef: Map,
 *            providerToPool: Map, modelPoolByProvider: Map, cloneIds: Set,
 *            poolState: Map}}
 */
export function buildPools({ cfg = {}, poolState = new Map(), defaultState = initializePoolState } = {}) {
  const rpmLimit = cfg.rpmLimit ?? 0;
  const quotaResetWindow = cfg.quotaResetWindow ?? null;
  const poolByRef = new Map();
  const providerToPool = new Map();
  const modelPoolByProvider = new Map();
  const cloneIds = new Set();
  const index = createPoolIndex();

  // Called with no arguments: a state factory must never receive the pool base,
  // which would otherwise be mutated as if it were the state object.
  const makeState = (base) => {
    let st = poolState.get(base);
    if (!st) {
      st = initializePoolState(defaultState());
      poolState.set(base, st);
    }
    return initializePoolState(st);
  };

  const buildPool = (base, keys, weights, poolCooldown, poolMax, expiresAt, poolStrategy, poolGuard, meta) =>
    buildPoolItem({
      base, keys, weights, poolCooldown, poolMax, expiresAt, poolStrategy, poolGuard,
      rpmLimit, makeState, quotaResetWindow, ...meta,
    });

  for (const p of cfg.providers ?? []) {
    const poolCooldown = typeof p.cooldownMs === 'number' ? p.cooldownMs : (cfg.cooldownMs ?? 60000);
    const poolMax = typeof p.maxCooldownMs === 'number' ? p.maxCooldownMs : (cfg.maxCooldownMs ?? undefined);
    const pool = buildPool(p.provider, p.keys, p.weights, poolCooldown, poolMax, p.expiresAt, p.routingStrategy, p.proactiveRateLimitGuard, {
      provider: p.provider,
      model: null,
    });
    if (pool) {
      // Compatibility lookup only. One ref can belong to several model pools, so
      // this Map is never the enumeration source for pools — `index` is.
      for (const ref of pool.refs) {
        if (!poolByRef.has(ref)) poolByRef.set(ref, pool);
      }
      for (let i = 1; i < pool.refs.length; i++) cloneIds.add(`${p.provider}-${i + 1}`);
      if (!providerToPool.has(p.provider)) providerToPool.set(p.provider, pool);
    }
    const byModel = new Map();
    for (const [model, mp] of Object.entries(p.models ?? {})) {
      const mpool = buildPool(`${p.provider}::${model}`, mp.keys, mp.weights, poolCooldown, poolMax, undefined, p.routingStrategy, p.proactiveRateLimitGuard, {
        provider: p.provider,
        model,
        quotas: mp.quotas,
      });
      if (!mpool) continue;
      byModel.set(model, mpool);
      // A ref already owned by the provider-base pool keeps that ownership, so a
      // bare credentials.resolve() is not hijacked by whichever model pool was
      // built last. Every model pool stays visible through `index`.
      for (const ref of mpool.refs) {
        if (!poolByRef.has(ref)) poolByRef.set(ref, mpool);
      }
    }
    if (byModel.size > 0) modelPoolByProvider.set(p.provider, byModel);
    addProviderPools(index, p.provider, pool, byModel);
  }

  return {
    index,
    pools: [...index.allPools.values()],
    poolByRef,
    providerToPool,
    modelPoolByProvider,
    cloneIds,
    poolState,
  };
}

export function cleanupRemovedProviders({  cfg,
  poolState,
  pools,
  providerToPool,
  expectedClones,
  moduleBreaker,
  lowHealthNotifiedAt,
  budgetNotifiedAt,
}) {
  // Enumerate every live pool (provider base AND per-model). Using a ref-keyed
  // lookup here would drop model pools whose refs were overwritten by another
  // model, silently leaking their state instead of cleaning it up.
  const live = Array.isArray(pools) ? pools : [...(pools?.values?.() ?? [])];
  const liveBases = new Set(live.map((p) => p.base));
  for (const key of [...poolState.keys()]) {
    if (!liveBases.has(key)) {
      poolState.delete(key);
      lowHealthNotifiedAt?.delete?.(key);
      budgetNotifiedAt?.delete?.(key + ':budget');
    }
  }
  // #192: drop RPM windows for refs that no longer belong to any pool, and drop
  // tokenUsage for refs that left this pool (stale-state cleanup for quotas).
  const liveRefs = new Set();
  for (const pool of live) {
    for (const ref of pool.refs) liveRefs.add(ref);
  }
  for (const st of poolState.values()) {
    if (st.rpmWindows) bucketSweep(st.rpmWindows, liveRefs);
    if (st.tokenUsage instanceof Map) {
      for (const ref of [...st.tokenUsage.keys()]) {
        if (!liveRefs.has(ref)) st.tokenUsage.delete(ref);
      }
    }
  }
  // drop breaker entries for removed providers
  if (moduleBreaker) {
    for (const key of Object.keys(moduleBreaker.snapshot())) {
      if (![...providerToPool.keys()].includes(key) && !expectedClones.has(key)) {
        const still = (cfg.providers ?? []).some((p) => p.provider === key);
        if (!still) moduleBreaker.reset(key);
      }
    }
  }
}
