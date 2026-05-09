import { MODELS, type ModelOption } from "../components/assistant/ModelToggle";

export type ModelProvider = "claude" | "gemini";

export interface SystemProviders {
    claude: boolean;
    gemini: boolean;
}

/**
 * Per-user API-key configuration status. Booleans only — the raw keys
 * never come back to the browser.
 */
export interface UserKeyStatus {
    claudeKeyConfigured: boolean;
    geminiKeyConfigured: boolean;
}

export function getModelProvider(modelId: string): ModelProvider | null {
    const model = MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    return model.group === "Anthropic" ? "claude" : "gemini";
}

export function isModelAvailable(
    modelId: string,
    keys: UserKeyStatus,
    systemProviders?: SystemProviders,
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    return isProviderAvailable(provider, keys, systemProviders);
}

export function isProviderAvailable(
    provider: ModelProvider,
    keys: UserKeyStatus,
    systemProviders?: SystemProviders,
): boolean {
    if (provider === "claude") {
        return keys.claudeKeyConfigured || !!systemProviders?.claude;
    }
    return keys.geminiKeyConfigured || !!systemProviders?.gemini;
}

export function providerLabel(provider: ModelProvider): string {
    return provider === "claude" ? "Anthropic (Claude)" : "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    return group === "Anthropic" ? "claude" : "gemini";
}
