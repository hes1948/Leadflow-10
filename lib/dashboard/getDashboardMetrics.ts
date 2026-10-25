// lib/dashboard/getDashboardMetrics.ts

import { supabase } from "@/lib/supabase";

function estimateLeadValue(type: string) {
  switch (type) {
    case "roofing":
      return 15000;

    case "hvac":
      return 3500;

    case "plumbing":
      return 1200;

    case "electrical":
      return 1800;

    default:
      return 800;
  }
}

export async function getDashboardMetrics() {
  const now = new Date();

  const weekAgo = new Date();

  weekAgo.setDate(now.getDate() - 7);

  const { data: leads, error } = await supabase
    .from("leads")
    .select("*")
    .gte(
      "created_at",
      weekAgo.toISOString()
    );

  if (error) {
    throw error;
  }

  const safeLeads = leads ?? [];

  const totalLeads =
    safeLeads.length;

  const bookedJobs =
    safeLeads.filter(
      (lead) =>
        lead.status === "booked"
    ).length;

  const awaitingResponse =
    safeLeads.filter(
      (lead) =>
        lead.status ===
        "awaiting_customer"
    ).length;

  const outsideServiceArea =
    safeLeads.filter(
      (lead) =>
        lead.status ===
        "outside_service_area"
    ).length;

  const followUpsSent =
    safeLeads.reduce(
      (sum, lead) =>
        sum +
        (lead.follow_up_count || 0),
      0
    );

  const responseTimes =
    safeLeads
      .map(
        (lead) =>
          lead.response_time_seconds
      )
      .filter(Boolean);

  const averageResponseTime =
    responseTimes.length
      ? Math.round(
          responseTimes.reduce(
            (a, b) => a + b,
            0
          ) /
            responseTimes.length
        )
      : 0;

  const estimatedRevenue =
    safeLeads.reduce(
      (sum, lead) =>
        sum +
        estimateLeadValue(
          lead.type
        ),
      0
    );

  return {
    totalLeads,

    bookedJobs,

    awaitingResponse,

    outsideServiceArea,

    followUpsSent,

    averageResponseTime,

    estimatedRevenue,
  };
}