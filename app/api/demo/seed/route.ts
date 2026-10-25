// app/api/demo/seed/route.ts

import crypto from "crypto";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";

function hash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function hoursFromNow(hours: number) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export async function POST() {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);
    const { error: deleteError } = await supabase.from("leads").delete().eq("company_id", companyId).eq("source", "demo");
    if (deleteError) throw new Error(deleteError.message);

    const demoLeads = [
      {
        input:
          "My AC stopped cooling at 11826 West Ave San Antonio TX 78216. Need help today. Call me at 210-555-1818. Email me at customer1@example.com.",
        message:
          "My AC stopped cooling at 11826 West Ave San Antonio TX 78216. Need help today. Call me at 210-555-1818. Email me at customer1@example.com.",
        reply:
          "Hey — thanks for reaching out. We may be able to get someone out today. What time works best?",
        type: "hvac",
        priority: "high",
        status: "booked",
        customer_name: "Sarah Martinez",
        email: "customer1@example.com",
        phone: "210-555-1818",
        address: "11826 West Ave",
        city: "San Antonio",
        state: "TX",
        zip: "78216",
        preferred_time: "today",
        issue_summary: "AC stopped cooling. Customer wants same-day help.",
        source: "demo",
        appointment_time: hoursFromNow(26),
        calendar_event_id: "demo_calendar_event_001",
        sent_at: hoursAgo(7),
        first_response_at: hoursAgo(7),
        response_time_seconds: 18,
        follow_up_count: 1,
        last_follow_up_at: hoursAgo(3),
        next_follow_up_at: null,
        qualification: {
          customerName: "Sarah Martinez",
          email: "customer1@example.com",
          phone: "210-555-1818",
          urgency: "high",
          serviceType: "hvac",
          preferredTime: "today",
          location: {
            address: "11826 West Ave",
            city: "San Antonio",
            state: "TX",
            zip: "78216",
          },
        },
      },
      {
        input:
          "AC is blowing warm air at 4007 McCullough Ave San Antonio TX 78212. Tomorrow afternoon works. 210-555-1515.",
        message:
          "AC is blowing warm air at 4007 McCullough Ave San Antonio TX 78212. Tomorrow afternoon works. 210-555-1515.",
        reply:
          "Hey — thanks for reaching out. We can check availability for tomorrow afternoon.",
        type: "hvac",
        priority: "high",
        status: "awaiting_customer",
        customer_name: "David Cohen",
        email: "customer2@example.com",
        phone: "210-555-1515",
        address: "4007 McCullough Ave",
        city: "San Antonio",
        state: "TX",
        zip: "78212",
        preferred_time: "tomorrow afternoon",
        issue_summary: "AC blowing warm air.",
        source: "demo",
        sent_at: hoursAgo(2),
        first_response_at: hoursAgo(2),
        response_time_seconds: 24,
        follow_up_count: 0,
        next_follow_up_at: hoursFromNow(22),
        qualification: {
          customerName: "David Cohen",
          email: "customer2@example.com",
          phone: "210-555-1515",
          urgency: "high",
          serviceType: "hvac",
          preferredTime: "tomorrow afternoon",
          location: {
            address: "4007 McCullough Ave",
            city: "San Antonio",
            state: "TX",
            zip: "78212",
          },
        },
      },
      {
        input:
          "Need AC repair ASAP at 7421 Blanco Rd San Antonio TX 78216. Call 210-555-9090.",
        message:
          "Need AC repair ASAP at 7421 Blanco Rd San Antonio TX 78216. Call 210-555-9090.",
        reply:
          "Hey — thanks for reaching out. We may be able to help quickly. What time today works best?",
        type: "hvac",
        priority: "high",
        status: "new",
        customer_name: "Mike Ramirez",
        email: null,
        phone: "210-555-9090",
        address: "7421 Blanco Rd",
        city: "San Antonio",
        state: "TX",
        zip: "78216",
        preferred_time: "today",
        issue_summary: "Urgent AC repair request.",
        source: "demo",
        follow_up_count: 0,
        qualification: {
          customerName: "Mike Ramirez",
          email: null,
          phone: "210-555-9090",
          urgency: "high",
          serviceType: "hvac",
          preferredTime: "today",
          location: {
            address: "7421 Blanco Rd",
            city: "San Antonio",
            state: "TX",
            zip: "78216",
          },
        },
      },
      {
        input:
          "My AC is broken at 123 Main St Dallas TX 75201. Need someone today. 210-555-2222.",
        message:
          "My AC is broken at 123 Main St Dallas TX 75201. Need someone today. 210-555-2222.",
        reply:
          "Hey — thanks for reaching out. It looks like this may be outside our current service area.",
        type: "hvac",
        priority: "high",
        status: "outside_service_area",
        customer_name: "Outside Area Lead",
        email: null,
        phone: "210-555-2222",
        address: "123 Main St",
        city: "Dallas",
        state: "TX",
        zip: "75201",
        preferred_time: "today",
        issue_summary: "Outside service area request.",
        source: "demo",
        follow_up_count: 0,
        qualification: {
          customerName: "Outside Area Lead",
          email: null,
          phone: "210-555-2222",
          urgency: "high",
          serviceType: "hvac",
          preferredTime: "today",
          location: {
            address: "123 Main St",
            city: "Dallas",
            state: "TX",
            zip: "75201",
          },
        },
      },
    ].map((lead, index) => ({
      ...lead,
      company_id: companyId,
      created_at: hoursAgo(index + 1),
      fingerprint: hash(`${lead.phone}-${lead.issue_summary}-${index}`),
    }));

    const { data, error } = await supabase
      .from("leads")
      .insert(demoLeads)
      .select();

    if (error) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      seeded: data?.length ?? 0,
      leads: data ?? [],
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err?.message ?? "demo_seed_failed",
      },
      { status: err?.message === "unauthorized" ? 401 : 500 }
    );
  }
}