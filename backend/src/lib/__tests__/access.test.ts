import { describe, expect, it } from "vitest";
import {
    checkProjectAccess,
    ensureDocAccess,
    ensureReviewAccess,
    listAccessibleProjectIds,
} from "../access";

type ProjectRow = {
    id: string;
    user_id: string;
    shared_with: string[] | null;
};

/**
 * Hand-rolled stub of just the Supabase client surface the access helpers
 * touch:
 *   db.from("projects").select(...).eq("id", id).single()
 *   db.from("projects").select(...).eq("user_id", id)
 *   db.from("projects").select(...).contains("shared_with", json).neq(...)
 *
 * Returning unknown lets us pass it where `Db` is expected without pulling
 * in the real Supabase runtime dependency in unit tests.
 */
function makeDb(projects: ProjectRow[]): unknown {
    return {
        from(table: string) {
            if (table !== "projects") {
                throw new Error(`unexpected table ${table}`);
            }
            const filters: Array<(p: ProjectRow) => boolean> = [];
            const builder = {
                select(_cols: string) {
                    return builder;
                },
                eq(col: keyof ProjectRow, val: string) {
                    filters.push((p) => p[col] === val);
                    return builder;
                },
                neq(col: keyof ProjectRow, val: string) {
                    filters.push((p) => p[col] !== val);
                    return builder;
                },
                contains(col: keyof ProjectRow, json: string) {
                    const needle = JSON.parse(json) as string[];
                    filters.push((p) => {
                        const list = p[col];
                        if (!Array.isArray(list)) return false;
                        return needle.every((n) =>
                            list.some(
                                (e) =>
                                    typeof e === "string" &&
                                    e.toLowerCase() === n.toLowerCase(),
                            ),
                        );
                    });
                    return builder;
                },
                async single() {
                    const matches = projects.filter((p) =>
                        filters.every((f) => f(p)),
                    );
                    return { data: matches[0] ?? null };
                },
                then(
                    onFulfilled: (result: { data: ProjectRow[] }) => unknown,
                ) {
                    const matches = projects.filter((p) =>
                        filters.every((f) => f(p)),
                    );
                    return Promise.resolve(onFulfilled({ data: matches }));
                },
            };
            return builder;
        },
    };
}

const OWNER = "user-owner";
const VIEWER_EMAIL = "viewer@example.com";
const STRANGER = "user-stranger";
const STRANGER_EMAIL = "stranger@example.com";

const PROJECTS: ProjectRow[] = [
    { id: "p1", user_id: OWNER, shared_with: null },
    { id: "p2", user_id: OWNER, shared_with: [VIEWER_EMAIL] },
    { id: "p3", user_id: OWNER, shared_with: ["VIEWER@EXAMPLE.COM"] },
];

describe("checkProjectAccess", () => {
    it("returns isOwner=true for the owner", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const result = await checkProjectAccess("p1", OWNER, null, db);
        expect(result).toEqual({
            ok: true,
            isOwner: true,
            project: PROJECTS[0],
        });
    });

    it("grants access to a shared user via email match", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const result = await checkProjectAccess(
            "p2",
            STRANGER,
            VIEWER_EMAIL,
            db,
        );
        expect(result).toEqual({
            ok: true,
            isOwner: false,
            project: PROJECTS[1],
        });
    });

    it("matches share emails case-insensitively", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const result = await checkProjectAccess(
            "p3",
            STRANGER,
            VIEWER_EMAIL,
            db,
        );
        expect(result.ok).toBe(true);
    });

    it("denies a stranger with no share entry", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const result = await checkProjectAccess(
            "p2",
            STRANGER,
            STRANGER_EMAIL,
            db,
        );
        expect(result).toEqual({ ok: false });
    });

    it("denies access when shared_with is null and caller is not owner", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const result = await checkProjectAccess(
            "p1",
            STRANGER,
            STRANGER_EMAIL,
            db,
        );
        expect(result.ok).toBe(false);
    });

    it("returns ok:false for non-existent projects", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const result = await checkProjectAccess(
            "missing",
            OWNER,
            null,
            db,
        );
        expect(result).toEqual({ ok: false });
    });

    it("denies users with empty email and no ownership", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const result = await checkProjectAccess("p2", STRANGER, "", db);
        expect(result.ok).toBe(false);
    });
});

describe("ensureDocAccess", () => {
    it("owner of the doc passes without hitting the project table", async () => {
        // Pass a poisoned Db that throws — proves no DB call is made.
        const db = {
            from() {
                throw new Error("should not be called");
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        const result = await ensureDocAccess(
            { user_id: OWNER, project_id: "p1" },
            OWNER,
            null,
            db,
        );
        expect(result).toEqual({ ok: true, isOwner: true });
    });

    it("falls through to project access for shared docs", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const result = await ensureDocAccess(
            { user_id: OWNER, project_id: "p2" },
            STRANGER,
            VIEWER_EMAIL,
            db,
        );
        expect(result).toEqual({ ok: true, isOwner: false });
    });

    it("denies when doc has no project and caller is not owner", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const result = await ensureDocAccess(
            { user_id: OWNER, project_id: null },
            STRANGER,
            STRANGER_EMAIL,
            db,
        );
        expect(result).toEqual({ ok: false });
    });

    it("denies when project access denied", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const result = await ensureDocAccess(
            { user_id: OWNER, project_id: "p1" },
            STRANGER,
            STRANGER_EMAIL,
            db,
        );
        expect(result).toEqual({ ok: false });
    });
});

describe("ensureReviewAccess", () => {
    it("owner passes", async () => {
        const db = {
            from() {
                throw new Error("should not be called");
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        const result = await ensureReviewAccess(
            { user_id: OWNER, project_id: null },
            OWNER,
            null,
            db,
        );
        expect(result).toEqual({ ok: true, isOwner: true });
    });

    it("standalone review with direct share grants access", async () => {
        // shared_with on the review itself, no project — must not call DB.
        const db = {
            from() {
                throw new Error("should not be called");
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        const result = await ensureReviewAccess(
            {
                user_id: OWNER,
                project_id: null,
                shared_with: [VIEWER_EMAIL],
            },
            STRANGER,
            VIEWER_EMAIL,
            db,
        );
        expect(result).toEqual({ ok: true, isOwner: false });
    });

    it("project-scoped review falls through to project access", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const result = await ensureReviewAccess(
            { user_id: OWNER, project_id: "p2", shared_with: null },
            STRANGER,
            VIEWER_EMAIL,
            db,
        );
        expect(result).toEqual({ ok: true, isOwner: false });
    });

    it("denies stranger on a private standalone review", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const result = await ensureReviewAccess(
            { user_id: OWNER, project_id: null, shared_with: null },
            STRANGER,
            STRANGER_EMAIL,
            db,
        );
        expect(result).toEqual({ ok: false });
    });
});

describe("listAccessibleProjectIds", () => {
    it("returns the union of owned and shared projects, deduped", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const ids = await listAccessibleProjectIds(OWNER, VIEWER_EMAIL, db);
        expect(new Set(ids)).toEqual(new Set(["p1", "p2", "p3"]));
    });

    it("returns just shared projects for non-owners", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const ids = await listAccessibleProjectIds(
            STRANGER,
            VIEWER_EMAIL,
            db,
        );
        expect(new Set(ids)).toEqual(new Set(["p2", "p3"]));
    });

    it("returns owned projects only when no email is supplied", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const ids = await listAccessibleProjectIds(OWNER, null, db);
        expect(new Set(ids)).toEqual(new Set(["p1", "p2", "p3"]));
    });

    it("returns nothing for a stranger with no share entries", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = makeDb(PROJECTS) as any;
        const ids = await listAccessibleProjectIds(
            STRANGER,
            STRANGER_EMAIL,
            db,
        );
        expect(ids).toEqual([]);
    });
});
