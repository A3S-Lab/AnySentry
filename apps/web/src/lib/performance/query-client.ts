import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Monitoring pages already own their polling cadence. A small freshness
      // window deduplicates route transitions without hiding live changes.
      staleTime: 5_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnMount: true,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
