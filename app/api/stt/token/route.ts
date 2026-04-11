import { NextResponse } from "next/server";

import { getServerSession } from "@/src/lib/auth/session";

export async function POST() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.SARVAM_API_KEY) {
    return NextResponse.json({ error: "Missing SARVAM_API_KEY" }, { status: 500 });
  }

  return NextResponse.json({ provider: "sarvam" });
}

