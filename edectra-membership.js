import { getEdectraLaunchContext, isEdectraConnected } from "./edectra-context.js";

export const EDECTRA_CLASSROOM_BLOCK_MESSAGE = "Sorry, you cannot take part in this quiz because you do not belong to this classroom. Please contact your teacher for more details.";

const SUPABASE_URL = window.LiveQuizSupabase?.url || "";
const SUPABASE_ANON_KEY = window.LiveQuizSupabase?.anonKey || "";
const membershipConfig = window.LiveQuizSupabase?.membershipValidation || {};

function hasSupabaseConfig() {
    return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function parseMembershipResponse(value) {
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) {
        if (value.length === 0) return false;
        return parseMembershipResponse(value[0]);
    }
    if (value && typeof value === "object") {
        if (typeof value.is_member === "boolean") return value.is_member;
        if (typeof value.isMember === "boolean") return value.isMember;
        if (typeof value.allowed === "boolean") return value.allowed;
        if (typeof value.exists === "boolean") return value.exists;
    }
    return false;
}

function buildRpcBody(context) {
    return {
        class_id: context.classId,
        student_id: context.studentId || null,
        user_id: context.userId || null
    };
}

function getValidationIdentity(context) {
    if (context.studentId) return { type: "studentId", value: context.studentId };
    if (context.userId) return { type: "userId", value: context.userId };
    return null;
}

async function validateWithRpc(context) {
    const rpcName = membershipConfig.rpc || "validate_live_quiz_class_membership";
    const endpoint = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${encodeURIComponent(rpcName)}`;
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(buildRpcBody(context))
    });

    if (!response.ok) {
        let details = "";
        try {
            details = JSON.stringify(await response.json());
        } catch {
            details = await response.text();
        }
        throw new Error(`Supabase membership RPC failed with HTTP ${response.status}: ${details}`);
    }

    return parseMembershipResponse(await response.json());
}

export async function validateEdectraClassroomMembership() {
    if (!isEdectraConnected()) {
        return { allowed: true, validated: false, reason: "public-mode" };
    }

    const context = getEdectraLaunchContext();
    if (!context.classId) {
        return { allowed: true, validated: false, reason: "missing-class-id" };
    }

    const identity = getValidationIdentity(context);
    if (!identity) {
        console.warn("[LiveQuiz][Edectra] Classroom-secure mode is active, but no Edectra studentId/userId was provided. Membership validation cannot be performed; nickname validation is intentionally not used.");
        return { allowed: true, validated: false, reason: "missing-student-identity", context };
    }

    if (!hasSupabaseConfig()) {
        console.warn("[LiveQuiz][Edectra] Classroom-secure mode is active, but Supabase anon configuration is missing. Membership validation cannot be performed.");
        return { allowed: true, validated: false, reason: "missing-supabase-config", context, identity };
    }

    try {
        const isMember = await validateWithRpc(context);
        return {
            allowed: isMember,
            validated: true,
            reason: isMember ? "member" : "not-class-member",
            context,
            identity
        };
    } catch (error) {
        console.warn("[LiveQuiz][Edectra] Membership validation could not be completed. Check that the Supabase anon-accessible RPC exists and enforces classroom membership safely.", {
            message: error?.message || String(error),
            classId: context.classId,
            identityType: identity.type
        });
        return { allowed: true, validated: false, reason: "validation-unavailable", error, context, identity };
    }
}
