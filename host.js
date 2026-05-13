import { db, ensureAnonAuth, TS, Fire, GameStatus, calculatePoints } from "./firebase.js";
import { syncFinalScoresToEdectra } from "./edectra-supabase-sync.js";
import { bindExitFullscreenButtons, enterFullscreen } from "./fullscreen.js";
import { clearForceHomepageNavigation, clearHomeNavigationState, goHomeSafely, isForceHomepageNavigation } from "./navigation.js";
const { doc, setDoc, getDocs, collection, query, orderBy, onSnapshot, updateDoc, writeBatch, deleteDoc } = Fire;

// Helper: strip markdown bold/italic markers from text
function cleanText(t) {
    return t ? t.replace(/\*\*/g, "").replace(/\*/g, "").replace(/^\d+[.):] ?/, "").trim() : "";
}

function createGameId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function escapeHtml(value = "") {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function getFirebaseErrorDetails(error) {
    return {
        code: error?.code || "unknown",
        message: error?.message || String(error)
    };
}

function showFirebaseError(context, error) {
    const details = getFirebaseErrorDetails(error);
    console.error(`[LiveQuiz] ${context}`, details, error);
    return `${context}: ${details.code} - ${details.message}`;
}

async function generateUniquePin(maxAttempts = 12) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const pin = String(Math.floor(100000 + Math.random() * 900000));
        const pinRef = doc(db, "pins", pin);
        const pinSnap = await Fire.getDoc(pinRef);

        if (!pinSnap.exists()) {
            console.info("[LiveQuiz] PIN generated", pin);
            return { pin, pinRef };
        }
    }

    throw new Error("Could not generate a unique PIN. Please try again.");
}

function renderLobbyPin(pin) {
    lobbyPin.innerHTML = String(pin)
        .split("")
        .map(d => `<div class="digit-box">${d}</div>`)
        .join("");
}

function buildLobbyUrl(sessionId, pin) {
    const url = new URL("./host-lobby.html", window.location.href);
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("pin", pin);
    return url.href;
}

function buildGameUrl(sessionId, pin) {
    const url = new URL("./host.html", window.location.href);
    url.searchParams.set("sessionId", sessionId);
    if (pin) url.searchParams.set("pin", pin);
    url.searchParams.set("start", "1");
    return url.href;
}

function replaceHostUrl(url, state = {}) {
    window.history.replaceState(state, "", url);
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function transitionToLobbyPage(target) {
    // 1. Animate setup view out
    views.setup?.classList.add("setup-route-exit");
    document.body.classList.add("host-routing-to-lobby");

    // 2. Show a transitional loading overlay so the user sees a smooth handoff
    let overlay = document.getElementById("lobbyTransitionOverlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "lobbyTransitionOverlay";
        overlay.style.cssText = [
            "position:fixed", "inset:0", "z-index:99999",
            "display:flex", "flex-direction:column", "align-items:center", "justify-content:center", "gap:18px",
            "background:rgba(9,9,25,0.92)", "backdrop-filter:blur(20px)",
            "opacity:0", "transition:opacity 280ms cubic-bezier(.2,.8,.2,1)",
            "pointer-events:all"
        ].join(";");
        overlay.innerHTML = `
            <div style="width:48px;height:48px;border:3px solid rgba(139,92,246,0.2);border-top-color:#8b5cf6;border-radius:50%;animation:spin 0.8s linear infinite"></div>
            <p style="color:rgba(255,255,255,0.7);font-weight:800;font-size:1rem;margin:0">Opening Lobby…</p>
            <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
        `;
        document.body.appendChild(overlay);
    }

    // Trigger overlay fade-in
    await wait(20);
    overlay.style.opacity = "1";
    await wait(320);

    // 3. Navigate to the dedicated lobby page
    window.location.assign(target);
}

const HostRouteState = {
    SETUP: "setup",
    LOBBY: "lobby",
    LIVE_QUESTION: "live-question",
    LEADERBOARD: "leaderboard",
    FINISHED: "finished"
};

function logHostRenderBranch(branch, detail = {}) {
    console.info(`[LiveQuiz][Host] selected render branch = ${branch}`, detail);
}

function getSessionQuestionIndex(gameData) {
    const qIndex = Number(gameData?.qIndex);
    return Number.isInteger(qIndex) ? qIndex : -1;
}

function isLiveSessionStatus(status) {
    return status === GameStatus.QUESTION || status === GameStatus.REVEAL;
}

function isEndedSessionStatus(status) {
    return status === GameStatus.FINISHED || status === "ended" || status === "reset" || status === "closed" || status === "cancelled";
}

function isValidSessionStatus(status) {
    return [GameStatus.LOBBY, GameStatus.QUESTION, GameStatus.REVEAL, GameStatus.FINISHED, "ended", "reset", "closed", "cancelled"].includes(status);
}

let lastHostFallbackReason = "";

function setHostFallbackReason(reason, detail = {}) {
    lastHostFallbackReason = reason;
    console.warn("[LiveQuiz][Host] fallback reason", { reason, ...detail });
}

// -- State ---------------------------------------------------------------------
let currentGameId = null;
let currentPin = "";
let currentQuiz = null;
let players = {};
let timerInterval = null;
let lbUnsubscribe = null;
let playersUnsubscribe = null;
let lbLimit = 10;
let lbFrozen = false;
let lastRanks = {};
let allQuizzes = []; // { id, title, questions }
let selectedQuizId = null;

let isRevealing = false;
let answersUnsub = null;
let isCreatingGame = false;
let hasActiveLobby = false;
let staleHostSessionForReset = null;

// -- Host Session Persistence (localStorage) --------------------------------
const HOST_SESSION_KEY = "edtechra.hostSession";

function saveHostSession(sessionId, pin, quizId) {
    try {
        localStorage.setItem(HOST_SESSION_KEY, JSON.stringify({
            sessionId,
            pin,
            quizId,
            savedAt: Date.now()
        }));
        console.info("[LiveQuiz][Host] Session saved to localStorage", { sessionId, pin });
    } catch { /* storage unavailable */ }
}

function loadHostSession() {
    try {
        const raw = localStorage.getItem(HOST_SESSION_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        // Expire after 4 hours
        if (Date.now() - (data.savedAt || 0) > 4 * 60 * 60 * 1000) {
            clearHostSession();
            return null;
        }
        return data;
    } catch {
        return null;
    }
}

function clearHostSession() {
    try {
        localStorage.removeItem(HOST_SESSION_KEY);
    } catch { /* ignore */ }
}

function clearHostRouteSessionState() {
    clearHostSession();
    clearHomeNavigationState();
    staleHostSessionForReset = null;
    hasActiveLobby = false;
    isCreatingGame = false;
}

function getKnownHostSession() {
    const saved = loadHostSession();
    return {
        sessionId: currentGameId || saved?.sessionId || staleHostSessionForReset?.sessionId || "",
        pin: currentPin || saved?.pin || staleHostSessionForReset?.pin || ""
    };
}

async function resetHostSession(options = {}) {
    const { redirect = true, confirmReset = true } = options;
    const known = getKnownHostSession();

    if (confirmReset && !confirm("End and reset this host session? The current PIN will stop working.")) {
        return false;
    }

    staleHostSessionForReset = loadHostSession();
    clearHostSession();
    hasActiveLobby = false;
    isCreatingGame = false;

    try {
        await ensureAnonAuth();
    } catch (error) {
        showFirebaseError("Reset auth check failed", error);
    }

    if (known.sessionId) {
        try {
            await updateDoc(doc(db, "games", known.sessionId), {
                status: "cancelled",
                endedAt: TS(),
                cancelledAt: TS()
            });
            console.info("[LiveQuiz][Host] Session marked cancelled", { sessionId: known.sessionId });
        } catch (error) {
            showFirebaseError("Session cancel failed", error);
        }
    }

    if (known.pin) {
        try {
            await deleteDoc(doc(db, "pins", known.pin));
            console.info("[LiveQuiz][Host] PIN deleted", { pin: known.pin });
        } catch (error) {
            showFirebaseError("PIN cleanup failed", error);
        }
    }

    currentGameId = null;
    currentPin = "";
    currentQuiz = null;
    players = {};
    if (playersUnsubscribe) {
        playersUnsubscribe();
        playersUnsubscribe = null;
    }
    if (lbUnsubscribe) {
        lbUnsubscribe();
        lbUnsubscribe = null;
    }
    if (answersUnsub) {
        answersUnsub();
        answersUnsub = null;
    }
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    stopAllBg(false);
    clearQuizAmbienceState();

    if (redirect) {
        window.location.href = "./host.html";
    } else {
        showView("setup");
        setSetupStatus("Previous session reset. You can create a new PIN.", "success");
    }

    return true;
}

function ensureResetSessionAction() {
    if (document.getElementById("resetHostSessionBtn")) return;

    const button = document.createElement("button");
    button.id = "resetHostSessionBtn";
    button.type = "button";
    button.className = "btn-secondary reset-host-session-control";
    button.textContent = "End Session";
    button.addEventListener("click", () => resetHostSession());
    document.body.appendChild(button);
}

function handleLiveQuizBackNavigation() {
    stopAllBg(false);
    clearQuizAmbienceState();
    clearHostRouteSessionState();
    goHomeSafely();
}

// -- Audio ---------------------------------------------------------------------
const sounds = {
    lobby: new Audio("waiting_sound.wav"),
    game: new Audio("quiz)background.mp3"),  // local bg during gameplay
    correct: new Audio("https://assets.mixkit.co/active_storage/sfx/2019/2019-preview.mp3"),
    tick: new Audio("https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3"),
    podium: new Audio("https://assets.mixkit.co/active_storage/sfx/2013/2013-preview.mp3"),
    cheer: new Audio("popper.mp3")  // Updated to popper.mp3 as requested
};
sounds.lobby.loop = true;
sounds.game.loop = true;

const QUIZ_AMBIENCE_TRACKS = {
    A: "sound/ambient-a.mp3",
    B: "sound/ambient-b.mp3"
};
const LAST_AMBIENCE_KEY = "lastQuizAmbience";
const CURRENT_AMBIENCE_KEY = "currentQuizAmbience";
const PENDING_AMBIENCE_KEY = "pendingQuizAmbience";
const SOUND_PREF_KEY = "edtechraSound";
const AMBIENCE_TARGET_VOLUME = 0.1;
let quizAmbienceAudio = null;
let quizAmbienceFadeTimer = null;
let activeQuizAmbienceTrack = "";

function isSoundEnabled() {
    try {
        return localStorage.getItem(SOUND_PREF_KEY) !== "off";
    } catch {
        return true;
    }
}

function resolveQuizAmbienceTrack({ alternate = false } = {}) {
    try {
        const pendingTrack = sessionStorage.getItem(PENDING_AMBIENCE_KEY);
        if (pendingTrack && QUIZ_AMBIENCE_TRACKS[pendingTrack]) {
            sessionStorage.removeItem(PENDING_AMBIENCE_KEY);
            sessionStorage.setItem(CURRENT_AMBIENCE_KEY, pendingTrack);
            return pendingTrack;
        }

        const currentTrack = sessionStorage.getItem(CURRENT_AMBIENCE_KEY);
        if (!alternate && currentTrack && QUIZ_AMBIENCE_TRACKS[currentTrack]) {
            return currentTrack;
        }

        const previousTrack = localStorage.getItem(LAST_AMBIENCE_KEY) || "A";
        const nextTrack = previousTrack === "A" ? "B" : "A";
        localStorage.setItem(LAST_AMBIENCE_KEY, nextTrack);
        sessionStorage.setItem(CURRENT_AMBIENCE_KEY, nextTrack);
        return nextTrack;
    } catch (error) {
        console.warn("[LiveQuiz][Host] Could not resolve quiz ambience", error);
        return "A";
    }
}

function stopQuizAmbience() {
    if (quizAmbienceFadeTimer) {
        clearInterval(quizAmbienceFadeTimer);
        quizAmbienceFadeTimer = null;
    }

    if (quizAmbienceAudio) {
        quizAmbienceAudio.pause();
        quizAmbienceAudio.currentTime = 0;
    }

    activeQuizAmbienceTrack = "";
}

function clearQuizAmbienceState() {
    try {
        sessionStorage.removeItem(PENDING_AMBIENCE_KEY);
        sessionStorage.removeItem(CURRENT_AMBIENCE_KEY);
    } catch {
        // Storage can be unavailable in restrictive browser modes.
    }
}

function startQuizAmbience(options = {}) {
    if (!isSoundEnabled()) {
        stopQuizAmbience();
        return;
    }

    const track = resolveQuizAmbienceTrack(options);
    const src = QUIZ_AMBIENCE_TRACKS[track];
    if (!src) return;

    sounds.game.pause();
    sounds.game.currentTime = 0;

    if (quizAmbienceAudio && activeQuizAmbienceTrack !== track) {
        stopQuizAmbience();
    }

    if (!quizAmbienceAudio || activeQuizAmbienceTrack !== track) {
        quizAmbienceAudio = new Audio(src);
        quizAmbienceAudio.loop = true;
        quizAmbienceAudio.volume = 0;
        activeQuizAmbienceTrack = track;
    }

    if (!quizAmbienceAudio.paused) return;

    quizAmbienceAudio.volume = 0;
    quizAmbienceAudio.play()
        .then(() => {
            if (quizAmbienceFadeTimer) clearInterval(quizAmbienceFadeTimer);
            quizAmbienceFadeTimer = setInterval(() => {
                if (!quizAmbienceAudio) return;
                const nextVolume = Math.min(AMBIENCE_TARGET_VOLUME, quizAmbienceAudio.volume + 0.01);
                quizAmbienceAudio.volume = nextVolume;
                if (nextVolume >= AMBIENCE_TARGET_VOLUME) {
                    clearInterval(quizAmbienceFadeTimer);
                    quizAmbienceFadeTimer = null;
                }
            }, 120);
        })
        .catch((error) => {
            console.warn("[LiveQuiz][Host] Quiz ambience playback blocked", error);
        });
}

function stopAllBg(keepGameMusic = false) {
    sounds.lobby.pause(); sounds.lobby.currentTime = 0;
    if (!keepGameMusic) {
        sounds.game.pause(); sounds.game.currentTime = 0;
        stopQuizAmbience();
    }
    sounds.podium.pause();
}

window.addEventListener("pagehide", () => {
    stopQuizAmbience();
});

// -- DOM -----------------------------------------------------------------------
const views = {
    setup: document.getElementById("view-setup"),
    lobby: document.getElementById("view-lobby"),
    question: document.getElementById("view-question"),
    podium: document.getElementById("view-podium")
};

const quizSearchInput = document.getElementById("quizSearchInput");
const quizResults = document.getElementById("quizResults");
const selectedQuizBadge = document.getElementById("selectedQuizBadge");
const selectedQuizTitle = document.getElementById("selectedQuizTitle");
const clearQuizBtn = document.getElementById("clearQuizBtn");
const modeSelect = document.getElementById("modeSelect");
const createBtn = document.getElementById("createBtn");
const createBtnWrapper = createBtn?.closest(".cta-wrapper");
const lobbyPin = document.getElementById("lobbyPin");
const playerCountEl = document.getElementById("playerCount");
const playerListEl = document.getElementById("playerList");
const startBtn = document.getElementById("startBtn");
const qTitle = document.getElementById("qTitle");
const qCounter = document.getElementById("qCounter");
const timerEl = document.getElementById("timer");
const optionsList = document.getElementById("optionsList");
const nextBtn = document.getElementById("nextBtn");
const answerStats = document.getElementById("answerStats");
const hostLivePinEl = document.getElementById("hostLivePin");
const hostLivePlayersEl = document.getElementById("hostLivePlayers");
const confettiCanvas = document.getElementById("confetti-canvas");

document.body.dataset.hostView = "setup";
document.querySelectorAll("[data-live-back]").forEach((button) => {
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleLiveQuizBackNavigation();
    });
});

let hostLoadingEl = null;

function showHostLoading(message = "Restoring host session...") {
    Object.values(views).forEach(v => {
        if (v) v.style.display = "none";
    });

    if (!hostLoadingEl) {
        hostLoadingEl = document.createElement("div");
        hostLoadingEl.id = "hostSessionLoading";
        hostLoadingEl.style.cssText = [
            "position:fixed",
            "inset:0",
            "z-index:9997",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "padding:24px",
            "background:rgba(7,5,31,0.66)",
            "backdrop-filter:blur(14px)",
            "color:white",
            "font-weight:800",
            "text-align:center"
        ].join(";");
        document.body.appendChild(hostLoadingEl);
    }

    hostLoadingEl.textContent = message;
    hostLoadingEl.style.display = "flex";
}

function hideHostLoading() {
    if (hostLoadingEl) hostLoadingEl.style.display = "none";
    // Also remove the transition overlay if present
    const overlay = document.getElementById("lobbyTransitionOverlay");
    if (overlay) overlay.style.display = "none";
}

// Creation/Tab Elements
const tabSelect = document.getElementById("tabSelect");
const tabCreate = document.getElementById("tabCreate");
const sectionSelect = document.getElementById("sectionSelect");
const sectionCreate = document.getElementById("sectionCreate");
const quizTitleInput = document.getElementById("quizTitleInput");
const creationModeSelect = document.getElementById("creationMode");
const creationMethodButtons = document.querySelectorAll("[data-creation-mode]");
const manualModeForm = document.getElementById("manualModeForm");
const importModeGuide = document.getElementById("importModeGuide");
const manualBuilderBody = document.getElementById("manualBuilderBody");
const manualQuestionsList = document.getElementById("manualQuestionsList");
const manualQuestionCount = document.getElementById("manualQuestionCount");
const addManualQuestionBtn = document.getElementById("addManualQuestionBtn");
const saveManualQuizBtn = document.getElementById("saveManualQuizBtn");
const manualSaveStatus = document.getElementById("manualSaveStatus");
const aiTopicInput = document.getElementById("aiTopicInput");
const aiQuestionCountInput = document.getElementById("aiQuestionCountInput");
const aiPromptText = document.getElementById("aiPromptText");
const copyAiPromptBtn = document.getElementById("copyAiPromptBtn");
const aiPromptStatus = document.getElementById("aiPromptStatus");
const openImporterBtn = document.getElementById("openImporterBtn");
const MANUAL_OPTION_COLORS = ["purple", "blue", "orange", "green"];
const CREATION_MODE_STORAGE_KEY = "edtechra.creationMode";
let manualQuestionKey = 0;
let savedManualQuizState = { id: "", signature: "" };

let setupStatusEl = null;
const createBtnDefaultHtml = createBtn?.innerHTML || "";

function getSetupStatusEl() {
    if (setupStatusEl) return setupStatusEl;
    const wrapper = createBtn?.closest(".cta-wrapper") || createBtn?.parentElement;
    if (!wrapper) return null;

    setupStatusEl = document.createElement("div");
    setupStatusEl.id = "hostSetupStatus";
    setupStatusEl.setAttribute("role", "status");
    setupStatusEl.style.cssText = "margin-top:12px;color:rgba(255,255,255,0.72);font-weight:700;text-align:center;";
    wrapper.appendChild(setupStatusEl);
    return setupStatusEl;
}

function setSetupStatus(message = "", type = "info") {
    const el = getSetupStatusEl();
    if (!el) return;
    el.textContent = message;
    el.style.display = message ? "block" : "none";
    el.style.color =
        type === "error" ? "#fca5a5" :
            type === "success" ? "#86efac" :
                "rgba(255,255,255,0.72)";
}

function setCreateButtonLoading(isLoading, label = "Initializing Game PIN...") {
    if (!createBtn) return;
    createBtn.disabled = isLoading || hasActiveLobby;
    createBtn.innerHTML = isLoading ? escapeHtml(label) : createBtnDefaultHtml;
    if (!isLoading && window.lucide) window.lucide.createIcons();
}

function setQuizResultsState(message, type = "info", options = {}) {
    if (!quizResults) return;
    const { show = true } = options;
    const color =
        type === "error" ? "#fca5a5" :
            type === "success" ? "#86efac" :
                "rgba(255,255,255,0.58)";

    quizResults.innerHTML = `
        <div class="quiz-result-item" style="opacity:1; cursor:default; color:${color};">
            ${escapeHtml(message)}
        </div>
    `;
    quizResults.style.display = show ? "block" : "none";
}

function getStoredCreationMode() {
    try {
        return localStorage.getItem(CREATION_MODE_STORAGE_KEY) || "manual";
    } catch {
        return "manual";
    }
}

function rememberCreationMode(mode) {
    try {
        localStorage.setItem(CREATION_MODE_STORAGE_KEY, mode);
    } catch {
        // Storage can be unavailable in stricter browser contexts.
    }
}

function setCreationMode(mode = "manual", options = {}) {
    const { persist = true } = options;
    const normalizedMode = mode === "ai" || mode === "import" ? "ai" : "manual";

    if (creationModeSelect) creationModeSelect.value = normalizedMode;
    if (manualModeForm) manualModeForm.style.display = normalizedMode === "manual" ? "flex" : "none";
    if (importModeGuide) importModeGuide.style.display = normalizedMode === "ai" ? "block" : "none";

    creationMethodButtons.forEach((btn) => {
        const active = btn.dataset.creationMode === normalizedMode;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", String(active));
    });

    if (normalizedMode === "ai") updateAiPrompt();
    if (persist) rememberCreationMode(normalizedMode);
}

function setBuilderStatus(el, message = "", type = "info") {
    if (!el) return;
    el.textContent = message;
    el.style.color =
        type === "error" ? "#fca5a5" :
            type === "success" ? "#86efac" :
                "rgba(255,255,255,0.58)";
}

function markManualDraftDirty() {
    savedManualQuizState = { id: "", signature: "" };
    setBuilderStatus(manualSaveStatus, "");
}

function createManualQuestionCard(values = {}) {
    const key = manualQuestionKey++;
    const card = document.createElement("section");
    card.className = "manual-question-card";
    card.dataset.questionKey = String(key);
    card.innerHTML = `
        <div class="manual-question-header">
            <span class="question-number-pill">Question</span>
            <button type="button" class="remove-manual-question-btn" aria-label="Remove question">
                <i data-lucide="trash-2" style="width:16px;height:16px"></i>
            </button>
        </div>
        <textarea class="modern-input manual-question-input" placeholder="Enter question text..."></textarea>
        <div class="options-header">
            <span>Answer Options</span>
            <span>Correct Answer</span>
        </div>
        <div class="manual-options-list">
            ${MANUAL_OPTION_COLORS.map((color, index) => `
                <div class="option-row" data-color="${color}">
                    <div class="opt-badge">${index + 1}</div>
                    <input type="text" class="modern-input manual-option-input" placeholder="Enter option ${index + 1}" />
                    <label class="correct-toggle" aria-label="Mark option ${index + 1} as correct">
                        <input type="radio" name="manual-correct-${key}" value="${index}" class="correct-radio" ${index === 0 ? "checked" : ""} />
                        <div class="toggle-circle">
                            <i data-lucide="check"></i>
                        </div>
                    </label>
                </div>
            `).join("")}
        </div>
    `;

    const questionInput = card.querySelector(".manual-question-input");
    const optionInputs = card.querySelectorAll(".manual-option-input");
    const correctRadios = card.querySelectorAll(".correct-radio");
    questionInput.value = values.question || "";
    optionInputs.forEach((input, index) => {
        input.value = values.options?.[index] || "";
    });
    const correctIndex = Number.isInteger(values.correctIndex) ? values.correctIndex : 0;
    if (correctRadios[correctIndex]) correctRadios[correctIndex].checked = true;

    card.querySelector(".remove-manual-question-btn")?.addEventListener("click", () => {
        const cards = manualQuestionsList?.querySelectorAll(".manual-question-card") || [];
        if (cards.length <= 1) return;
        card.remove();
        markManualDraftDirty();
        refreshManualQuestionNumbers();
    });

    return card;
}

function refreshManualQuestionNumbers() {
    const cards = Array.from(manualQuestionsList?.querySelectorAll(".manual-question-card") || []);
    cards.forEach((card, index) => {
        const label = card.querySelector(".question-number-pill");
        const removeBtn = card.querySelector(".remove-manual-question-btn");
        if (label) label.textContent = `Question ${index + 1}`;
        if (removeBtn) removeBtn.disabled = cards.length <= 1;
    });
    if (manualQuestionCount) {
        manualQuestionCount.textContent = `Questions: ${cards.length || 0}`;
    }
}

function addManualQuestion(values = {}, focusNew = false) {
    if (!manualQuestionsList) return null;
    const card = createManualQuestionCard(values);
    manualQuestionsList.appendChild(card);
    refreshManualQuestionNumbers();
    if (window.lucide) window.lucide.createIcons();

    if (focusNew) {
        requestAnimationFrame(() => {
            manualBuilderBody?.scrollTo({ top: manualBuilderBody.scrollHeight, behavior: "smooth" });
            card.querySelector(".manual-question-input")?.focus();
        });
    }

    return card;
}

function ensureManualBuilder() {
    if (manualQuestionsList && !manualQuestionsList.querySelector(".manual-question-card")) {
        addManualQuestion();
    }
}

function focusInvalidManualField(field) {
    if (!field) return;
    field.focus();
    field.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function collectManualQuizFromBuilder() {
    ensureManualBuilder();
    const title = quizTitleInput?.value.trim() || "";
    if (!title) {
        alert("Please enter a quiz title.");
        quizTitleInput?.focus();
        return null;
    }

    const cards = Array.from(manualQuestionsList?.querySelectorAll(".manual-question-card") || []);
    const questions = [];

    for (let index = 0; index < cards.length; index++) {
        const card = cards[index];
        const questionInput = card.querySelector(".manual-question-input");
        const optionInputs = Array.from(card.querySelectorAll(".manual-option-input"));
        const question = questionInput?.value.trim() || "";
        const options = optionInputs.map(input => input.value.trim());
        const correctIndex = Number(card.querySelector(".correct-radio:checked")?.value ?? 0);

        if (!question) {
            alert(`Please enter text for question ${index + 1}.`);
            focusInvalidManualField(questionInput);
            return null;
        }

        const firstEmptyOption = optionInputs.find(input => !input.value.trim());
        if (firstEmptyOption) {
            alert(`Please enter all 4 answer options for question ${index + 1}.`);
            focusInvalidManualField(firstEmptyOption);
            return null;
        }

        if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
            alert(`Please choose a correct answer for question ${index + 1}.`);
            card.querySelector(".correct-radio")?.focus();
            return null;
        }

        questions.push({ question, options, correctIndex });
    }

    if (questions.length === 0) {
        alert("Please add at least one question.");
        return null;
    }

    return { title, questions };
}

function getManualQuizSignature(quizData) {
    return JSON.stringify({
        title: quizData.title,
        questions: quizData.questions
    });
}

function addQuizToLocalCache(id, quizData) {
    allQuizzes = allQuizzes.filter(q => q.id !== id);
    allQuizzes.unshift({
        id,
        title: quizData.title || "Untitled",
        questions: quizData.questions || []
    });
}

async function saveManualQuizFromBuilder(options = {}) {
    const { showStatus = true } = options;
    const quizData = collectManualQuizFromBuilder();
    if (!quizData) return null;

    const signature = getManualQuizSignature(quizData);
    if (savedManualQuizState.id && savedManualQuizState.signature === signature) {
        if (showStatus) setBuilderStatus(manualSaveStatus, "Quiz already saved.", "success");
        return { id: savedManualQuizState.id, quizData, reused: true };
    }

    if (showStatus) setBuilderStatus(manualSaveStatus, "Saving quiz...");
    const docRef = await Fire.addDoc(collection(db, "quizzes"), {
        ...quizData,
        createdAt: TS()
    });

    savedManualQuizState = { id: docRef.id, signature };
    addQuizToLocalCache(docRef.id, quizData);
    selectQuiz({ id: docRef.id, ...quizData });
    if (showStatus) setBuilderStatus(manualSaveStatus, `Saved "${quizData.title}" with ${quizData.questions.length} question${quizData.questions.length === 1 ? "" : "s"}.`, "success");
    return { id: docRef.id, quizData, reused: false };
}

function buildAiPrompt() {
    const rawCount = parseInt(aiQuestionCountInput?.value || "10", 10);
    const count = Math.min(30, Math.max(1, Number.isFinite(rawCount) ? rawCount : 10));
    if (aiQuestionCountInput) aiQuestionCountInput.value = String(count);
    const topic = aiTopicInput?.value.trim() || "[Topic]";

    return [
        `Create a ${count}-question quiz about ${topic} in EdTechra Quiz Markup format.`,
        "Use exactly this structure:",
        "TITLE: Quiz Title",
        "Q: Question text?",
        "A: Option 1",
        "A: Option 2*",
        "A: Option 3",
        "A: Option 4",
        "",
        "Rules:",
        "- Include 4 answers for every question.",
        "- Mark the correct answer with one * at the end.",
        "- Do not add explanations or extra formatting."
    ].join("\n");
}

function updateAiPrompt() {
    if (aiPromptText) aiPromptText.value = buildAiPrompt();
}

async function copyAiPrompt() {
    updateAiPrompt();
    const prompt = aiPromptText?.value || "";
    try {
        await navigator.clipboard.writeText(prompt);
        setBuilderStatus(aiPromptStatus, "Prompt copied.", "success");
    } catch {
        aiPromptText?.focus();
        aiPromptText?.select();
        const copied = document.execCommand?.("copy");
        setBuilderStatus(aiPromptStatus, copied ? "Prompt copied." : "Select and copy the prompt.", copied ? "success" : "error");
    }
}

creationMethodButtons.forEach((btn) => {
    btn.addEventListener("click", () => setCreationMode(btn.dataset.creationMode || "manual"));
});

creationModeSelect?.addEventListener("change", () => setCreationMode(creationModeSelect.value));
addManualQuestionBtn?.addEventListener("click", () => {
    addManualQuestion({}, true);
    markManualDraftDirty();
});
saveManualQuizBtn?.addEventListener("click", async () => {
    saveManualQuizBtn.disabled = true;
    try {
        await saveManualQuizFromBuilder({ showStatus: true });
    } catch (error) {
        const message = showFirebaseError("Manual quiz save error", error);
        setBuilderStatus(manualSaveStatus, message, "error");
    } finally {
        saveManualQuizBtn.disabled = false;
    }
});
manualQuestionsList?.addEventListener("input", markManualDraftDirty);
manualQuestionsList?.addEventListener("change", markManualDraftDirty);
quizTitleInput?.addEventListener("input", markManualDraftDirty);
aiTopicInput?.addEventListener("input", updateAiPrompt);
aiQuestionCountInput?.addEventListener("input", updateAiPrompt);
copyAiPromptBtn?.addEventListener("click", copyAiPrompt);
openImporterBtn?.addEventListener("click", () => {
    console.info("[LiveQuiz][Host] Opening quiz importer");
    window.location.href = "./import.html";
});

ensureManualBuilder();
setCreationMode(getStoredCreationMode(), { persist: false });
updateAiPrompt();

// -- Confetti -------------------------------------------------------------------
let confettiParticles = [];
let confettiRAF = null;

function launchConfetti() {
    confettiCanvas.style.display = "block";
    const ctx = confettiCanvas.getContext("2d");
    confettiCanvas.width = window.innerWidth;
    confettiCanvas.height = window.innerHeight;

    const COLORS = ["#facc15", "#6366f1", "#ec4899", "#10b981", "#f97316", "#38bdf8", "#a78bfa"];
    confettiParticles = Array.from({ length: 180 }, () => ({
        x: Math.random() * confettiCanvas.width,
        y: Math.random() * -confettiCanvas.height,
        r: Math.random() * 10 + 5,
        d: Math.random() * 180,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        tilt: Math.random() * 10 - 10,
        tiltAngle: 0,
        tiltIncrement: Math.random() * 0.07 + 0.05,
        fall: Math.random() * 4 + 2
    }));

    // Play pop sound
    sounds.cheer.currentTime = 0;
    sounds.cheer.play().catch(() => { });
    sounds.podium.play().catch(() => { });

    function drawConfetti() {
        if (!confettiRAF) return; // Guard
        ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
        confettiParticles.forEach(p => {
            ctx.beginPath();
            ctx.save();
            ctx.translate(p.x + p.r, p.y + p.r);
            ctx.rotate(p.tiltAngle);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
            ctx.restore();

            p.tiltAngle += p.tiltIncrement;
            p.y += p.fall;
            p.tilt = Math.sin(p.tiltAngle) * 15;

            if (p.y > confettiCanvas.height) {
                p.y = -20;
                p.x = Math.random() * confettiCanvas.width;
            }
        });
        confettiRAF = requestAnimationFrame(drawConfetti);
    }
    confettiRAF = requestAnimationFrame(drawConfetti);

    // Stop after 8 seconds
    setTimeout(() => {
        cancelAnimationFrame(confettiRAF);
        ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
        confettiCanvas.style.display = "none";
    }, 8000);
}

// -- Quiz Search UI ------------------------------------------------------------
function renderQuizResults(filter = "") {
    if (!quizResults) return;
    const term = filter.toLowerCase().trim();
    const matches = term
        ? allQuizzes.filter(q => String(q.title || "").toLowerCase().includes(term))
        : allQuizzes;

    quizResults.innerHTML = "";
    if (matches.length === 0) {
        setQuizResultsState(term ? "No quizzes match your search." : "No saved quizzes yet. Create or import a quiz to get started.");
    } else {
        matches.forEach(q => {
            const div = document.createElement("div");
            div.className = "quiz-result-item";
            div.style.display = "flex";
            div.style.justifyContent = "space-between";
            div.style.alignItems = "center";
            div.innerHTML = `
                <div>
                    <div style="font-weight:700">${escapeHtml(q.title || "Untitled")}</div>
                    <div class="quiz-q-count">${q.questions.length} question${q.questions.length !== 1 ? "s" : ""}</div>
                </div>
                <button class="btn-small delete-quiz-btn" style="background:rgba(239, 68, 68, 0.2); border:1px solid rgba(239, 68, 68, 0.5); padding: 4px 8px;" title="Delete Quiz">Delete</button>
            `;
            // Click on item selects quiz (unless clicking delete)
            div.addEventListener("click", (e) => {
                if (!e.target.classList.contains("delete-quiz-btn")) {
                    selectQuiz(q);
                }
            });
            // Click delete button
            div.querySelector(".delete-quiz-btn").addEventListener("click", async (e) => {
                e.stopPropagation();
                if (confirm(`Are you sure you want to delete "${q.title}"?`)) {
                    try {
                        await deleteDoc(doc(db, "quizzes", q.id));
                        await loadQuizzes();
                        renderQuizResults(quizSearchInput?.value || "");
                    } catch (error) {
                        const message = showFirebaseError("Quiz delete failed", error);
                        setQuizResultsState(message, "error", { show: true });
                    }
                }
            });
            quizResults.appendChild(div);
        });
    }
    quizResults.style.display = "block";
}

function selectQuiz(q) {
    if (!q?.id) return;
    selectedQuizId = q.id;
    document.body.classList.add("setup-quiz-selected");
    document.body.classList.remove("setup-create-active");
    createBtnWrapper?.classList.remove("setup-cta-hidden");
    if (selectedQuizTitle) selectedQuizTitle.textContent = q.title || "Untitled";
    if (selectedQuizBadge) selectedQuizBadge.style.display = "flex";
    if (quizResults) quizResults.style.display = "none";
    if (quizSearchInput) quizSearchInput.value = "";
    setSetupStatus("");
}

function clearSelection() {
    selectedQuizId = null;
    document.body.classList.remove("setup-quiz-selected");
    createBtnWrapper?.classList.add("setup-cta-hidden");
    if (selectedQuizBadge) selectedQuizBadge.style.display = "none";
    if (quizSearchInput) quizSearchInput.value = "";
    if (quizResults) quizResults.style.display = "none";
    setSetupStatus("");
}

quizSearchInput?.addEventListener("input", () => {
    renderQuizResults(quizSearchInput.value);
});

quizSearchInput?.addEventListener("focus", () => {
    renderQuizResults(quizSearchInput.value);
});

document.addEventListener("click", (e) => {
    const searchWrap = document.querySelector(".quiz-search-wrap");
    if (searchWrap && !searchWrap.contains(e.target) && quizResults) {
        quizResults.style.display = "none";
    }
});

clearQuizBtn?.addEventListener("click", clearSelection);

// -- Leaderboard UI Helpers ----------------------------------------------------
function toggleLbFreeze() {
    lbFrozen = !lbFrozen;
    const btns = [document.getElementById("freezeLbBtn")];
    btns.forEach(btn => {
        if (btn) {
            btn.textContent = lbFrozen ? "Resume" : "Freeze";
            btn.classList.toggle("active", lbFrozen);
        }
    });
    if (lbFrozen) {
        if (lbUnsubscribe) lbUnsubscribe();
    } else {
        startLeaderboardListener();
    }
}

function toggleLbLimit() {
    lbLimit = (lbLimit === 10) ? 50 : 10;
    const btn = document.getElementById("toggleTopBtn");
    if (btn) {
        btn.textContent = lbLimit === 50 ? "Top 50" : "Top 10";
        btn.classList.toggle("active", lbLimit === 50);
    }
    if (!lbFrozen) startLeaderboardListener();
}

function renderLeaderboard(data) {
    renderPlayerList(data);
}

function renderPlayerList(data) {
    if (!playerListEl) return;
    playerListEl.innerHTML = "";

    if (data.length === 0) {
        playerListEl.innerHTML = `<p class="waiting-text">Waiting for players to join...</p>`;
        return;
    }

    data.slice(0, lbLimit).forEach((p, i) => {
        const rank = i + 1;
        const pill = document.createElement("div");
        pill.className = "player-pill";
        if (lastRanks[p.id]) {
            if (rank < lastRanks[p.id]) pill.classList.add("rank-up");
            else if (rank > lastRanks[p.id]) pill.classList.add("rank-down");
        }
        lastRanks[p.id] = rank;
        pill.textContent = p.name || "Student";
        playerListEl.appendChild(pill);
    });
}

function renderLobbyLog(data) {
    const logEl = document.getElementById("lobbyLog");
    if (!logEl || views.lobby.style.display === "none") return;

    if (!data || data.length === 0) {
        logEl.innerHTML = `
          <div class="empty-state" style="text-align: center; color: rgba(255,255,255,0.4); font-style: italic; margin-top: 20px;">
            Waiting for students to join...
          </div>
        `;
        return;
    }

    const joined = data.map(p => {
        const name = p.name || "Student";
        const initial = name.charAt(0).toUpperCase();
        return `
        <div class="log-item student-join-card" style="display: flex; align-items: center; gap: 12px; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 12px; margin-bottom: 8px; animation: fadeIn 0.3s ease;">
          <div class="student-avatar" style="width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #a855f7, #6366f1); display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 1.1rem; color: #fff; flex-shrink: 0;">
            ${escapeHtml(initial)}
          </div>
          <div class="log-info" style="flex: 1; min-width: 0;">
            <h6 style="margin: 0; font-size: 0.95rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(name)}</h6>
            <p style="margin: 0; font-size: 0.75rem; color: #22d3ee;">Joined the lobby</p>
          </div>
          <span class="log-time" style="font-size: 0.75rem; color: rgba(255,255,255,0.4); flex-shrink: 0;">Now</span>
        </div>
        `;
    }).join("");

    logEl.innerHTML = joined;

    if (window.lucide) window.lucide.createIcons();
}

function startLeaderboardListener() {
    if (lbUnsubscribe) lbUnsubscribe();
    if (playersUnsubscribe) playersUnsubscribe();
    if (!currentGameId) return;

    // Top list is lobby-only. It is intentionally stopped when gameplay starts.
    const qLb = query(
        collection(db, "games", currentGameId, "players"),
        orderBy("score", "desc"),
        Fire.limit(lbLimit)
    );
    lbUnsubscribe = onSnapshot(qLb, (snap) => {
        if (lbFrozen || views.lobby.style.display === "none") return;
        const lbData = [];
        snap.forEach(d => lbData.push({ id: d.id, ...d.data() }));
        renderLeaderboard(lbData);
        renderLobbyLog(lbData);

    }, (error) => {
        showFirebaseError("Leaderboard listener error", error);
    });

    // 2. Total Player Count (Unlimited - for logic checks)
    const totalQ = collection(db, "games", currentGameId, "players");
    playersUnsubscribe = onSnapshot(totalQ, (snap) => {
        players = {};
        snap.forEach(d => {
            players[d.id] = { id: d.id, ...d.data() };
        });
        playerCountEl.textContent = `${snap.size} Players Joined`;
        if (hostLivePlayersEl) hostLivePlayersEl.textContent = String(snap.size);
    }, (error) => {
        showFirebaseError("Players listener error", error);
    });
}

// -- Tab & Creation Logic ------------------------------------------------------
tabSelect?.addEventListener("click", () => {
    tabSelect.classList.add("active");
    tabCreate?.classList.remove("active");
    document.body.classList.remove("setup-create-active");
    if (!selectedQuizId) createBtnWrapper?.classList.add("setup-cta-hidden");
    if (sectionSelect) sectionSelect.style.display = "block";
    if (sectionCreate) sectionCreate.style.display = "none";
    clearSelection();
    setSetupStatus("");
});

tabCreate?.addEventListener("click", () => {
    tabCreate.classList.add("active");
    tabSelect?.classList.remove("active");
    document.body.classList.add("setup-create-active");
    createBtnWrapper?.classList.remove("setup-cta-hidden");
    if (sectionCreate) sectionCreate.style.display = "block";
    if (sectionSelect) sectionSelect.style.display = "none";
    clearSelection(); // Clear search selection if we're creating
    setSetupStatus("");
});

// -- Initialization ------------------------------------------------------------
async function init() {
    console.info("[LiveQuiz][Host] init start");

    if (isForceHomepageNavigation()) {
        clearForceHomepageNavigation();
        clearHostRouteSessionState();
        goHomeSafely();
        return;
    }

    // Initialize Lucide icons
    if (window.lucide) {
        window.lucide.createIcons();
    }

    // Leaderboard buttons
    document.getElementById("freezeLbBtn")?.addEventListener("click", toggleLbFreeze);
    document.getElementById("freezeGameLbBtn")?.addEventListener("click", toggleLbFreeze);
    document.getElementById("toggleTopBtn")?.addEventListener("click", toggleLbLimit);
    ensureResetSessionAction();

    const params = new URLSearchParams(window.location.search);
    let routeSessionId = params.get("sessionId") || params.get("gameId") || "";
    let routePin = params.get("pin") || "";
    let routeStart = params.get("start") || "";

    // Normal host.html opens must never restore from localStorage.
    // Only explicit ?sessionId=...&start=1 routes may restore gameplay.
    console.info("[LiveQuiz][Host] url params", {
        sessionId: routeSessionId,
        pin: routePin,
        start: routeStart,
        hash: window.location.hash || ""
    });

    const hasSessionRoute = routeStart === "1" && Boolean(routeSessionId);
    if (hasSessionRoute) {
        // Immediately hide setup so it never flashes
        if (views.setup) views.setup.style.display = "none";
        showHostLoading("Restoring host session...");

        try {
            const loadedGame = await loadGameSessionFromUrl(params);
            if (loadedGame) {
                hideHostLoading();
                return;
            }
        } catch (err) {
            console.error("[LiveQuiz][Host] Unhandled init error during session load", err);
        }

        // Session load failed; clear stale state and return home without a browser alert.
        showHostLoading("This live session has ended. Returning to EdTechra...");
        setHostFallbackReason(lastHostFallbackReason || "session route failed to restore; setup fallback suppressed", {
            sessionId: routeSessionId
        });

        clearHostRouteSessionState();
        window.setTimeout(goHomeSafely, 700);
        return;
    }

    // No session route — show the setup page
    // Clear any stale saved session (user intentionally opened setup)
    staleHostSessionForReset = loadHostSession();
    clearHostSession();

    try {
        await ensureAnonAuth();
        console.info("[LiveQuiz] Firebase auth ready before fetching quizzes");
        await loadQuizzes();
    } catch (error) {
        const message = showFirebaseError("Quiz load failed", error);
        setQuizResultsState(message, "error", { show: true });
        setSetupStatus("Saved quizzes could not be loaded. Check your Firebase connection and try again.", "error");
    }

    const loadedLobby = await loadLobbySessionFromUrl(params);
    if (loadedLobby) return;

    // If redirected from importer with a quizId, auto-select it
    const quizId = params.get("quizId");
    if (quizId) {
        const found = allQuizzes.find(q => q.id === quizId);
        if (found) selectQuiz(found);
    }

    logHostRenderBranch(HostRouteState.SETUP, { reason: "no active session route" });
}

async function loadQuizzes() {
    setQuizResultsState("Loading saved quizzes...", "info", { show: true });
    const snap = await getDocs(collection(db, "quizzes"));
    allQuizzes = [];
    snap.forEach(d => {
        const data = d.data();
        allQuizzes.push({
            id: d.id,
            title: data.title || "Untitled",
            questions: Array.isArray(data.questions) ? data.questions : []
        });
    });

    if (!allQuizzes.length) {
        setQuizResultsState("No saved quizzes yet. Create or import a quiz to get started.", "info", { show: true });
        return;
    }

    if (quizSearchInput && document.activeElement === quizSearchInput) {
        renderQuizResults(quizSearchInput.value);
    } else {
        const label = allQuizzes.length === 1 ? "quiz" : "quizzes";
        setQuizResultsState(`${allQuizzes.length} saved ${label} loaded. Search or click the field to choose one.`, "success", { show: true });
    }
}

// -- View Switching ------------------------------------------------------------
function showView(viewId) {
    // Hide ALL views including any loading overlays
    Object.values(views).forEach(v => { if (v) v.style.display = "none"; });
    hideHostLoading();
    document.body.dataset.hostView = viewId;

    if (views[viewId]) {
        views[viewId].style.display = "flex";
    }

    // Stop lobby music when entering any game phase
    if (viewId !== "setup" && viewId !== "lobby") {
        sounds.lobby.pause();
        sounds.lobby.currentTime = 0;
    }

    if (viewId === "lobby") {
        stopAllBg(); // Clear all including game music if we're back in lobby
        sounds.lobby.play().catch(() => { });
    }

    if (viewId === "question" && lbUnsubscribe) {
        lbUnsubscribe();
        lbUnsubscribe = null;
    }

    console.info("[LiveQuiz][Host] showView", viewId);
}

function enterLobbyView() {
    hasActiveLobby = true;
    console.info("[LiveQuiz][Host] Lobby render called — redirecting to dedicated lobby page", { sessionId: currentGameId, pin: currentPin });
    // Always redirect to the dedicated premium lobby page instead of inline fallback
    const lobbyTarget = buildLobbyUrl(currentGameId, currentPin);
    transitionToLobbyPage(lobbyTarget);
}

async function loadLobbySessionFromUrl(params) {
    const isLobbyRoute = window.location.hash === "#lobby";
    const sessionId = params.get("gameId") || params.get("sessionId");
    const pinFromUrl = params.get("pin");

    if (!isLobbyRoute || !sessionId) return false;

    console.info("[LiveQuiz] #lobby hash detected — redirecting to dedicated lobby page", { sessionId, pin: pinFromUrl || "" });

    try {
        // Validate the session exists before redirecting
        const gameSnap = await Fire.getDoc(doc(db, "games", sessionId));
        if (!gameSnap.exists()) {
            throw new Error("Host lobby session was not found in Firestore.");
        }

        const gameData = gameSnap.data();
        const sessionStatus = gameData.status || GameStatus.LOBBY;
        if (!isValidSessionStatus(sessionStatus) || isEndedSessionStatus(sessionStatus) || !gameData.quizId) {
            clearHostRouteSessionState();
            goHomeSafely();
            return true;
        }
        const pin = pinFromUrl || gameData.pin || "";

        console.info("[LiveQuiz] Lobby session validated, redirecting to host-lobby.html", {
            sessionId,
            pin,
            quizId: gameData.quizId || ""
        });

        // Always redirect to the dedicated premium lobby page
        hasActiveLobby = true;
        const lobbyTarget = buildLobbyUrl(sessionId, pin);
        await transitionToLobbyPage(lobbyTarget);
        logHostRenderBranch(HostRouteState.LOBBY, { sessionId, status: sessionStatus });
        return true;
    } catch (error) {
        const message = showFirebaseError("Lobby session read failure", error);
        setHostFallbackReason(message, { sessionId, route: "lobby" });
        clearHostRouteSessionState();
        goHomeSafely();
        return false;
    }
}

async function recoverActiveQuestionFromFirestore(sessionId, context, originalError) {
    showFirebaseError(context, originalError);

    try {
        const latestSnap = await Fire.getDoc(doc(db, "games", sessionId));
        if (!latestSnap.exists()) return false;

        const latestData = latestSnap.data();
        const latestStatus = latestData.status || GameStatus.LOBBY;
        const latestQIndex = getSessionQuestionIndex(latestData);

        console.info("[LiveQuiz][Host] firebase session loaded", {
            sessionId,
            status: latestStatus,
            qIndex: latestQIndex,
            recovery: true
        });
        console.info("[LiveQuiz][Host] hostMode", latestData.hostMode || currentQuiz?.hostMode || "");
        console.info("[LiveQuiz][Host] gameStarted", isLiveSessionStatus(latestStatus) || latestStatus === GameStatus.FINISHED);
        console.info("[LiveQuiz][Host] currentQuestionIndex", latestQIndex);
        console.info("[LiveQuiz][Host] session phase", latestStatus);

        if (isLiveSessionStatus(latestStatus) && latestQIndex >= 0) {
            currentPin = currentPin || latestData.pin || "";
            currentQuiz.currentQIndex = latestQIndex;
            logHostRenderBranch(HostRouteState.LIVE_QUESTION, {
                sessionId,
                status: latestStatus,
                qIndex: latestQIndex,
                reason: "recovered active session after start failure"
            });
            renderActiveQuestionFromSession(latestData);
            return true;
        }
    } catch (recoveryError) {
        showFirebaseError("Host active session recovery failed", recoveryError);
    }

    return false;
}

async function startLiveQuestionFromRoute(sessionId) {
    currentQuiz.currentQIndex = -1;

    try {
        await goToNextQuestion();
        return true;
    } catch (error) {
        const recovered = await recoverActiveQuestionFromFirestore(
            sessionId,
            "Host live question start failed",
            error
        );

        if (recovered) return true;
        throw error;
    }
}

async function loadGameSessionFromUrl(params) {
    const shouldStart = params.get("start") === "1";
    const sessionId = params.get("sessionId") || params.get("gameId");

    if (!sessionId) return false;
    if (!shouldStart) {
        console.info("[LiveQuiz][Host] Ignoring session route without start=1", { sessionId });
        clearHostSession();
        return false;
    }

    console.info("[LiveQuiz] Host session route detected", {
        sessionId,
        shouldStart,
        hash: window.location.hash || ""
    });

    try {
        const hostUser = await ensureAnonAuth();
        const gameSnap = await Fire.getDoc(doc(db, "games", sessionId));
        if (!gameSnap.exists()) {
            throw new Error("Host game session was not found in Firestore.");
        }

        const gameData = gameSnap.data();
        const sessionStatus = gameData.status || GameStatus.LOBBY;
        if (!isValidSessionStatus(sessionStatus)) {
            clearHostSession();
            throw new Error(`Host game session has invalid status: ${sessionStatus}.`);
        }
        if (isEndedSessionStatus(sessionStatus)) {
            clearHostSession();
            throw new Error(`Host game session is ${sessionStatus}.`);
        }
        if (!gameData.quizId) {
            clearHostSession();
            throw new Error("Host game session is missing quiz data.");
        }

        const routePin = params.get("pin") || "";
        if (routePin) {
            const pinSnap = await Fire.getDoc(doc(db, "pins", routePin));
            if (!pinSnap.exists() || pinSnap.data().gameId !== sessionId) {
                clearHostSession();
                throw new Error("Host game PIN is stale or does not match this session.");
            }
        }

        console.info("[LiveQuiz][Host] firebase session loaded", {
            sessionId,
            status: sessionStatus,
            qIndex: getSessionQuestionIndex(gameData),
            quizId: gameData.quizId || "",
            pin: gameData.pin || ""
        });

        const quizSnap = await Fire.getDoc(doc(db, "quizzes", gameData.quizId));
        if (!quizSnap.exists()) {
            throw new Error("Session quiz was not found in Firestore.");
        }

        currentGameId = sessionId;
        currentPin = params.get("pin") || gameData.pin || "";
        currentQuiz = quizSnap.data();
        currentQuiz.id = gameData.quizId;
        currentQuiz.gameMode = gameData.gameMode;
        currentQuiz.hostMode = gameData.hostMode;

        // Persist session to localStorage so we can recover on refresh/reload
        saveHostSession(sessionId, currentPin, gameData.quizId);

        if (modeSelect && gameData.gameMode) modeSelect.value = gameData.gameMode;
        const hostModeSelect = document.getElementById("hostModeSelect");
        if (hostModeSelect && gameData.hostMode) hostModeSelect.value = gameData.hostMode;

        const sessionQIndex = getSessionQuestionIndex(gameData);
        const gameStarted = shouldStart || isLiveSessionStatus(sessionStatus) || sessionStatus === GameStatus.FINISHED || sessionQIndex >= 0;

        console.info("[LiveQuiz][Host] hostMode", gameData.hostMode || currentQuiz.hostMode || "");
        console.info("[LiveQuiz][Host] gameStarted", gameStarted);
        console.info("[LiveQuiz][Host] currentQuestionIndex", sessionQIndex);
        console.info("[LiveQuiz][Host] session phase", sessionStatus);

        console.info("[LiveQuiz] Host game session read success", {
            sessionId,
            pin: gameData.pin || "",
            quizId: gameData.quizId || "",
            hostUid: hostUser.uid,
            hostMode: gameData.hostMode || "",
            status: sessionStatus,
            qIndex: sessionQIndex,
            shouldStart
        });

        startLeaderboardListener();

        if (sessionStatus === GameStatus.FINISHED) {
            logHostRenderBranch(HostRouteState.FINISHED, { sessionId, status: sessionStatus });
            console.info("[LiveQuiz] Host render branch", { state: HostRouteState.FINISHED, sessionId });
            replaceHostUrl(buildGameUrl(sessionId, currentPin), {
                sessionId,
                pin: currentPin,
                state: HostRouteState.FINISHED
            });
            await showPodium();
            return true;
        }

        if (isLiveSessionStatus(sessionStatus)) {
            startQuizAmbience();
            logHostRenderBranch(HostRouteState.LIVE_QUESTION, {
                sessionId,
                status: sessionStatus,
                qIndex: sessionQIndex
            });
            console.info("[LiveQuiz] Host render branch", {
                state: HostRouteState.LIVE_QUESTION,
                sessionId,
                status: sessionStatus,
                qIndex: sessionQIndex
            });

            replaceHostUrl(buildGameUrl(sessionId, currentPin), {
                sessionId,
                pin: currentPin,
                state: HostRouteState.LIVE_QUESTION
            });

            if (sessionQIndex < 0) {
                console.warn("[LiveQuiz] Active session missing qIndex; starting first question", {
                    sessionId,
                    status: sessionStatus
                });
                await startLiveQuestionFromRoute(sessionId);
            } else {
                currentQuiz.currentQIndex = sessionQIndex;
                renderActiveQuestionFromSession(gameData);
            }
            return true;
        }

        if (shouldStart) {
            startQuizAmbience();
            logHostRenderBranch(HostRouteState.LIVE_QUESTION, {
                sessionId,
                status: sessionStatus,
                qIndex: sessionQIndex,
                reason: "start=1 route"
            });
            console.info("[LiveQuiz] Host render branch", {
                state: HostRouteState.LIVE_QUESTION,
                sessionId,
                status: sessionStatus,
                qIndex: sessionQIndex
            });
            replaceHostUrl(buildGameUrl(sessionId, currentPin), {
                sessionId,
                pin: currentPin,
                state: HostRouteState.LIVE_QUESTION
            });
            await startLiveQuestionFromRoute(sessionId);
            return true;
        }

        logHostRenderBranch(HostRouteState.LOBBY, {
            sessionId,
            status: sessionStatus,
            qIndex: sessionQIndex
        });
        console.info("[LiveQuiz] Host render branch", {
            state: HostRouteState.LOBBY,
            sessionId,
            status: sessionStatus,
            qIndex: sessionQIndex
        });
        await transitionToLobbyPage(buildLobbyUrl(sessionId, currentPin));
        return true;
    } catch (error) {
        const message = showFirebaseError("Host game session read failure", error);
        setHostFallbackReason(message, {
            sessionId,
            start: shouldStart,
            hash: window.location.hash || ""
        });
        clearHostSession();
        return false;
    }
}

// -- 1. Setup Phase ------------------------------------------------------------
createBtn?.addEventListener("click", async () => {
    console.info("[LiveQuiz][Host] Initialize button clicked");
    if (isCreatingGame) {
        console.warn("[LiveQuiz][Host] Initialize aborted because: session creation already in progress");
        return;
    }
    if (hasActiveLobby) {
        console.warn("[LiveQuiz][Host] Initialize aborted because: lobby is already active");
        return;
    }
    const isSelectTabActive = tabSelect?.classList.contains("active") ?? true;
    const isCreateTabActive = tabCreate?.classList.contains("active") ?? false;

    if (isSelectTabActive && !selectedQuizId) {
        console.warn("[LiveQuiz][Host] Initialize aborted because: no quiz selected");
        setSetupStatus("Please select a quiz before initializing a Game PIN.", "error");
        setQuizResultsState("Select a saved quiz from this list before creating a PIN.", "error", { show: true });
        quizSearchInput?.focus();
        return;
    }

    isCreatingGame = true;
    setCreateButtonLoading(true);
    setSetupStatus("Checking quiz and creating your live session...");

    try {
        const hostUser = await ensureAnonAuth();
        let quizIdToStart = selectedQuizId;

        // Handle Manual Creation
        if (isCreateTabActive && creationModeSelect?.value === "manual") {
            setSetupStatus("Saving your manual quiz before creating the PIN...");
            const savedManualQuiz = await saveManualQuizFromBuilder({ showStatus: true });
            if (!savedManualQuiz) {
                console.warn("[LiveQuiz][Host] Initialize aborted because: manual quiz fields are incomplete");
                setSetupStatus("Finish the manual quiz fields before creating a PIN.", "error");
                return;
            }
            quizIdToStart = savedManualQuiz.id;
        }

        if (!quizIdToStart) {
            console.warn("[LiveQuiz][Host] Initialize aborted because: no quiz selected or created");
            setSetupStatus("Please select or create a quiz first.", "error");
            return;
        }

        setSetupStatus("Verifying selected quiz...");
        const quizSnap = await Fire.getDoc(doc(db, "quizzes", quizIdToStart));
        if (!quizSnap.exists()) {
            throw new Error("Selected quiz was not found in Firestore.");
        }

        currentQuiz = quizSnap.data();
        currentQuiz.id = quizIdToStart;
        if (!Array.isArray(currentQuiz.questions) || currentQuiz.questions.length === 0) {
            throw new Error("Selected quiz has no questions.");
        }

        const gameMode = modeSelect?.value || "classic";
        const hostMode = document.getElementById("hostModeSelect")?.value || "classroom";
        console.info("[LiveQuiz][Host] Validation passed", { quizId: quizIdToStart, hostMode, gameMode });
        setSetupStatus("Generating a unique Game PIN...");
        const { pin, pinRef } = await generateUniquePin();
        console.info("[LiveQuiz][Host] PIN generated", { pin });
        currentPin = pin;
        currentGameId = createGameId();
        const gameRef = doc(db, "games", currentGameId);
        const sessionData = {
            pin,
            status: GameStatus.LOBBY,
            quizId: quizIdToStart,
            gameMode,
            hostMode,
            qIndex: -1,
            hostUid: hostUser.uid,
            createdAt: TS(),
            correctAnswerIndex: -1
        };

        console.info("[LiveQuiz][Host] Session write started", { gameId: currentGameId, pin });
        setSetupStatus("Creating the live lobby...");
        await setDoc(gameRef, sessionData);
        await setDoc(pinRef, { gameId: currentGameId });
        console.info("[LiveQuiz][Host] Session write success", { gameId: currentGameId, pin });

        // Persist to localStorage for recovery
        saveHostSession(currentGameId, pin, quizIdToStart);

        const redirectTarget = buildLobbyUrl(currentGameId, pin);
        console.info("[LiveQuiz][Host] Redirect target", {
            target: redirectTarget,
            sessionId: currentGameId,
            pin
        });
        console.info("[LiveQuiz][Host] Transitioning to lobby", { sessionId: currentGameId, pin });
        try {
            hasActiveLobby = true;
            setSetupStatus("Game PIN created. Opening the host lobby...", "success");
            setCreateButtonLoading(true, "Opening Lobby...");
            await transitionToLobbyPage(redirectTarget);
            return;
        } catch (transitionError) {
            console.error("[LiveQuiz][Host] Transition failed — retrying direct navigation", transitionError);
            // Fallback: try a direct window.location redirect to the lobby page
            try {
                window.location.href = redirectTarget;
            } catch (navError) {
                console.error("[LiveQuiz][Host] Direct navigation also failed", navError);
                // Last resort: open in a new tab
                window.open(redirectTarget, "_self");
            }
        }
    } catch (error) {
        const message = showFirebaseError("Session write error", error);
        currentGameId = null;
        hasActiveLobby = false;
        setSetupStatus(message, "error");
        alert(`Could not initialize Game PIN.\n\n${message}`);
    } finally {
        isCreatingGame = false;
        setCreateButtonLoading(false);
        if (hasActiveLobby && createBtn) createBtn.disabled = true;
    }
});

// Removed old listenToPlayers as it's merged into startLeaderboardListener

startBtn?.addEventListener("click", async () => {
    if (Object.keys(players).length === 0) return alert("Wait for players!");
    await enterFullscreen();
    console.info("[LiveQuiz][Host] hostMode", document.getElementById("hostModeSelect")?.value || currentQuiz?.hostMode || "");
    console.info("[LiveQuiz][Host] gameStarted", true);
    console.info("[LiveQuiz][Host] currentQuestionIndex", currentQuiz?.currentQIndex ?? -1);
    console.info("[LiveQuiz][Host] session phase", GameStatus.QUESTION);
    logHostRenderBranch(HostRouteState.LIVE_QUESTION, {
        sessionId: currentGameId,
        pin: currentPin,
        reason: "Start Game button"
    });
    replaceHostUrl(buildGameUrl(currentGameId, currentPin), {
        sessionId: currentGameId,
        pin: currentPin,
        state: HostRouteState.LIVE_QUESTION
    });
    console.info("[LiveQuiz] Host state transition", {
        from: HostRouteState.LOBBY,
        to: HostRouteState.LIVE_QUESTION,
        sessionId: currentGameId,
        hostMode: document.getElementById("hostModeSelect")?.value || "classroom"
    });
    // Start ambience here inside a user gesture so autoplay is allowed.
    startQuizAmbience({ alternate: true });
    try {
        await goToNextQuestion();
    } catch (error) {
        const recovered = await recoverActiveQuestionFromFirestore(
            currentGameId,
            "Host start button live question failed",
            error
        );
        if (!recovered) {
            setHostFallbackReason("Start Game failed before an active question could be restored", {
                sessionId: currentGameId
            });
            alert("Could not keep the host screen on the live question. Check the console for details.");
        }
    }
});

// -- 3. Question Phase ----------------------------------------------------------
function getQuestionDuration() {
    let duration = 20;
    const mode = modeSelect?.value || currentQuiz?.gameMode;
    if (mode === "speed") duration = 10;
    if (mode === "normal") duration = 30;
    if (mode === "survival") duration = 60;
    return duration;
}

function applyRevealStyles(correctIndex) {
    const items = optionsList.children;
    for (let i = 0; i < items.length; i++) {
        if (i !== correctIndex) {
            items[i].style.opacity = "0.3";
        } else {
            items[i].style.opacity = "1";
            items[i].style.transform = "scale(1.05)";
            items[i].style.boxShadow = "0 0 30px var(--accent-success)";
            items[i].style.border = "3px solid #10b981";
        }
    }
}

function startTimerFromSession(gameData) {
    const duration = Number(gameData.questionDurationSec) || getQuestionDuration();
    const startMs = Number(gameData.questionStartMs) || Date.now();
    const endMs = startMs + (duration * 1000);

    if (timerInterval) clearInterval(timerInterval);

    const tick = () => {
        const left = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
        timerEl.textContent = left;

        if (left <= 0) {
            clearInterval(timerInterval);
            if (!isRevealing) revealAnswer();
        }
    };

    tick();
    timerInterval = setInterval(tick, 1000);
}

function renderActiveQuestionFromSession(gameData) {
    const sessionQIndex = getSessionQuestionIndex(gameData);
    const qIndex = sessionQIndex >= 0 ? sessionQIndex : currentQuiz.currentQIndex;
    const q = currentQuiz.questions[qIndex];
    if (!q) {
        console.warn("[LiveQuiz] Cannot render active question; index out of range", {
            sessionId: currentGameId,
            qIndex,
            total: currentQuiz.questions.length
        });
        return;
    }

    isRevealing = gameData.status === GameStatus.REVEAL;
    if (timerInterval) clearInterval(timerInterval);
    if (answersUnsub) {
        answersUnsub();
        answersUnsub = null;
    }
    clearTimeout(window._autoAdvanceTimer);

        showView("question");
        if (hostLivePinEl) hostLivePinEl.textContent = currentPin || gameData.pin || "---";
        qTitle.textContent = cleanText(q.question);
        qCounter.textContent = `Question ${qIndex + 1} of ${currentQuiz.questions.length}`;
        renderOptions(q.options);

    console.info("[LiveQuiz] Render active host question", {
        sessionId: currentGameId,
        hostMode: gameData.hostMode || currentQuiz.hostMode || "",
        status: gameData.status,
        qIndex,
        questionDurationSec: gameData.questionDurationSec || getQuestionDuration()
    });

    if (gameData.status === GameStatus.REVEAL) {
        answerStats.style.display = "none";
        nextBtn.style.display = "block";
        applyRevealStyles(Number(gameData.correctAnswerIndex));
        return;
    }

    nextBtn.style.display = "none";
    answerStats.style.display = "block";
    startTimerFromSession(gameData);
    listenToAnswers(qIndex);
}

async function goToNextQuestion() {
    isRevealing = false;
    if (timerInterval) clearInterval(timerInterval);
    if (answersUnsub) {
        answersUnsub();
        answersUnsub = null;
    }
    clearTimeout(window._autoAdvanceTimer);

    const nextIndex = (currentQuiz.currentQIndex ?? -1) + 1;
    currentQuiz.currentQIndex = nextIndex;

    if (nextIndex >= currentQuiz.questions.length) {
        return showPodium();
    }

    showView("question");
    if (hostLivePinEl) hostLivePinEl.textContent = currentPin || "---";
    nextBtn.style.display = "none";
    answerStats.style.display = "block";

    const q = currentQuiz.questions[nextIndex];
    qTitle.textContent = cleanText(q.question);
    qCounter.textContent = `Question ${nextIndex + 1} of ${currentQuiz.questions.length}`;

    const duration = getQuestionDuration();

    await updateDoc(doc(db, "games", currentGameId), {
        status: GameStatus.QUESTION,
        qIndex: nextIndex,
        questionStartMs: Date.now(),
        questionDurationSec: duration,
        correctAnswerIndex: -1
    });

    renderOptions(q.options);
    startTimer(duration);
    listenToAnswers(nextIndex);
}

function renderOptions(options) {
    optionsList.innerHTML = "";
    const colors = ["purple", "blue", "orange", "green"];
    options.forEach((opt, i) => {
        const div = document.createElement("div");
        div.className = `glass-card flex-center live-answer-card answer-${colors[i % 4]}`;
        div.innerHTML = `
            <span class="live-answer-number">${i + 1}</span>
            <span class="live-answer-text">${escapeHtml(cleanText(opt))}</span>
            <span class="live-answer-dot" aria-hidden="true"></span>
        `;
        optionsList.appendChild(div);
    });
}

function startTimer(sec) {
    let left = sec;
    timerEl.textContent = left;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        left--;
        timerEl.textContent = left;
        if (left <= 5 && left > 0) sounds.tick.play().catch(() => { });
        if (left <= 0) {
            clearInterval(timerInterval);
            if (!isRevealing) revealAnswer();
        }
    }, 1000);
}

function listenToAnswers(qIndex) {
    const answersRef = collection(db, "games", currentGameId, "answers");
    const q = Fire.query(answersRef, Fire.where("qIndex", "==", qIndex));
    answersUnsub = onSnapshot(q, (snap) => {
        const count = snap.size;
        const total = Object.keys(players).length;
        answerStats.textContent = `${count} / ${total} Answered`;
        if (count >= total && total > 0) {
            if (!isRevealing) revealAnswer();
        }
    });
}

async function revealAnswer() {
    if (isRevealing) return;
    isRevealing = true;
    if (timerInterval) clearInterval(timerInterval);
    if (answersUnsub) {
        answersUnsub();
        answersUnsub = null;
    }

    sounds.correct.play().catch(() => { });
    const qIndex = currentQuiz.currentQIndex;
    const q = currentQuiz.questions[qIndex];
    const gameRef = doc(db, "games", currentGameId);
    const gameSnap = await Fire.getDoc(gameRef);
    const gameData = gameSnap.data();

    const batch = writeBatch(db);
    const answersSnap = await getDocs(collection(db, "games", currentGameId, "answers"));
    const currentAnswers = answersSnap.docs.filter(d => d.id.endsWith(`_${qIndex}`));

    currentAnswers.forEach(ansDoc => {
        const ans = ansDoc.data();
        if (ans.index === q.correctIndex) {
            const points = calculatePoints(ans.clientTimeMs, gameData.questionStartMs, gameData.questionDurationSec);
            const playerRef = doc(db, "games", currentGameId, "players", ans.uid);
            batch.update(playerRef, { score: Fire.increment(points), lastEarned: points });
        } else {
            const playerRef = doc(db, "games", currentGameId, "players", ans.uid);
            batch.update(playerRef, { lastEarned: 0 });
        }
    });

    batch.update(gameRef, { status: GameStatus.REVEAL, correctAnswerIndex: q.correctIndex });
    await batch.commit();

    answerStats.style.display = "none";
    applyRevealStyles(q.correctIndex);
    // Show Next button but also auto-advance after 4 seconds
    nextBtn.style.display = "block";
    clearTimeout(window._autoAdvanceTimer);
    window._autoAdvanceTimer = setTimeout(() => goToNextQuestion(), 4000);
}

nextBtn?.addEventListener("click", () => {
    clearTimeout(window._autoAdvanceTimer);
    goToNextQuestion();
});

// -- 4. Podium Phase — Cinematic Camera Zoom ----------------------------------
async function buildFinalAnswerStatsByStudentId() {
    const stats = {};
    const totalQuestions = Array.isArray(currentQuiz?.questions) ? currentQuiz.questions.length : 0;

    if (!currentGameId || !totalQuestions) return stats;

    const answersSnap = await getDocs(collection(db, "games", currentGameId, "answers"));
    answersSnap.forEach((answerDoc) => {
        const answer = answerDoc.data();
        const uid = answer.uid;
        const qIndex = Number(answer.qIndex);
        const question = currentQuiz.questions[qIndex];
        if (!uid || !question) return;

        if (!stats[uid]) {
            stats[uid] = { correctCount: 0, wrongCount: 0, accuracy: 0 };
        }

        if (Number(answer.index) === Number(question.correctIndex)) {
            stats[uid].correctCount += 1;
        }
    });

    Object.values(stats).forEach((studentStats) => {
        studentStats.wrongCount = Math.max(0, totalQuestions - studentStats.correctCount);
        studentStats.accuracy = totalQuestions > 0
            ? Math.round((studentStats.correctCount / totalQuestions) * 100)
            : 0;
    });

    return stats;
}

async function showPodium() {
    await updateDoc(doc(db, "games", currentGameId), { status: GameStatus.FINISHED });

    // Game is over — clear the saved host session
    clearHostSession();

    const pSnap = await getDocs(query(collection(db, "games", currentGameId, "players"), orderBy("score", "desc")));
    const leaderboard = [];
    pSnap.forEach(d => leaderboard.push({ id: d.id, ...d.data() }));
    const finalStatsByStudentId = await buildFinalAnswerStatsByStudentId();
    const totalQuestions = Array.isArray(currentQuiz?.questions) ? currentQuiz.questions.length : 0;
    leaderboard.forEach((student) => {
        if (!finalStatsByStudentId[student.id]) {
            finalStatsByStudentId[student.id] = {
                correctCount: 0,
                wrongCount: totalQuestions,
                accuracy: 0
            };
        }
    });
    await syncFinalScoresToEdectra({
        gameId: currentGameId,
        pin: currentPin,
        leaderboard,
        totalQuestions,
        statsByStudentId: finalStatsByStudentId
    });

    stopAllBg(false);
    clearQuizAmbienceState();
    showView("podium");

    const stage = document.getElementById("podiumStage");
    const podiumTitle = document.getElementById("podiumTitle");
    const spots = [
        document.querySelector("#podium-1"),
        document.querySelector("#podium-2"),
        document.querySelector("#podium-3")
    ];

    // Reset initial state
    if (podiumTitle) podiumTitle.style.opacity = "0";
    stage.className = "podium-stage";
    spots.forEach((s, i) => {
        if (s) {
            s.style.opacity = "0";
            s.classList.remove("reveal", "spotlight");
            if (leaderboard[i]) {
                s.querySelector(".name").textContent = leaderboard[i].name;
                s.querySelector(".score").textContent = `${leaderboard[i].score.toLocaleString()} pts`;
            }
        }
    });

    renderHostFinalLeaderboard(leaderboard);

    // === STEP 1: Zoom into 3rd place ===
    setTimeout(() => {
        stage.classList.add("zoom-3rd");
        setTimeout(() => {
            if (spots[2]) {
                spots[2].classList.add("reveal", "spotlight");
            }
        }, 400);

        // === STEP 2: Pan to 2nd place ===
        setTimeout(() => {
            if (spots[2]) spots[2].classList.remove("spotlight");
            stage.classList.remove("zoom-3rd");
            stage.classList.add("zoom-2nd");
            setTimeout(() => {
                if (spots[1]) {
                    spots[1].classList.add("reveal", "spotlight");
                }
            }, 400);

            // === STEP 3: Dramatic zoom to 1st place ===
            setTimeout(() => {
                if (spots[1]) spots[1].classList.remove("spotlight");
                stage.classList.remove("zoom-2nd");
                stage.classList.add("zoom-1st");
                setTimeout(() => {
                    if (spots[0]) {
                        spots[0].classList.add("reveal", "spotlight");
                        // Show crown icon
                        const crown = spots[0].querySelector(".crown-icon");
                        if (crown) crown.style.display = "block";
                    }
                    sounds.podium.play().catch(() => { });
                    launchConfetti();
                }, 400);

                // === STEP 4: Zoom out to reveal all, show title ===
                setTimeout(() => {
                    if (spots[0]) spots[0].classList.remove("spotlight");
                    stage.classList.remove("zoom-1st");
                    stage.classList.add("zoom-out");
                    if (podiumTitle) podiumTitle.style.opacity = "1";
                }, 3000);
            }, 2500);
        }, 2500);
    }, 500);
}

function renderHostFinalLeaderboard(leaderboard) {
    const rowsEl = document.getElementById("podiumRows");
    if (!rowsEl) return;

    rowsEl.innerHTML = leaderboard.slice(3, 10).map((p, idx) => `
        <div class="podium-row">
          <span class="rank">#${idx + 4}</span>
          <span class="name">${escapeHtml(p.name || "Student")}</span>
          <span class="score">${(p.score || 0).toLocaleString()}</span>
        </div>
    `).join("");

    if (leaderboard.length <= 3) {
        rowsEl.innerHTML = `<div class="podium-row"><span class="rank">Top 3</span><span class="name">Full leaderboard ready</span><span class="score">${leaderboard.length}</span></div>`;
    }
}

bindExitFullscreenButtons();

init();

// -- Initialize Icons -----------------------------------------------------------
if (typeof lucide !== 'undefined') {
    lucide.createIcons();
}
// -- Lobby Button Listeners ----------------------------------------------------
document.getElementById('copyPinBtn')?.addEventListener('click', () => {
    const pinDigits = Array.from(document.querySelectorAll('#lobbyPin .digit-box')).map(el => el.textContent).join('');
    if (pinDigits) {
        navigator.clipboard.writeText(pinDigits).then(() => {
            const btn = document.getElementById('copyPinBtn');
            const originalText = btn.innerHTML;
            btn.innerHTML = `<i data-lucide="check" style="width:16px;height:16px;"></i> Copied!`;
            lucide.createIcons();
            setTimeout(() => {
                btn.innerHTML = originalText;
                lucide.createIcons();
            }, 2000);
        });
    }
});

document.getElementById('waShareBtn')?.addEventListener('click', () => {
    const pinDigits = Array.from(document.querySelectorAll('#lobbyPin .digit-box')).map(el => el.textContent).join('');
    const value = pinDigits || currentPin;
    if (!value) return;

    const joinUrl = new URL("./join.html", window.location.href);
    const text = `Join my EdTechra live quiz at ${joinUrl.href} with PIN ${value}.`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
});

document.getElementById('clearLogBtn')?.addEventListener('click', () => {
    const logList = document.getElementById('lobbyLog');
    if (logList) {
        logList.innerHTML = `<div style="text-align:center; padding:20px; color:rgba(255,255,255,0.2); font-style:italic;">Log cleared</div>`;
    }
});
