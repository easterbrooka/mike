"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { SiteLogo } from "@/components/site-logo";
import { useAuth } from "@/contexts/AuthContext";

function LoginPageInner() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { isAuthenticated, authLoading } = useAuth();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(
        searchParams.get("error"),
    );

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/assistant");
        }
    }, [authLoading, isAuthenticated, router]);

    const handleSignIn = async () => {
        setLoading(true);
        setError(null);
        const redirectTo = `${window.location.origin}/auth/callback`;
        const { error: oauthError } = await supabase.auth.signInWithOAuth({
            provider: "azure",
            options: {
                redirectTo,
                scopes: "email openid profile offline_access",
            },
        });
        if (oauthError) {
            setLoading(false);
            setError(oauthError.message);
        }
    };

    return (
        <div className="min-h-dvh bg-white flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="md" className="md:text-4xl" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className="bg-white border border-gray-200 rounded-2xl p-8">
                    <h2 className="text-left text-2xl font-serif mb-2">
                        Sign in
                    </h2>
                    <p className="text-sm text-gray-600 mb-6">
                        Sign in with your work Microsoft account.
                    </p>

                    {error && (
                        <div className="text-red-600 text-sm bg-red-50 p-3 rounded mb-4">
                            {error}
                        </div>
                    )}

                    <Button
                        type="button"
                        disabled={loading}
                        onClick={handleSignIn}
                        className="w-full bg-black hover:bg-gray-900 text-white"
                    >
                        {loading ? "Redirecting…" : "Sign in with Microsoft"}
                    </Button>
                </div>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={<div className="min-h-dvh" />}>
            <LoginPageInner />
        </Suspense>
    );
}
