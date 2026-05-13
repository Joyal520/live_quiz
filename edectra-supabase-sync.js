import { getEdectraLaunchContext, isEdectraConnected } from "./edectra-context.js";

const SYNC_SUCCESS_PREFIX = "livequiz.edectraScoreSync.success";
const pendingSyncs = new Set();

const SUPABASE_URL = window.LiveQuizSupabase?.url || "";
const SUPABASE_ANON_KEY = window.LiveQuizSupabase?.anonKey || "";

function getSyncKey(classId, gameId) {
    return `${SYNC_SUCCESS_PREFIX}.${classId}.${gameId}`;
}

function hasSyncCompleted(syncKey) {
    try {
        return localStorage.getItem(syncKey) === "true";
    } catch {
        return false;
    }
}

function markSyncCompleted(syncKey) {
    try {
        localStorage.setItem(syncKey, "true");
    } catch {
        // Storage can be unavailable in restrictive browser modes.
    }
}

function hasSupabaseConfig() {
    return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

export async function syncFinalScoresToEdectra({ gameId, pin, leaderboard, totalQuestions, statsByStudentId = {} }) {
    if (!isEdectraConnected()) {
        console.info("[LiveQuiz][Edectra] sync skipped", { reason: "not edectra-connected" });
        return { skipped: true, reason: "not edectra-connected" };
    }

    const context = getEdectraLaunchContext();
    const classId = context.classId;

    if (!classId || !gameId) {
        console.info("[LiveQuiz][Edectra] sync skipped", { reason: "missing classId or gameId", classId, gameId });
        return { skipped: true, reason: "missing classId or gameId" };
    }

    const syncKey = getSyncKey(classId, gameId);
    if (hasSyncCompleted(syncKey) || pendingSyncs.has(syncKey)) {
        console.info("[LiveQuiz][Edectra] sync skipped", { reason: "already synced", classId, gameId });
        return { skipped: true, reason: "already synced" };
    }

    console.info("[LiveQuiz][Edectra] sync started", { classId, gameId, pin });

    const safeTotalQuestions = toNumber(totalQuestions);
    const rows = leaderboard.map((student) => {
        const stats = statsByStudentId[student.id] || {};
        const correctCount = toNumber(stats.correctCount);
        const wrongCount = toNumber(stats.wrongCount);
        const accuracy = safeTotalQuestions > 0
            ? Math.round((correctCount / safeTotalQuestions) * 100)
            : toNumber(stats.accuracy);

        return {
            class_id: classId,
            source: context.source || "edectra",
            firebase_game_id: gameId,
            firebase_pin: pin || "",
            student_id: student.id,
            student_name: student.name || "",
            score: toNumber(student.score),
            correct_count: correctCount,
            wrong_count: wrongCount,
            total_questions: safeTotalQuestions,
            accuracy
        };
    });

    console.info("[LiveQuiz][Edectra] number of results being synced", rows.length);

    if (!hasSupabaseConfig()) {
        const error = new Error("Missing Supabase anon configuration.");
        console.error("[LiveQuiz][Edectra] sync failure", {
            message: error.message,
            hasUrl: Boolean(SUPABASE_URL),
            hasAnonKey: Boolean(SUPABASE_ANON_KEY)
        });
        return { success: false, error };
    }

    pendingSyncs.add(syncKey);
    try {
        const endpoint = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/live_quiz_results?on_conflict=class_id,firebase_game_id,student_id`;
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                "Content-Type": "application/json",
                Prefer: "resolution=merge-duplicates"
            },
            body: JSON.stringify(rows)
        });

        if (!response.ok) {
            let details = null;
            try {
                details = await response.json();
            } catch {
                details = await response.text();
            }
            throw new Error(`Supabase sync failed with HTTP ${response.status}: ${JSON.stringify(details)}`);
        }

        markSyncCompleted(syncKey);
        console.info("[LiveQuiz][Edectra] sync success", { classId, gameId, count: rows.length });
        return { success: true, count: rows.length };
    } catch (error) {
        console.error("[LiveQuiz][Edectra] sync failure", {
            message: error?.message || String(error),
            classId,
            gameId
        });
        return { success: false, error };
    } finally {
        pendingSyncs.delete(syncKey);
    }
}
