import { NextResponse } from "next/server";
import { getApiDocs } from "@/lib/swagger";

export async function GET() {
  // Finkuby: the spec is public; serve it only when NEXT_PUBLIC_SWAGGER_ENABLED is "true".
  if (process.env.NEXT_PUBLIC_SWAGGER_ENABLED !== "true") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const spec = getApiDocs();
  return NextResponse.json(spec);
}
