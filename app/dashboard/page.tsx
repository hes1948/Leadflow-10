// app/dashboard/page.tsx

import Dashboard from "@/components/dashboard/Dashboard";
import ConnectGmailGate from "@/components/onboarding/ConnectGmailGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default function DashboardPage() {
  return (
    <ConnectGmailGate>
      <Dashboard />
    </ConnectGmailGate>
  );
}