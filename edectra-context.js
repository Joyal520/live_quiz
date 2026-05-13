const EDECTRA_CONTEXT_KEY = "livequiz.edectraContext";

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
    const classId = params.get("classId")?.trim() || "";
    const source = params.get("source")?.trim() || "";
    const isEdectraModeActive = source === "edectra" && Boolean(classId);
    const context = isEdectraModeActive
        ? {
            classId,
            source,
            integrationMode: "edectra-connected"
        }
        : {
            classId: "",
            source,
            integrationMode: "standalone"
        };

    if (isEdectraModeActive) {
        writeStoredContext(context);
    } else {
        clearStoredContext();
    }

    console.info("[LiveQuiz][Edectra] detected classId", classId || null);
    console.info("[LiveQuiz][Edectra] detected source", source || null);
    console.info("[LiveQuiz][Edectra] mode active", isEdectraModeActive);

    return context;
}

export function getEdectraLaunchContext() {
    return readStoredContext() || {
        classId: "",
        source: "",
        integrationMode: "standalone"
    };
}

export function isEdectraConnected() {
    return getEdectraLaunchContext().integrationMode === "edectra-connected";
}
