"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { apiBase } from "@/app/lib/apiBase";
import type { SystemProviders } from "@/app/lib/modelAvailability";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    tabularModel: string;
    /**
     * True when the user has saved a Claude / Gemini API key. The actual
     * key is never loaded into the browser — XSS would otherwise read it
     * out of React state. Storage / mutation lives entirely on the
     * backend (`GET/PUT /user/api-keys/...`).
     */
    claudeKeyConfigured: boolean;
    geminiKeyConfigured: boolean;
}

const NO_SYSTEM_PROVIDERS: SystemProviders = { claude: false, gemini: false };

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    systemProviders: SystemProviders;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateModelPreference: (
        field: "tabularModel",
        value: string,
    ) => Promise<boolean>;
    updateApiKey: (
        provider: "claude" | "gemini",
        value: string | null,
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [systemProviders, setSystemProviders] = useState<SystemProviders>(
        NO_SYSTEM_PROVIDERS,
    );

    const loadProfile = useCallback(async (userId: string) => {
        try {
            // Explicit column list — the api_key columns are deliberately
            // omitted so the raw keys never leave the backend.
            const { data, error } = await supabase
                .from("user_profiles")
                .select(
                    "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model",
                )
                .eq("user_id", userId)
                .single();

            // Define credit limit constant
            const MONTHLY_CREDIT_LIMIT = 999999; // temporarily unlimited

            // Calculate a default future reset date (30 days from now)
            const futureResetDate = new Date();
            futureResetDate.setDate(futureResetDate.getDate() + 30);
            const defaultResetDateStr = futureResetDate.toISOString();

            // Whether each provider is configured comes from a separate
            // backend call — the keys themselves stay server-side.
            const apiKeyStatus = await fetchApiKeyStatus();

            if (error) {
                // Set fallback profile data if profile doesn't exist
                setProfile({
                    displayName: null,
                    organisation: null,
                    messageCreditsUsed: 0,
                    creditsResetDate: defaultResetDateStr,
                    creditsRemaining: MONTHLY_CREDIT_LIMIT,
                    tier: "Free",
                    tabularModel: "gemini-3-flash-preview",
                    claudeKeyConfigured: apiKeyStatus.claude,
                    geminiKeyConfigured: apiKeyStatus.gemini,
                });
                return;
            }

            // Use fetched data to update profile state
            if (data) {
                let creditsUsed = data.message_credits_used;
                let resetDate = data.credits_reset_date;
                let creditsRemaining = MONTHLY_CREDIT_LIMIT - creditsUsed;
                let shouldUpdateDb = false;

                // Check if credits have expired and need reset
                if (resetDate && new Date() > new Date(resetDate)) {
                    // Calculate new reset date
                    const newResetDate = new Date();
                    newResetDate.setDate(newResetDate.getDate() + 30);
                    resetDate = newResetDate.toISOString();
                    creditsUsed = 0;
                    creditsRemaining = MONTHLY_CREDIT_LIMIT;
                    shouldUpdateDb = true;
                }

                // 1. Update local state immediately
                setProfile({
                    displayName: data.display_name,
                    organisation: data.organisation ?? null,
                    messageCreditsUsed: creditsUsed,
                    creditsResetDate: resetDate,
                    creditsRemaining: creditsRemaining,
                    tier: data.tier || "Free",
                    tabularModel:
                        data.tabular_model || "gemini-3-flash-preview",
                    claudeKeyConfigured: apiKeyStatus.claude,
                    geminiKeyConfigured: apiKeyStatus.gemini,
                });

                // 2. Update database in background if needed
                if (shouldUpdateDb) {
                    supabase
                        .from("user_profiles")
                        .update({
                            message_credits_used: 0,
                            credits_reset_date: resetDate,
                            updated_at: new Date().toISOString(),
                        })
                        .eq("user_id", userId)
                        .then(({ error }) => {
                            if (error)
                                console.error(
                                    "Failed to auto-reset credits",
                                    error,
                                );
                        });
                }
            }
        } catch (e) {
            console.error("Failed to load profile", e);
            // Calculate a default future reset date for fallback
            const futureResetDate = new Date();
            futureResetDate.setDate(futureResetDate.getDate() + 30);

            // Set fallback profile data on exception
            setProfile({
                displayName: null,
                organisation: null,
                messageCreditsUsed: 0,
                creditsResetDate: futureResetDate.toISOString(),
                creditsRemaining: 999999, // temporarily unlimited
                tier: "Free",
                tabularModel: "gemini-3-flash-preview",
                claudeKeyConfigured: false,
                geminiKeyConfigured: false,
            });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && user) {
            setLoading(true);
            loadProfile(user.id);
            loadSystemProviders();
        } else {
            setProfile(null);
            setSystemProviders(NO_SYSTEM_PROVIDERS);
            setLoading(false);
        }
    }, [isAuthenticated, user, loadProfile]);

    async function loadSystemProviders() {
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            if (!session) return;
            const res = await fetch(`${apiBase()}/system/llm-providers`, {
                headers: { Authorization: `Bearer ${session.access_token}` },
            });
            if (!res.ok) return;
            const data = (await res.json()) as SystemProviders;
            setSystemProviders({
                claude: !!data.claude,
                gemini: !!data.gemini,
            });
        } catch {
            // Best-effort; on failure, fall back to per-user keys only.
        }
    }

    async function fetchApiKeyStatus(): Promise<{
        claude: boolean;
        gemini: boolean;
    }> {
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            if (!session) return { claude: false, gemini: false };
            const res = await fetch(`${apiBase()}/user/api-keys/status`, {
                headers: { Authorization: `Bearer ${session.access_token}` },
            });
            if (!res.ok) return { claude: false, gemini: false };
            const data = (await res.json()) as {
                claude?: boolean;
                gemini?: boolean;
            };
            return {
                claude: !!data.claude,
                gemini: !!data.gemini,
            };
        } catch {
            return { claude: false, gemini: false };
        }
    }

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) {
                return false;
            }

            try {
                const { error } = await supabase
                    .from("user_profiles")
                    .update({
                        display_name: displayName,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("user_id", user.id);

                if (error) {
                    throw error;
                }

                setProfile((prev) => (prev ? { ...prev, displayName } : null));
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            try {
                const { error } = await supabase
                    .from("user_profiles")
                    .update({
                        organisation,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("user_id", user.id);
                if (error) throw error;
                setProfile((prev) =>
                    prev ? { ...prev, organisation } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateModelPreference = useCallback(
        async (
            field: "tabularModel",
            value: string,
        ): Promise<boolean> => {
            if (!user) return false;
            const dbField = field === "tabularModel" ? "tabular_model" : "";
            if (!dbField) return false;
            try {
                const { error } = await supabase
                    .from("user_profiles")
                    .update({
                        [dbField]: value,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("user_id", user.id);
                if (error) throw error;
                setProfile((prev) =>
                    prev ? { ...prev, [field]: value } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateApiKey = useCallback(
        async (
            provider: "claude" | "gemini",
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            const stateField =
                provider === "claude"
                    ? "claudeKeyConfigured"
                    : "geminiKeyConfigured";
            const normalized = value?.trim() ? value.trim() : null;
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                if (!session) return false;
                const res = await fetch(
                    `${apiBase()}/user/api-keys/${provider}`,
                    {
                        method: "PUT",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${session.access_token}`,
                        },
                        body: JSON.stringify({ value: normalized }),
                    },
                );
                if (!res.ok) return false;
                setProfile((prev) =>
                    prev
                        ? { ...prev, [stateField]: normalized !== null }
                        : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const reloadProfile = useCallback(async () => {
        if (user) {
            await loadProfile(user.id);
        }
    }, [user, loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!user || !profile) {
            return false;
        }

        // Check if user has credits remaining
        if (profile.creditsRemaining <= 0) {
            return false;
        }

        try {
            const newCreditsUsed = profile.messageCreditsUsed + 1;

            const { error } = await supabase
                .from("user_profiles")
                .update({
                    message_credits_used: newCreditsUsed,
                    updated_at: new Date().toISOString(),
                })
                .eq("user_id", user.id);

            if (error) {
                throw error;
            }

            // Update local state
            setProfile((prev) =>
                prev
                    ? {
                          ...prev,
                          messageCreditsUsed: newCreditsUsed,
                          creditsRemaining: 999999 - newCreditsUsed, // temporarily unlimited
                      }
                    : null,
            );

            return true;
        } catch (err) {
            return false;
        }
    }, [user, profile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                systemProviders,
                updateDisplayName,
                updateOrganisation,
                updateModelPreference,
                updateApiKey,
                reloadProfile,
                incrementMessageCredits,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
