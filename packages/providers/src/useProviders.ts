'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type {
  DataProvider,
  DataProviderEvent,
  DataProviderStats,
  MergedStats,
  ConnectionState,
  CategoryConfig,
  SourceConfig,
  TopToken,
  TraderEdge,
  RawEvent,
} from '@web3viz/core';

// ============================================================================
// Types
// ============================================================================

export interface UseProvidersOptions {
  /** Provider instances to manage */
  providers: DataProvider[];
  /** Start paused? */
  paused?: boolean;
  /** Max unified events to keep */
  maxEvents?: number;
  /** Start with all providers enabled? Default true for backward compat. */
  startEnabled?: boolean;
  /** Explicit initial opt-in provider IDs, for example a shared viewer URL. */
  initialEnabledProviderIds?: readonly string[];
}

export interface UseProvidersReturn {
  /** Merged stats from all providers */
  stats: MergedStats;
  /** All recent events filtered by enabled categories */
  filteredEvents: DataProviderEvent[];
  /** All recent events unfiltered */
  allEvents: DataProviderEvent[];
  /** Set of enabled category IDs */
  enabledCategories: Set<string>;
  /** Toggle a category on/off */
  toggleCategory: (categoryId: string) => void;
  /** Set of enabled provider IDs */
  enabledProviders: Set<string>;
  /** Toggle a provider on/off */
  toggleProvider: (providerId: string) => void;
  /** Categories from enabled providers */
  categories: CategoryConfig[];
  /** Source configs from enabled providers */
  sources: SourceConfig[];
  /** All categories from all providers (always available for UI) */
  allCategories: CategoryConfig[];
  /** All source configs from all providers (always available for UI) */
  allSources: SourceConfig[];
  /** Per-provider connection state */
  connections: Record<string, ConnectionState[]>;
}

// ============================================================================
// Constants
// ============================================================================

const FLUSH_INTERVAL_MS = 100;
const DEFAULT_MAX_EVENTS = 300;

// ============================================================================
// Hook
// ============================================================================

export function useProviders(options: UseProvidersOptions): UseProvidersReturn {
  const { providers, paused = false, maxEvents = DEFAULT_MAX_EVENTS, startEnabled = true, initialEnabledProviderIds } = options;

  // Mutable refs for event buffering (avoids re-render loops)
  const eventBufferRef = useRef<DataProviderEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxEventsRef = useRef(maxEvents);
  useEffect(() => { maxEventsRef.current = maxEvents; }, [maxEvents]);

  // State
  const [allEvents, setAllEvents] = useState<DataProviderEvent[]>([]);

  const [enabledCategories, setEnabledCategories] = useState<Set<string>>(() => {
    const all = new Set<string>();
    for (const p of providers) {
      if (initialEnabledProviderIds ? initialEnabledProviderIds.includes(p.id) : startEnabled) {
        for (const cat of p.categories) all.add(cat.id);
      }
    }
    return all;
  });

  const [enabledProviders, setEnabledProviders] = useState<Set<string>>(
    () => new Set(providers.filter(p => initialEnabledProviderIds ? initialEnabledProviderIds.includes(p.id) : startEnabled).map(p => p.id)),
  );

  // Flush buffered events into state
  const flush = useCallback(() => {
    const buffer = eventBufferRef.current;
    if (buffer.length === 0) return;
    eventBufferRef.current = [];

    setAllEvents((prev) => {
      const merged = [...buffer, ...prev];
      merged.sort((a, b) => b.timestamp - a.timestamp);
      return merged.slice(0, maxEventsRef.current);
    });

  }, []);

  // Schedule a debounced flush (100ms batching)
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flush();
    }, FLUSH_INTERVAL_MS);
  }, [flush]);

  // Keep the subscribed provider instance with its disposer. Replacing or removing
  // a provider must release the previous instance, even when its ID is reused.
  const managedRef = useRef(new Map<string, { provider: DataProvider; unsubscribe: () => void }>());
  useEffect(() => {
    const managed = managedRef.current;
    for (const [id, connection] of managed) {
      if (!enabledProviders.has(id) || !providers.includes(connection.provider)) {
        connection.unsubscribe();
        connection.provider.disconnect();
        managed.delete(id);
      }
    }
    for (const provider of providers) {
      const enabled = enabledProviders.has(provider.id);
      provider.setEnabled(enabled);
      provider.setPaused(paused);
      if (!enabled || managed.has(provider.id)) continue;
      // Subscribe first: providers can emit their first event during connect().
      const unsubscribe = provider.onEvent(event => {
        eventBufferRef.current.push(event);
        scheduleFlush();
      });
      managed.set(provider.id, { provider, unsubscribe });
      try {
        provider.connect();
      } catch (error) {
        unsubscribe();
        managed.delete(provider.id);
        provider.disconnect();
        throw error;
      }
    }
  }, [providers, enabledProviders, paused, scheduleFlush]);

  useEffect(() => {
    const managed = managedRef.current;
    return () => {
      for (const connection of managed.values()) {
        connection.unsubscribe();
        connection.provider.disconnect();
      }
      managed.clear();
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  // Toggle category
  const toggleCategory = useCallback((categoryId: string) => {
    setEnabledCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  }, []);

  // Event handlers update selection; the effect owns provider side effects.
  const toggleProvider = useCallback((providerId: string) => {
    const enabling = !enabledProviders.has(providerId);
    setEnabledProviders(previous => {
      const next = new Set(previous);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
    const provider = providers.find(p => p.id === providerId);
    if (enabling && provider) {
      setEnabledCategories(previous => new Set([...previous, ...provider.categories.map(category => category.id)]));
    }
  }, [providers, enabledProviders]);

  // Collect categories from all enabled providers (deduplicated)
  const categories = useMemo(() => {
    const seen = new Set<string>();
    const result: CategoryConfig[] = [];
    for (const p of providers) {
      if (enabledProviders.has(p.id)) {
        for (const cat of p.categories) {
          const key = `${cat.id}:${cat.sourceId ?? ''}`;
          if (!seen.has(key)) {
            seen.add(key);
            result.push(cat);
          }
        }
      }
    }
    return result;
  }, [providers, enabledProviders]);

  // Collect source configs from enabled providers
  const sources = useMemo(
    () => providers.filter((p) => enabledProviders.has(p.id)).map((p) => p.sourceConfig),
    [providers, enabledProviders],
  );

  // All categories and sources (always available for UI display)
  const allCategories = useMemo(() => {
    const seen = new Set<string>();
    const result: CategoryConfig[] = [];
    for (const p of providers) {
      for (const cat of p.categories) {
        const key = `${cat.id}:${cat.sourceId ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push(cat);
        }
      }
    }
    return result;
  }, [providers]);

  const allSources = useMemo(
    () => providers.map((p) => p.sourceConfig),
    [providers],
  );

  // Derive merged stats from enabled providers
  const stats = useMemo<MergedStats>(() => {
    const bySource: Record<string, DataProviderStats> = {};
    const mergedCounts: Record<string, number> = {};
    const totalVolume: Record<string, number> = {};
    let totalTransactions = 0;
    let totalAgents = 0;
    const allTopTokens: TopToken[] = [];
    const allTraderEdges: TraderEdge[] = [];
    const allRawEvents: RawEvent[] = [];

    for (const provider of providers) {
      if (!enabledProviders.has(provider.id)) continue;
      const providerStats = provider.getStats();
      bySource[provider.id] = providerStats;

      for (const [key, value] of Object.entries(providerStats.counts || {})) {
        mergedCounts[key] = (mergedCounts[key] || 0) + value;
      }

      // Merge per-chain volume map
      for (const [chain, vol] of Object.entries(providerStats.totalVolume || {})) {
        totalVolume[chain] = (totalVolume[chain] || 0) + vol;
      }

      totalTransactions += providerStats.totalTransactions;
      totalAgents += providerStats.totalAgents;
      allTopTokens.push(...(providerStats.topTokens || []));
      allTraderEdges.push(...(providerStats.traderEdges || []));
      allRawEvents.push(...(providerStats.rawEvents || []));
    }

    // Sort and trim top tokens
    allTopTokens.sort((a, b) => b.volume - a.volume);

    return {
      counts: mergedCounts,
      totalVolume,
      totalTransactions,
      totalAgents,
      recentEvents: allEvents,
      topTokens: allTopTokens.slice(0, 8),
      traderEdges: allTraderEdges,
      rawEvents: allRawEvents,
      bySource,
    };
  }, [providers, enabledProviders, allEvents]);

  // Filter events by enabled categories and providers
  const filteredEvents = useMemo(
    () =>
      allEvents.filter(
        (e) =>
          enabledCategories.has(e.category) &&
          enabledProviders.has(e.providerId),
      ),
    [allEvents, enabledCategories, enabledProviders],
  );

  // Provider getters expose external connection state; event flushes already
  // update allEvents and trigger a render, so no dummy counter is necessary.
  const connections: Record<string, ConnectionState[]> = {};
  for (const provider of providers) {
    if (enabledProviders.has(provider.id)) connections[provider.id] = provider.getConnections();
  }

  return {
    stats,
    filteredEvents,
    allEvents,
    enabledCategories,
    toggleCategory,
    enabledProviders,
    toggleProvider,
    categories,
    sources,
    allCategories,
    allSources,
    connections,
  };
}
