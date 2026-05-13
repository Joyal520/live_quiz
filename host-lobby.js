import { db, ensureAnonAuth, TS, Fire } from "./firebase.js";
import { bindExitFullscreenButtons, enterFullscreen } from "./fullscreen.js";
import { clearForceHomepageNavigation, goHomeSafely, isForceHomepageNavigation } from "./navigation.js";

const { doc, getDoc, collection, onSnapshot, updateDoc, deleteDoc } = Fire;

const params = new URLSearchParams(window.location.search);
let sessionId = params.get("sessionId") || params.get("gameId") || "";
let pin = params.get("pin") || "";
let playerLimit = 10;
let isFrozen = false;
let latestPlayers = [];
let seenPlayerIds = new Set();
let hasSeenInitialPlayers = false;
let studentJoinOrder = [];
let observedJoinTimes = new Map();
let currentQuizId = "";

const HOST_SESSION_KEY = "edtechra.hostSession";
const LAST_AMBIENCE_KEY = "lastQuizAmbience";
const CURRENT_AMBIENCE_KEY = "currentQuizAmbience";
const PENDING_AMBIENCE_KEY = "pendingQuizAmbience";

function saveHostSession(sessionId, pin, quizId) {
    try {
        localStorage.setItem(HOST_SESSION_KEY, JSON.stringify({
            sessionId,
            pin,
            quizId,
            savedAt: Date.now()
        }));
    } catch { /* ignore */ }
}

function clearHostSession() {
    try {
        localStorage.removeItem(HOST_SESSION_KEY);
    } catch { /* ignore */ }
}

function reserveNextQuizAmbience() {
    try {
        const previousTrack = localStorage.getItem(LAST_AMBIENCE_KEY) || "A";
        const nextTrack = previousTrack === "A" ? "B" : "A";
        localStorage.setItem(LAST_AMBIENCE_KEY, nextTrack);
        sessionStorage.setItem(PENDING_AMBIENCE_KEY, nextTrack);
        sessionStorage.setItem(CURRENT_AMBIENCE_KEY, nextTrack);
        return nextTrack;
    } catch (error) {
        console.warn("[LiveQuiz] Could not reserve quiz ambience", error);
        return "A";
    }
}

function isEndedSessionStatus(status) {
    return status === "finished" || status === "ended" || status === "cancelled";
}

async function resetHostSession(options = {}) {
    const { confirmReset = true } = options;
    if (confirmReset && !confirm("End and reset this host session? The current PIN will stop working.")) {
        return false;
    }

    clearHostSession();

    if (sessionId) {
        try {
            await updateDoc(doc(db, "games", sessionId), {
                status: "cancelled",
                endedAt: TS(),
                cancelledAt: TS()
            });
            console.info("[LiveQuiz] Lobby session marked cancelled", { sessionId });
        } catch (error) {
            console.error("[LiveQuiz] Lobby session cancel failed", error);
        }
    }

    if (pin) {
        try {
            await deleteDoc(doc(db, "pins", pin));
            console.info("[LiveQuiz] Lobby PIN deleted", { pin });
        } catch (error) {
            console.error("[LiveQuiz] Lobby PIN cleanup failed", error);
        }
    }

    window.location.href = "./host.html";
    return true;
}

function ensureResetSessionAction() {
    if (document.getElementById("resetHostSessionBtn")) return;

    const button = document.createElement("button");
    button.id = "resetHostSessionBtn";
    button.type = "button";
    button.className = "btn-secondary";
    button.textContent = "End / Reset Session";
    button.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:10000;padding:10px 16px;border-radius:999px;";
    button.addEventListener("click", () => resetHostSession());
    document.body.appendChild(button);
}

const avatarGradients = [
    "linear-gradient(135deg, #8b5cf6, #6125f5)",
    "linear-gradient(135deg, #38bdf8, #2563eb)",
    "linear-gradient(135deg, #fb6aa8, #ec4899)",
    "linear-gradient(135deg, #2dd4bf, #14b8a6)",
    "linear-gradient(135deg, #facc15, #f59e0b)",
    "linear-gradient(135deg, #7c3aed, #4f46e5)",
    "linear-gradient(135deg, #22c55e, #06b6d4)",
    "linear-gradient(135deg, #f97316, #ef4444)"
];

const els = {
    backBtn: document.getElementById("backBtn"),
    pinDigits: document.getElementById("pinDigits"),
    copyPinBtn: document.getElementById("copyPinBtn"),
    waShareBtn: document.getElementById("waShareBtn"),
    playerNumber: document.getElementById("playerNumber"),
    playerCount: document.getElementById("playerCount"),
    playerList: document.getElementById("playerList"),
    startGameBtn: document.getElementById("startGameBtn"),
    freezeLbBtn: document.getElementById("freezeLbBtn"),
    toggleTopBtn: document.getElementById("toggleTopBtn"),
    listModeLabel: document.getElementById("listModeLabel"),
    studentsList: document.getElementById("studentsList"),
    studentsPanel: document.getElementById("studentsPanel"),
    toggleLogBtn: document.getElementById("toggleLogBtn"),
    sessionIdText: document.getElementById("sessionIdText"),
    quizTitleText: document.getElementById("quizTitleText"),
    sessionStatus: document.getElementById("sessionStatus")
};

function escapeHtml(value = "") {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function setStatus(text, isError = false) {
    if (!els.sessionStatus) return;
    els.sessionStatus.textContent = text;
    els.sessionStatus.classList.toggle("error-state", isError);
}

function addLog(title, detail) {
    console.info(`[LiveQuiz] ${title}`, detail || "");
}

function toMillis(value) {
    if (!value) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.seconds === "number") {
        return (value.seconds * 1000) + Math.floor((value.nanoseconds || 0) / 1000000);
    }
    return null;
}

function getJoinMillis(player) {
    return toMillis(player.joinedAt)
        || toMillis(player.createdAt)
        || toMillis(player.joined)
        || toMillis(player.joinTime)
        || toMillis(player.timestamp)
        || toMillis(player.lastJoinedAt);
}

function formatJoinTime(player) {
    const millis = getJoinMillis(player) || observedJoinTimes.get(player.id);
    if (!millis) return "";
    return new Date(millis).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getInitial(name) {
    const trimmed = String(name || "").trim();
    return Array.from(trimmed)[0]?.toUpperCase() || "P";
}

function rememberJoinOrder(players) {
    const activeIds = new Set(players.map((player) => player.id));
    studentJoinOrder = studentJoinOrder.filter((id) => activeIds.has(id));

    const incoming = [...players].sort((a, b) => {
        const timeA = getJoinMillis(a);
        const timeB = getJoinMillis(b);
        if (timeA && timeB && timeA !== timeB) return timeA - timeB;
        if (timeA && !timeB) return -1;
        if (!timeA && timeB) return 1;
        return 0;
    });

    incoming.forEach((player) => {
        if (!studentJoinOrder.includes(player.id)) {
            studentJoinOrder.push(player.id);
        }
        if (!observedJoinTimes.has(player.id)) {
            observedJoinTimes.set(player.id, getJoinMillis(player) || Date.now());
        }
    });
}

function getStudentsInJoinOrder(players) {
    const byId = new Map(players.map((player) => [player.id, player]));
    return studentJoinOrder.map((id) => byId.get(id)).filter(Boolean);
}

function renderPin(value) {
    const digits = String(value || "").padEnd(6, "-").slice(0, 6).split("");
    els.pinDigits.innerHTML = digits.map((digit) => `<div class="pin-digit">${escapeHtml(digit)}</div>`).join("");
}

function renderPlayers(players) {
    if (els.playerNumber) els.playerNumber.textContent = String(players.length);
    if (els.playerCount) els.playerCount.textContent = players.length === 1 ? "Player Joined" : "Players Joined";

    if (!els.playerList || isFrozen) return;

    const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
    const visiblePlayers = sorted.slice(0, playerLimit);

    if (!visiblePlayers.length) {
        els.playerList.innerHTML = `
            <div class="player-row">
                <span class="avatar"><i data-lucide="users"></i></span>
                <div>
                    <strong>Waiting for players</strong>
                    <small>Students will appear here as they join.</small>
                </div>
            </div>
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
    }

    els.playerList.innerHTML = visiblePlayers.map((player, index) => {
        const name = player.name || `Player ${index + 1}`;
        return `
            <div class="player-row">
                <span class="avatar">${escapeHtml(getInitial(name))}</span>
                <div>
                    <strong>${escapeHtml(name)}</strong>
                    <small>${Number(player.score || 0).toLocaleString()} pts</small>
                </div>
            </div>
        `;
    }).join("");
}

function renderStudents(players) {
    if (!els.studentsList) return;

    const students = getStudentsInJoinOrder(players);
    if (!students.length) {
        els.studentsList.innerHTML = `
            <div class="empty-students">
                <div>
                    <i data-lucide="users"></i>
                    <p>Waiting for students to join…</p>
                </div>
            </div>
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
    }

    els.studentsList.innerHTML = students.map((player, index) => {
        const name = player.name || `Student ${index + 1}`;
        const time = formatJoinTime(player);
        const gradient = avatarGradients[index % avatarGradients.length];
        return `
            <div class="student-row">
                <span class="student-avatar" style="--avatar-grad: ${gradient}">${escapeHtml(getInitial(name))}</span>
                <div class="student-meta">
                    <strong>${escapeHtml(name)}</strong>
                    <small>Joined the lobby</small>
                </div>
                <span class="student-time">${escapeHtml(time)}</span>
                <span class="online-dot" aria-label="Online"></span>
            </div>
        `;
    }).join("");
}

async function resolveSessionIdFromPin() {
    if (sessionId) return sessionId;
    if (!pin) throw new Error("Missing sessionId and PIN in lobby URL.");

    const pinSnap = await getDoc(doc(db, "pins", pin));
    if (!pinSnap.exists()) throw new Error(`No session found for PIN ${pin}.`);

    sessionId = pinSnap.data().gameId;
    return sessionId;
}

async function loadSession() {
    console.info("[LiveQuiz] Lobby page loaded", { sessionId, pin });
    addLog("Lobby page loaded", "Reading the live session.");

    await ensureAnonAuth();
    await resolveSessionIdFromPin();

    const sessionSnap = await getDoc(doc(db, "games", sessionId));
    if (!sessionSnap.exists()) {
        throw new Error("Host lobby session was not found in Firestore.");
    }

    const session = sessionSnap.data();
    if (isEndedSessionStatus(session.status)) {
        clearHostSession();
        throw new Error(`Host lobby session is ${session.status}.`);
    }

    pin = pin || session.pin || "";
    renderPin(pin);

    if (els.sessionIdText) els.sessionIdText.textContent = `Session: ${sessionId}`;
    if (els.quizTitleText) els.quizTitleText.textContent = `Quiz: ${session.quizId || "selected"}`;
    setStatus("Lobby active");

    if (session.quizId) {
        currentQuizId = session.quizId;
        const quizSnap = await getDoc(doc(db, "quizzes", session.quizId));
        if (quizSnap.exists() && els.quizTitleText) {
            els.quizTitleText.textContent = `Quiz: ${quizSnap.data().title || "Untitled"}`;
        }
    }

    console.info("[LiveQuiz] Lobby session read success", {
        sessionId,
        pin,
        quizId: session.quizId || ""
    });

    // Make sure session is persisted before starting game
    saveHostSession(sessionId, pin, session.quizId || "");

    listenToPlayers();
}

function listenToPlayers() {
    onSnapshot(collection(db, "games", sessionId, "players"), (snap) => {
        const players = snap.docs.map((playerDoc) => ({
            id: playerDoc.id,
            ...playerDoc.data()
        }));

        latestPlayers = players;
        rememberJoinOrder(players);
        renderPlayers(players);
        renderStudents(players);

        const currentIds = new Set(players.map((player) => player.id));
        const joinedPlayers = players.filter((player) => !seenPlayerIds.has(player.id));

        if (hasSeenInitialPlayers && joinedPlayers.length) {
            console.info("[LiveQuiz] Player joined updates", {
                sessionId,
                count: players.length,
                joined: joinedPlayers.map((player) => player.name || player.id)
            });
        } else if (!hasSeenInitialPlayers) {
            console.info("[LiveQuiz] Initial lobby players", {
                sessionId,
                count: players.length,
                joined: players.map((player) => player.name || player.id)
            });
        }

        seenPlayerIds = currentIds;
        hasSeenInitialPlayers = true;
    }, (error) => {
        console.error("[LiveQuiz] Lobby players read failure", {
            code: error?.code || "unknown",
            message: error?.message || String(error),
            sessionId
        }, error);
        setStatus("Players read failed", true);
    });
}

function buildStartUrl() {
    const url = new URL("./host.html", window.location.href);
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("pin", pin);
    url.searchParams.set("start", "1");
    return url.href;
}

async function startGame() {
    if (!latestPlayers.length) {
        alert("Wait for players!");
        return;
    }

    await enterFullscreen();
    reserveNextQuizAmbience();
    const target = buildStartUrl();
    console.info("[LiveQuiz] Redirect triggered", { target, sessionId, pin });
    addLog("Starting game", "Opening the host gameplay screen.");

    try {
        window.location.assign(target);
    } catch (error) {
        console.error("[LiveQuiz] Redirect failed", {
            target,
            sessionId,
            pin,
            message: error?.message || String(error)
        }, error);
        alert("Could not open the game screen. Check the console for redirect details.");
    }
}

function flashButtonLabel(button, label) {
    const labelNode = button?.querySelector("span");
    if (!labelNode) return;
    const original = labelNode.textContent;
    labelNode.textContent = label;
    window.setTimeout(() => {
        labelNode.textContent = original;
    }, 1300);
}

function showToast(message) {
    let toast = document.getElementById("lobbyToast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "lobbyToast";
        toast.className = "lobby-toast";
        document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.classList.remove("show");
    }, 1800);
}

async function copyPin() {
    console.info("[LiveQuiz] Copy PIN clicked");
    const value = String(pin || "").trim();

    if (!value) {
        console.warn("[LiveQuiz] No PIN available to copy");
        showToast("No PIN found");
        return;
    }

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(value);
        } else {
            const textarea = document.createElement("textarea");
            textarea.value = value;
            textarea.setAttribute("readonly", "");
            textarea.style.position = "fixed";
            textarea.style.left = "-9999px";
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand("copy");
            document.body.removeChild(textarea);
            if (!copied) throw new Error("Fallback copy command failed.");
        }

        flashButtonLabel(els.copyPinBtn, "PIN copied!");
        showToast("PIN copied!");
        addLog("PIN copied", "The join PIN is on your clipboard.");
        console.info("[LiveQuiz] Copy PIN success");
    } catch (error) {
        console.error("[LiveQuiz] Copy PIN failure", error);
        showToast("Could not copy PIN");
    }
}

function shareWhatsApp() {
    const value = String(pin || "");
    if (!value) return;

    const joinUrl = new URL("./join.html", window.location.href);
    const text = `Join my EdTechra live quiz at ${joinUrl.href} with PIN ${value}.`;
    const target = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(target, "_blank", "noopener,noreferrer");
    addLog("WhatsApp share opened", "The PIN share link was opened.");
}

function toggleFreeze() {
    isFrozen = !isFrozen;
    els.freezeLbBtn.classList.toggle("active", isFrozen);
    els.freezeLbBtn.innerHTML = isFrozen
        ? `<i data-lucide="play"></i><span>Live</span>`
        : `<i data-lucide="pause"></i><span>Freeze</span>`;
    addLog(isFrozen ? "List frozen" : "List live", "Player count continues updating.");
    if (!isFrozen) renderPlayers(latestPlayers);
    if (window.lucide) window.lucide.createIcons();
}

function toggleLimit() {
    playerLimit = playerLimit === 10 ? 50 : 10;
    const label = `Top ${playerLimit}`;
    els.toggleTopBtn.innerHTML = `<i data-lucide="list-filter"></i><span>${label}</span>`;
    els.toggleTopBtn.classList.toggle("active", playerLimit === 50);
    if (els.listModeLabel) els.listModeLabel.textContent = label;
    renderPlayers(latestPlayers);
    if (window.lucide) window.lucide.createIcons();
}

function handleLobbyBackNavigation() {
    clearHostSession();
    goHomeSafely();
}

function bindEvents() {
    els.backBtn?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleLobbyBackNavigation();
    });
    els.copyPinBtn?.addEventListener("click", copyPin);
    els.waShareBtn?.addEventListener("click", shareWhatsApp);
    els.startGameBtn?.addEventListener("click", startGame);
    els.freezeLbBtn?.addEventListener("click", toggleFreeze);
    els.toggleTopBtn?.addEventListener("click", toggleLimit);
    els.toggleLogBtn?.addEventListener("click", () => {
        els.studentsPanel?.classList.toggle("collapsed");
    });
}

async function init() {
    if (isForceHomepageNavigation()) {
        clearForceHomepageNavigation();
        clearHostSession();
        goHomeSafely();
        return;
    }

    bindEvents();
    bindExitFullscreenButtons();
    ensureResetSessionAction();
    renderPin(pin);
    renderStudents([]);
    if (window.lucide) window.lucide.createIcons();

    try {
        await loadSession();
    } catch (error) {
        console.error("[LiveQuiz] Lobby session read failure", {
            code: error?.code || "unknown",
            message: error?.message || String(error),
            sessionId,
            pin
        }, error);
        setStatus("Session read failed", true);
    }
}

init();
