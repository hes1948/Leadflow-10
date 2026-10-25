import { GET as completeGoogleConnection } from "@/app/api/google/callback/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET(req: Request) {
  return completeGoogleConnection(req);
}
