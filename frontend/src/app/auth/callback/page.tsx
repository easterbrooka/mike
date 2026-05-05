"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

function CallbackInner() {
    const router = useRouter();
    const searchParams = useSearchParams();

    useEffect(() => {
        async function exchange() {
            const errorDescription = searchParams.get("error_description");
            if (errorDescription) {
                router.replace(
                    `/login?error=${encodeURIComponent(errorDescription)}`,
                );
                return;
            }
            const code = searchParams.get("code");
            if (!code) {
                router.replace("/login");
                return;
            }
            const { error } = await supabase.auth.exchangeCodeForSession(code);
            if (error) {
                router.replace(
                    `/login?error=${encodeURIComponent(error.message)}`,
                );
                return;
            }
            router.replace("/assistant");
        }
        exchange();
    }, [searchParams, router]);

    return (
        <div className="min-h-dvh flex items-center justify-center text-sm text-gray-500">
            Signing you in…
        </div>
    );
}

export default function AuthCallbackPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-dvh flex items-center justify-center text-sm text-gray-500">
                    Signing you in…
                </div>
            }
        >
            <CallbackInner />
        </Suspense>
    );
}
