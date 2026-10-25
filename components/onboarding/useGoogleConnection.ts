"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type GoogleConnectionStatus = {
  connected: boolean; ready: boolean; reconnectRequired: boolean;
  googleAccountEmail?: string | null; gmailIngestionEnabled?: boolean;
};

export function useGoogleConnection() {
  const [status, setStatus] = useState<GoogleConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState("");
  const [unauthorized, setUnauthorized] = useState(false);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/google/connection-status", { cache: "no-store" });
      if (sequence !== request.current) return;
      setUnauthorized(response.status === 401);
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error("status_failed");
      setStatus(data);
    } catch {
      if (sequence === request.current) {
        setStatus(null);
        setError("We couldn’t check your Google connection. Please try again.");
      }
    } finally { if (sequence === request.current) setLoading(false); }
  }, []);

  async function activate() {
    setActivating(true);
    setError("");
    try {
      const response = await fetch("/api/google/gmail/watch", { method: "POST", cache: "no-store" });
      const data = await response.json();
      await refresh();
      if (!response.ok || !data.success) throw new Error("activation_failed");
    } catch {
      setError("Inbox capture couldn’t be enabled. Retry, or reconnect if your Google authorization has expired.");
    } finally { setActivating(false); }
  }

  useEffect(() => { void refresh(); return () => { request.current++; }; }, [refresh]);
  return { status, loading, activating, error, unauthorized, refresh, activate };
}
