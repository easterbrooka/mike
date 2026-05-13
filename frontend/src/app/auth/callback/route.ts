import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";

export async function GET(request: Request) {
    const url = new URL(request.url);
    const errorDescription = url.searchParams.get("error_description");
    if (errorDescription) {
        return NextResponse.redirect(
            new URL(
                `/login?error=${encodeURIComponent(errorDescription)}`,
                request.url,
            ),
        );
    }
    const code = url.searchParams.get("code");
    if (!code) {
        return NextResponse.redirect(new URL("/login", request.url));
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
        return NextResponse.redirect(
            new URL(
                `/login?error=${encodeURIComponent(error.message)}`,
                request.url,
            ),
        );
    }
    return NextResponse.redirect(new URL("/assistant", request.url));
}
