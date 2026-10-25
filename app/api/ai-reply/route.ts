// app/api/ai-reply/route.ts

import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth/getUser";
import { extractLeadData } from "@/lib/ai/extractLeadData";
import { generateLeadReply } from "@/lib/ai/generateLeadReply";

export async function POST(req: Request) {
  try {
    await getUser();
    const body = await req.json();

    const message = body.message ?? body.body ?? body.input ?? "";

    if (typeof message !== "string" || !message.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: "missing_message",
        },
        { status: 400 }
      );
    }

    const qualification = await extractLeadData(message);

    const reply = await generateLeadReply({
      message,
      qualification,
    });

    return NextResponse.json({
      success: true,
      reply,
      qualification,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err?.message ?? "reply_generation_failed",
      },
      { status: err?.message === "unauthorized" ? 401 : 500 }
    );
  }
}