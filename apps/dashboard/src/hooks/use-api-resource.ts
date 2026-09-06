"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "@/lib/client-api";

export function useApiResource<T>(
  path: string,
  options?: { pollMs?: number; enabled?: boolean },
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const load = useCallback(
    async (quiet = false) => {
      if (!options?.enabled && options?.enabled !== undefined) return;
      if (!quiet) setLoading(true);
      try {
        const result = await apiFetch<T>(path);
        if (mounted.current) {
          setData(result);
          setError(null);
          setErrorStatus(null);
        }
      } catch (caught) {
        if (mounted.current) {
          setError(
            caught instanceof Error ? caught.message : "Data gagal dimuat.",
          );
          setErrorStatus(caught instanceof ApiError ? caught.status : null);
        }
      } finally {
        if (mounted.current && !quiet) setLoading(false);
      }
    },
    [options?.enabled, path],
  );

  useEffect(() => {
    mounted.current = true;
    const initial = window.setTimeout(() => void load(), 0);
    const interval = options?.pollMs
      ? window.setInterval(() => void load(true), options.pollMs)
      : undefined;
    return () => {
      mounted.current = false;
      window.clearTimeout(initial);
      if (interval) window.clearInterval(interval);
    };
  }, [load, options?.pollMs]);

  return { data, error, errorStatus, loading, reload: load, setData };
}
