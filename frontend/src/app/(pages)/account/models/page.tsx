"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { MODELS } from "@/app/components/assistant/ModelToggle";
import {
    isModelAvailable,
    modelGroupToProvider,
} from "@/app/lib/modelAvailability";

export default function ModelsAndApiKeysPage() {
    const { profile, updateModelPreference, updateApiKey } = useUserProfile();

    return (
        <div className="space-y-4">
            {/* Model Preferences */}
            <div className="pb-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif">
                        Model Preferences
                    </h2>
                </div>
                <div className="space-y-4 max-w-md">
                    <div>
                        <label className="text-sm text-gray-600 block mb-2">
                            Tabular review model
                        </label>
                        <TabularModelDropdown
                            value={
                                profile?.tabularModel ??
                                "gemini-3-flash-preview"
                            }
                            apiKeys={{
                                claudeKeyConfigured:
                                    profile?.claudeKeyConfigured ?? false,
                                geminiKeyConfigured:
                                    profile?.geminiKeyConfigured ?? false,
                            }}
                            onChange={(id) =>
                                updateModelPreference("tabularModel", id)
                            }
                        />
                    </div>
                </div>
            </div>

            {/* API Keys */}
            <div className="py-6">
                <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-2xl font-medium font-serif">
                        API Keys
                    </h2>
                </div>
                <p className="text-sm text-gray-500 mb-4 max-w-xl">
                    You must provide your own API keys for the app to work or
                    add your API keys into the .env file if you are running your
                    own instance of Michelle.
                </p>
                <p className="text-xs text-gray-400 mb-4 max-w-xl">
                    Title generation automatically routes to the cheapest model
                    of whichever provider you&rsquo;ve configured (Gemini Flash
                    Lite if a Gemini key is set, otherwise Claude Haiku).
                </p>
                <p className="text-xs text-gray-400 mb-4 max-w-xl">
                    Saved keys never leave the server, so we can&rsquo;t show
                    you a key you&rsquo;ve already saved. Use{" "}
                    <strong>Replace</strong> to set a new one or{" "}
                    <strong>Clear</strong> to remove it.
                </p>
                <div className="space-y-4 max-w-xl">
                    <ApiKeyField
                        label="Anthropic (Claude) API Key"
                        placeholder="sk-ant-…"
                        configured={profile?.claudeKeyConfigured ?? false}
                        onSave={(value) =>
                            updateApiKey("claude", value.trim() || null)
                        }
                        onClear={() => updateApiKey("claude", null)}
                    />
                    <ApiKeyField
                        label="Google (Gemini) API Key"
                        placeholder="AI…"
                        configured={profile?.geminiKeyConfigured ?? false}
                        onSave={(value) =>
                            updateApiKey("gemini", value.trim() || null)
                        }
                        onClear={() => updateApiKey("gemini", null)}
                    />
                </div>
            </div>
        </div>
    );
}

function TabularModelDropdown({
    value,
    onChange,
    apiKeys,
}: {
    value: string;
    onChange: (id: string) => void;
    apiKeys: { claudeKeyConfigured: boolean; geminiKeyConfigured: boolean };
}) {
    const [isOpen, setIsOpen] = useState(false);
    const { systemProviders } = useUserProfile();
    const selected = MODELS.find((m) => m.id === value);
    const selectedAvailable = isModelAvailable(value, apiKeys, systemProviders);
    const groups: ("Anthropic" | "Google")[] = ["Anthropic", "Google"];

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm shadow-sm flex items-center justify-between gap-2 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-black/10"
                >
                    <span className="flex items-center gap-2 min-w-0">
                        {!selectedAvailable && (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                        )}
                        <span className="truncate text-gray-900">
                            {selected?.label ?? "Select a model"}
                        </span>
                    </span>
                    <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                className="z-50"
                style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                align="start"
            >
                {groups.map((group, gi) => {
                    const items = MODELS.filter((m) => m.group === group);
                    if (items.length === 0) return null;
                    return (
                        <div key={group}>
                            {gi > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                const provider = modelGroupToProvider(m.group);
                                const available = isModelAvailable(
                                    m.id,
                                    apiKeys,
                                    systemProviders,
                                );
                                return (
                                    <DropdownMenuItem
                                        key={m.id}
                                        className="cursor-pointer"
                                        onSelect={() => onChange(m.id)}
                                        title={
                                            !available
                                                ? `Add a ${provider === "claude" ? "Claude" : "Gemini"} API key to use this model`
                                                : undefined
                                        }
                                    >
                                        <span
                                            className={`flex-1 ${available ? "" : "text-gray-400"}`}
                                        >
                                            {m.label}
                                        </span>
                                        {!available && (
                                            <AlertCircle className="h-3.5 w-3.5 text-red-500 ml-1" />
                                        )}
                                        {m.id === value && available && (
                                            <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                                        )}
                                    </DropdownMenuItem>
                                );
                            })}
                        </div>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function ApiKeyField({
    label,
    placeholder,
    configured,
    onSave,
    onClear,
}: {
    label: string;
    placeholder: string;
    configured: boolean;
    onSave: (value: string) => Promise<boolean>;
    onClear: () => Promise<boolean>;
}) {
    // When configured, hide the input behind a "•••• Configured" pill until
    // the user clicks Replace. We never have the key string to populate the
    // input with — it's stored only on the backend.
    const [editing, setEditing] = useState(!configured);
    const [value, setValue] = useState("");
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        // If the configured status flips externally (e.g. another tab saved
        // a key), reset the editing UI accordingly.
        setEditing(!configured);
        if (configured) setValue("");
    }, [configured]);

    const dirty = value.trim().length > 0;

    const handleSave = async () => {
        if (!dirty) return;
        setIsSaving(true);
        const ok = await onSave(value);
        setIsSaving(false);
        if (ok) {
            setSaved(true);
            setValue("");
            setEditing(false);
            setTimeout(() => setSaved(false), 2000);
        } else {
            alert(`Failed to save ${label}.`);
        }
    };

    const handleClear = async () => {
        const ok = await onClear();
        if (ok) {
            setEditing(true);
            setValue("");
        } else {
            alert(`Failed to clear ${label}.`);
        }
    };

    if (!editing) {
        return (
            <div>
                <label className="text-sm text-gray-600 block mb-2">
                    {label}
                </label>
                <div className="flex gap-2 items-center">
                    <div className="flex-1 px-3 h-9 rounded-md border border-gray-300 bg-gray-50 text-sm text-gray-500 flex items-center gap-2">
                        <Check className="h-3.5 w-3.5 text-green-600" />
                        <span className="truncate">
                            Configured. Saved server-side.
                        </span>
                    </div>
                    <Button
                        type="button"
                        onClick={() => setEditing(true)}
                        variant="outline"
                    >
                        Replace
                    </Button>
                    <Button
                        type="button"
                        onClick={handleClear}
                        variant="outline"
                    >
                        Clear
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div>
            <label className="text-sm text-gray-600 block mb-2">{label}</label>
            <div className="flex gap-2">
                <Input
                    type="password"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={placeholder}
                    className="flex-1"
                    autoComplete="off"
                    spellCheck={false}
                />
                <Button
                    onClick={handleSave}
                    disabled={isSaving || !dirty || saved}
                    className="min-w-[80px] transition-all bg-black hover:bg-gray-900 text-white"
                >
                    {isSaving ? (
                        "Saving..."
                    ) : saved ? (
                        <>
                            <Check className="h-4 w-3" />
                            Saved
                        </>
                    ) : (
                        "Save"
                    )}
                </Button>
                {configured && (
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                            setEditing(false);
                            setValue("");
                        }}
                    >
                        Cancel
                    </Button>
                )}
            </div>
        </div>
    );
}
