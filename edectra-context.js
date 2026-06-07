const EDECTRA_CONTEXT_KEY = "livequiz.edectraContext";

function firstParam(params, names) {
    for (const name of names) {
        const value = params.get(name);
        if (value !== null && String(value).trim()) {
            return String(value).trim();
        }
    }
    return "";
}

function readStoredContext() {
    try {
        const raw = sessionStorage.getItem(EDECTRA_CONTEXT_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function writeStoredContext(context) {
    try {
        sessionStorage.setItem(EDECTRA_CONTEXT_KEY, JSON.stringify(context));
    } catch (error) {
        console.warn("[LiveQuiz][Edectra] Could not store launch context", error);
    }
}

function clearStoredContext() {
    try {
        sessionStorage.removeItem(EDECTRA_CONTEXT_KEY);
    } catch {
        // Storage can be unavailable in restrictive browser modes.
    }
}

export function initializeEdectraLaunchContext(search = window.location.search) {
    const params = new URLSearchParams(search);
    const classroomId = firstParam(params, ["classroom_id", "classId"]);
    const source = firstParam(params, ["source"]);
    const normalizedSource = source.toLowerCase();
    const teacherId = firstParam(params, ["teacher_id", "teacherId"]);
    const studentId = firstParam(params, ["studentId", "student_id"]);
    const profileId = firstParam(params, ["profile_id", "profileId"]);
    const userId = firstParam(params, ["userId", "user_id"]);
    const quizId = firstParam(params, ["quiz_id", "quizId"]);
    const returnUrl = firstParam(params, ["return_url", "returnUrl"]);
    const syncEndpoint = firstParam(params, ["syncEndpoint", "sync_endpoint"]);
    const isEdectraModeActive = ["edectra", "edtechra"].includes(normalizedSource) && Boolean(classroomId);
    const context = isEdectraModeActive
        ? {
            isEdtechraLaunch: true,
            classroomId,
            classId: classroomId,
            source,
            teacherId,
            teacher_id: teacherId,
            studentId,
            student_id: studentId,
            profileId,
            profile_id: profileId,
            userId,
            user_id: userId,
            quizId,
            quiz_id: quizId,
            returnUrl,
            return_url: returnUrl,
            syncEndpoint,
            integrationMode: "edectra-connected"
        }
        : {
            isEdtechraLaunch: false,
            classroomId: "",
            classId: "",
            source,
            teacherId: "",
            teacher_id: "",
            studentId: "",
            student_id: "",
            profileId: "",
            profile_id: "",
            userId: "",
            user_id: "",
            quizId: "",
            quiz_id: "",
            returnUrl: "",
            return_url: "",
            syncEndpoint: "",
            integrationMode: "standalone"
        };

    if (isEdectraModeActive) {
        writeStoredContext(context);
    } else {
        clearStoredContext();
    }

    console.info("[LiveQuiz][Edectra] detected classId", classroomId || null);
    console.info("[LiveQuiz][Edectra] detected source", source || null);
    console.info("[LiveQuiz][Edectra] detected student identity", {
        hasStudentId: Boolean(studentId),
        hasProfileId: Boolean(profileId),
        hasUserId: Boolean(userId)
    });
    console.info("[LiveQuiz][Edectra] mode active", isEdectraModeActive);

    return context;
}

export function getEdectraLaunchContext() {
    return readStoredContext() || {
        isEdtechraLaunch: false,
        classroomId: "",
        classId: "",
        source: "",
        teacherId: "",
        teacher_id: "",
        studentId: "",
        student_id: "",
        profileId: "",
        profile_id: "",
        userId: "",
        user_id: "",
        quizId: "",
        quiz_id: "",
        returnUrl: "",
        return_url: "",
        syncEndpoint: "",
        integrationMode: "standalone"
    };
}

export function isEdectraConnected() {
    const context = getEdectraLaunchContext();
    return context.integrationMode === "edectra-connected" || context.isEdtechraLaunch === true;
}
