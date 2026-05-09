/**
 * usePendingApprovals hook
 * 
 * Polls for pending approval checkpoints every 30 seconds.
 * Provides the count for the navigation badge and the full list for the inbox.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { RestApprovalService, type Checkpoint } from '@/services/api/restApprovalService';

const POLL_INTERVAL_MS = 30_000;

export function usePendingApprovals() {
  const [pendingCheckpoints, setPendingCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPending = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const checkpoints = await RestApprovalService.getPendingCheckpoints();
      setPendingCheckpoints(checkpoints);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch pending approvals');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPending();

    intervalRef.current = setInterval(() => {
      void fetchPending();
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchPending]);

  return {
    pendingCheckpoints,
    pendingCount: pendingCheckpoints.length,
    loading,
    error,
    refresh: fetchPending,
  };
}
