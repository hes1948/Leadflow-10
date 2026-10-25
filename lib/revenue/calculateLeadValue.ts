// lib/revenue/calculateLeadValue.ts

export type RevenueServiceType =
  | "hvac"
  | "roofing"
  | "plumbing"
  | "electrical"
  | "general"
  | string
  | null
  | undefined;

export function calculateLeadValue(serviceType: RevenueServiceType) {
  switch (serviceType) {
    case "roofing":
      return 15000;

    case "hvac":
      return 3500;

    case "plumbing":
      return 1200;

    case "electrical":
      return 1800;

    case "general":
      return 800;

    default:
      return 800;
  }
}

export function formatRevenue(value: number) {
  return `$${Math.max(0, value).toLocaleString()}`;
}