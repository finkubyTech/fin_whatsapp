import { NextRequest, NextResponse } from "next/server";
import { getApiDocs } from "@/lib/swagger";
import { getAuthenticatedUser } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  // Finkuby: the spec is served only when NEXT_PUBLIC_SWAGGER_ENABLED is "true", and then only to a signed-in user.
  if (process.env.NEXT_PUBLIC_SWAGGER_ENABLED !== "true") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const spec = getApiDocs();
  return NextResponse.json(spec);
}
