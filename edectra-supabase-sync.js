import { getEdectraLaunchContext, isEdectraConnected } from "./edectra-context.js";

const SYNC_SUCCESS_PREFIX = "livequiz.edectraScoreSync.success";
const pendingSyncs = new Set();
const EDTECHRA_SCORE_SYNC_ENDPOINT = window.EDTECHRA_SCORE_SYNC_ENDPOINT
    || window.LiveQuizSupabase?.scoreSyncEndpoint
    || "/api/live-quiz-score-sync";

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

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function getUrlSyncEndpoint() {
    try {
        return new URLSearchParams(window.location.search).get("syncEndpoint")?.trim() || "";
    } catch {
        return "";
    }
}

function getScoreSyncEndpoint(context = {}) {
    return context.syncEndpoint || getUrlSyncEndpoint() || EDTECHRA_SCORE_SYNC_ENDPOINT;
}

export async function syncFinalScoresToEdectra({ gameId, pin, leaderboard, totalQuestions, statsByStudentId = {} }) {
    if (!isEdectraConnected()) {
        console.info("[LiveQuiz][Edectra] sync skipped", { reason: "not edectra-connected" });
        return { skipped: true, reason: "not edectra-connected" };
    }

    const context = getEdectraLaunchContext();
    const classId = context.classroomId || context.classId;

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
    const eligibleLeaderboard = leaderboard.map((student, index) => ({ ...student, finalRank: index + 1 })).filter((student) => {
        if (!["edectra", "edtechra"].includes(String(student.source || "").toLowerCase())) return false;
        if (student.edectraMembershipValidated !== true) {
            console.warn("[LiveQuiz][Edectra] result row skipped because membership was not validated", {
                firebaseStudentId: student.id,
                studentName: student.name || ""
            });
            return false;
        }
        return Boolean(student.edectraProfileId || student.edectraStudentId || student.edectraUserId);
    });

    const results = eligibleLeaderboard.map((student) => {
        const stats = statsByStudentId[student.id] || {};
        const correctCount = toNumber(stats.correctCount);
        const wrongCount = toNumber(stats.wrongCount);
        const accuracy = safeTotalQuestions > 0
            ? Math.round((correctCount / safeTotalQuestions) * 100)
            : toNumber(stats.accuracy);
        const profileId = student.edectraProfileId || student.edectraStudentId || student.edectraUserId || "";

        return {
            student_id: student.edectraStudentId || profileId,
            profile_id: profileId,
            student_name: student.name || "",
            score: toNumber(student.score),
            correct_count: correctCount,
            wrong_count: wrongCount,
            total_questions: safeTotalQuestions,
            accuracy,
            final_rank: student.finalRank
        };
    });

    console.info("[LiveQuiz][Edectra] number of results being synced", results.length);

    if (results.length === 0) {
        console.warn("[LiveQuiz][Edectra] sync skipped", { reason: "no validated Edectra students", classId, gameId });
        return { skipped: true, reason: "no validated Edectra students" };
    }

    pendingSyncs.add(syncKey);
    try {
        const endpoint = getScoreSyncEndpoint(context);
        const payload = {
            classroom_id: classId,
            teacher_id: context.teacherId || context.teacher_id || "",
            live_quiz_session_id: gameId,
            firebase_game_id: gameId,
            quiz_id: context.quizId || context.quiz_id || "",
            source: "edtechra-live-quiz",
            results
        };

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
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
        const result = await response.json().catch(() => ({}));
        console.info("[LiveQuiz][Edectra] sync success", { classId, gameId, count: results.length, result });
        return { success: true, count: results.length, result };
    } catch (error) {
        console.warn("[LiveQuiz][Edectra] sync failure", {
            message: error?.message || String(error),
            classId,
            gameId
        });
        return { success: false, error };
    } finally {
        pendingSyncs.delete(syncKey);
    }
}
