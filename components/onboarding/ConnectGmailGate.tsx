"use client";

import GoogleConnectionPanel from "./GoogleConnectionPanel";

export default function ConnectGmailGate({ children }: { children: React.ReactNode }) {
  return <GoogleConnectionPanel variant="gate">{children}</GoogleConnectionPanel>;
}
