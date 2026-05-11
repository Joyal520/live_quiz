import { db, auth, ensureAnonAuth, Fire, GameStatus } from "./firebase.js";
const { doc, getDoc, setDoc, onSnapshot, getDocs, collection, query, orderBy } = Fire;

// Load confetti via CDN
const script = document.createElement('script');
script.src = "https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js";
document.head.appendChild(script);

// State
let currentGameId = null;
let currentQIndex = -1;
let hasAnswered = false;
let gameUnsubscribe = null;
let playersUnsubscribe = null;
let profile = { name: "", score: 0 };
let hostMode = "classroom"; // "classroom" or "distance"
let currentPin = "";
let currentQuizData = null;
let selectedAnswerIndex = -1;
let timerInterval = null;
let activeTimerKey = "";
let latestGameData = null;
let isJoining = false;
const TIMER_RADIUS = 44;
const TIMER_CIRCUMFERENCE = 2 * Math.PI * TIMER_RADIUS;
const DEFAULT_QUESTION_DURATION_SEC = 20;

function isJoinableSessionStatus(status) {
    return status === GameStatus.LOBBY || status === GameStatus.QUESTION || status === GameStatus.REVEAL;
}

function normalizeMillis(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;

    if (typeof value === "string") {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : null;
    }

    if (value && typeof value.toMillis === "function") {
        try {
            const millis = value.toMillis();
            return Number.isFinite(millis) ? millis : null;
        } catch (error) {
            console.warn("[LiveQuiz][StudentTimer] Unable to convert Timestamp with toMillis()", error);
            return null;
        }
    }

    if (value && typeof value === "object") {
        const seconds = Number(value.seconds ?? value._seconds);
        const nanoseconds = Number(value.nanoseconds ?? value._nanoseconds ?? 0);
        if (Number.isFinite(seconds)) {
            return (seconds * 1000) + (Number.isFinite(nanoseconds) ? Math.floor(nanoseconds / 1e6) : 0);
        }
    }

    return null;
}

function normalizeDurationSec(value) {
    const duration = Number(value);
    return Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_QUESTION_DURATION_SEC;
}

function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}

function stopStudentTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    activeTimerKey = "";
}

function renderStudentTimer(remainingMs, durationSec) {
    const totalMs = Math.max(1, durationSec * 1000);
    const safeRemainingMs = Math.min(totalMs, Math.max(0, remainingMs));
    const elapsedProgress = clamp01(1 - (safeRemainingMs / totalMs));
    const remainingSeconds = Math.ceil(safeRemainingMs / 1000);

    timerText.textContent = remainingSeconds;
    timerCircle.style.animation = "none";
    timerCircle.style.strokeDasharray = TIMER_CIRCUMFERENCE.toString();
    timerCircle.style.strokeDashoffset = (TIMER_CIRCUMFERENCE * elapsedProgress).toString();
}

function startStudentTimer(game) {
    const durationSec = normalizeDurationSec(game.questionDurationSec);
    const totalMs = durationSec * 1000;
    const normalizedStartMs = normalizeMillis(game.questionStartMs);
    const hasValidStart = Number.isFinite(normalizedStartMs);
    const timerKey = getStudentTimerKey(game);

    if (timerInterval && activeTimerKey === timerKey) return;

    // Determine startMs with clock-skew protection.
    // The host writes questionStartMs using its own Date.now().
    // If the student phone's clock differs from the host PC,
    // the computed remaining time will be wrong (often instantly 0).
    // Fix: if the host timestamp would produce an already-expired or
    // unreasonably long timer, fall back to a local countdown.
    let startMs;
    if (hasValidStart) {
        const hostElapsed = Date.now() - normalizedStartMs;
        const hostRemaining = totalMs - hostElapsed;
        if (hostRemaining > 0 && hostRemaining <= totalMs) {
            // Host timestamp is sane — use it
            startMs = normalizedStartMs;
        } else {
            // Clock skew detected: remaining time is negative (phone clock ahead)
            // or exceeds total duration (phone clock behind).
            // Fall back to local countdown from now.
            console.warn("[LiveQuiz][StudentTimer] Clock skew detected; using local countdown.", {
                qIndex: game.qIndex,
                hostStartMs: normalizedStartMs,
                studentNow: Date.now(),
                hostElapsed,
                hostRemaining,
                durationSec
            });
            startMs = Date.now();
        }
    } else {
        console.warn("[LiveQuiz][StudentTimer] Missing or invalid questionStartMs; using full duration fallback.", {
            qIndex: game.qIndex,
            questionStartMs: game.questionStartMs,
            questionDurationSec: game.questionDurationSec
        });
        startMs = Date.now();
    }

    stopStudentTimer();
    activeTimerKey = timerKey;

    const tick = () => {
        const remainingMs = totalMs - (Date.now() - startMs);
        renderStudentTimer(remainingMs, durationSec);

        if (remainingMs <= 0 && timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
    };

    tick();
    timerInterval = setInterval(tick, 250);
}

function getStudentTimerKey(game) {
    const durationSec = normalizeDurationSec(game.questionDurationSec);
    return `${game.qIndex}:${durationSec}`;
}

// DOM
const screens = {
    join: document.getElementById("screen-join"),
    lobby: document.getElementById("screen-lobby"),
    question: document.getElementById("screen-question"),
    feedback: document.getElementById("screen-feedback"),
    end: document.getElementById("screen-end")
};

const joinBtn = document.getElementById("joinBtn");
const studentBackBtn = document.getElementById("studentBackBtn");
const joinPin = document.getElementById("joinPin");
const joinName = document.getElementById("joinName");
const joinStatus = document.getElementById("joinStatus");
const welcomeName = document.getElementById("welcomeName");
const finalRank = document.getElementById("finalRank");
const finalScore = document.getElementById("finalScore");
const finalPodium = document.getElementById("finalPodium");
const finalRows = document.getElementById("finalRows");
const lobbyAvatarStrip = document.getElementById("lobbyAvatarStrip");
const shareResultBtn = document.getElementById("shareResultBtn");

// Question screen elements
const gamePinEl = document.getElementById("gamePin");
const gamePlayersEl = document.getElementById("gamePlayers");
const qCounterPill = document.getElementById("qCounterPill");
const timerCircle = document.getElementById("timerCircle");
const timerText = document.getElementById("timerText");
const instructionEye = document.getElementById("instructionEye");
const instructionTitle = document.getElementById("instructionTitle");
const classroomAnswers = document.getElementById("classroomAnswers");
const distanceAnswers = document.getElementById("distanceAnswers");
const distanceQuestionText = document.getElementById("distanceQuestionText");
const distanceCardsList = document.getElementById("distanceCardsList");
const answeringTip = document.getElementById("answeringTip");
const lockedFooter = document.getElementById("lockedFooter");

// Feedback elements
const fbCorrect = document.getElementById("fbCorrect");
const fbWrong = document.getElementById("fbWrong");
const fbPointsCorrect = document.getElementById("fbPointsCorrect");
const fbPointsWrong = document.getElementById("fbPointsWrong");
const fbCorrectLabel = document.getElementById("fbCorrectLabel");
const fbAnswerList = document.getElementById("fbAnswerList");

function showScreen(screenId) {
    Object.values(screens).forEach(s => s.classList.remove("active"));
    screens[screenId].classList.add("active");
    document.body.dataset.screen = screenId;
}

document.body.dataset.screen = "join";

function handleBackNavigation() {
    if (window.history.length > 1) {
        window.history.back();
    } else {
        window.location.href = "./index.html";
    }
}

studentBackBtn?.addEventListener("click", handleBackNavigation);

function getFirebaseErrorDetails(error) {
    return {
        code: error?.code || "unknown",
        message: error?.message || String(error)
    };
}

function showJoinError(context, error) {
    const details = getFirebaseErrorDetails(error);
    console.error(`[LiveQuiz] ${context}`, details, error);
    return `${context}: ${details.code} - ${details.message}`;
}

function renderLobbyAvatarStrip(count) {
    if (!lobbyAvatarStrip) return;
    const visible = Math.min(count, 6);
    lobbyAvatarStrip.innerHTML = "";
    for (let i = 0; i < visible; i++) {
        const dot = document.createElement("span");
        dot.className = "lobby-avatar-dot";
        dot.style.background = [
            "linear-gradient(135deg,#8b5cf6,#2563eb)",
            "linear-gradient(135deg,#ec4899,#8b5cf6)",
            "linear-gradient(135deg,#22c55e,#22d3ee)",
            "linear-gradient(135deg,#f97316,#ec4899)"
        ][i % 4];
        lobbyAvatarStrip.appendChild(dot);
    }
}

// ===== JOIN SCREEN INPUT FORMATTING =====
joinPin.addEventListener("input", (e) => {
    let val = e.target.value.replace(/\s/g, '').replace(/\D/g, '').substring(0, 6);
    if (val.length > 3) val = val.substring(0, 3) + ' ' + val.substring(3, 6);
    e.target.value = val;
});

joinName.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    const avatarPreview = document.getElementById("avatarPreview");
    const avatarInitial = document.getElementById("avatarInitial");
    if (val.length > 0) {
        avatarInitial.textContent = val.charAt(0).toUpperCase();
        avatarPreview.classList.add("visible");
    } else {
        avatarPreview.classList.remove("visible");
        avatarInitial.textContent = "?";
    }
});

// ===== 1. JOIN LOGIC =====
joinBtn.addEventListener("click", async () => {
    if (isJoining) return;
    const pin = joinPin.value.replace(/\s/g, '').trim();
    const name = joinName.value.trim();

    if (!/^\d{6}$/.test(pin)) return (joinStatus.textContent = "Enter 6-digit PIN");
    if (name.length < 2) return (joinStatus.textContent = "Name too short");

    isJoining = true;
    joinBtn.disabled = true;
    joinStatus.textContent = "Joining...";
    console.info("[LiveQuiz] Join button clicked", { pin });

    try {
        const user = await ensureAnonAuth();
        const pinSnap = await getDoc(doc(db, "pins", pin));

        if (!pinSnap.exists()) {
            const typingSnap = await getDoc(doc(db, "typingPins", pin));
            if (typingSnap.exists()) {
                window.location.href = `type.html?sid=${typingSnap.data().sid}`;
                return;
            }
            joinStatus.textContent = "PIN not found!";
            return;
        }

        currentGameId = pinSnap.data().gameId;
        if (!currentGameId) {
            throw new Error("PIN document does not contain a gameId.");
        }

        const gameSnap = await getDoc(doc(db, "games", currentGameId));
        if (!gameSnap.exists()) {
            joinStatus.textContent = "PIN expired!";
            return;
        }

        const gameData = gameSnap.data();
        if (!isJoinableSessionStatus(gameData.status)) {
            joinStatus.textContent = "This game has ended.";
            return;
        }

        console.info("[LiveQuiz] Session lookup success", { pin, gameId: currentGameId });
        currentPin = pin;
        profile.name = name;

        // Register student
        console.info("[LiveQuiz] Student write started", { gameId: currentGameId });
        await setDoc(doc(db, "games", currentGameId, "players", user.uid), {
            name, score: 0, lastEarned: 0
        }, { merge: true });
        console.info("[LiveQuiz] Student write success", { gameId: currentGameId });

        welcomeName.textContent = name;

        // Update PIN display in lobby
        const pinBoxes = document.querySelectorAll("#displayPinBoxes .pin-digit");
        for (let i = 0; i < 6; i++) {
            if (pinBoxes[i] && pin[i]) pinBoxes[i].textContent = pin[i];
        }

        // Set PIN in game header
        if (gamePinEl) gamePinEl.textContent = pin.substring(0,3) + ' ' + pin.substring(3);

        showScreen("lobby");
        startListening();
    } catch (error) {
        const message = showJoinError("Student join error", error);
        joinStatus.textContent = message;
    } finally {
        isJoining = false;
        joinBtn.disabled = false;
    }
});

// ===== 2. REAL-TIME LISTENING =====
function startListening() {
    if (gameUnsubscribe) gameUnsubscribe();
    if (playersUnsubscribe) playersUnsubscribe();

    playersUnsubscribe = onSnapshot(collection(db, "games", currentGameId, "players"), (snap) => {
        const count = snap.size;
        if (document.getElementById("lobbyPlayerCount")) {
            document.getElementById("lobbyPlayerCount").textContent = count;
        }
        if (gamePlayersEl) gamePlayersEl.textContent = count;
        renderLobbyAvatarStrip(count);
    }, (error) => {
        showJoinError("Player listener error", error);
    });

    gameUnsubscribe = onSnapshot(doc(db, "games", currentGameId), async (snap) => {
        const game = snap.data();
        if (!game) return;
        latestGameData = game;

        // Read hostMode from game doc (default: classroom)
        hostMode = game.hostMode || "classroom";
        document.body.dataset.hostMode = hostMode;

        switch (game.status) {
            case GameStatus.LOBBY:
                stopStudentTimer();
                showScreen("lobby");
                break;
            case GameStatus.QUESTION:
                if (currentQIndex !== game.qIndex) {
                    currentQIndex = game.qIndex;
                    hasAnswered = false;
                    selectedAnswerIndex = -1;
                    prepareQuestion(game);
                } else if (activeTimerKey !== getStudentTimerKey(game)) {
                    startStudentTimer(game);
                }
                break;
            case GameStatus.REVEAL:
                if (currentQIndex === game.qIndex) {
                    showFeedback(game);
                }
                break;
            case GameStatus.FINISHED:
                stopStudentTimer();
                showFinalResults();
                break;
            case "ended":
            case "cancelled":
                stopStudentTimer();
                joinStatus.textContent = "This game has ended.";
                showScreen("join");
                break;
        }
    }, (error) => {
        showJoinError("Session listener error", error);
    });
}

// ===== 3. QUESTION LOGIC =====
async function prepareQuestion(game) {
    showScreen("question");

    // Fetch quiz data
    if (!currentQuizData) {
        const quizSnap = await getDoc(doc(db, "quizzes", game.quizId));
        currentQuizData = quizSnap.data();
    }

    const q = currentQuizData.questions[game.qIndex];
    const totalQ = currentQuizData.questions.length;

    // Update header
    qCounterPill.textContent = `Question ${game.qIndex + 1} / ${totalQ}`;

    // Reset UI state
    answeringTip.style.display = "flex";
    lockedFooter.style.display = "none";

    startStudentTimer(game);

    // Mode-specific rendering
    if (hostMode === "distance") {
        setupDistanceMode(q);
    } else {
        setupClassroomMode(q);
    }
}

function setupClassroomMode(q) {
    classroomAnswers.style.display = "grid";
    distanceAnswers.style.display = "none";
    instructionEye.textContent = "Look at the screen in front";
    instructionTitle.textContent = "Choose your answer";

    // Reset buttons
    const btns = classroomAnswers.querySelectorAll(".classroom-btn");
    btns.forEach((btn, i) => {
        btn.classList.remove("selected", "disabled");
        btn.style.display = (i < q.options.length) ? "flex" : "none";
        btn.onclick = () => {
            if (hasAnswered) return;
            hasAnswered = true;
            selectedAnswerIndex = i;
            btn.classList.add("selected");
            btns.forEach(b => b.classList.add("disabled"));
            btn.classList.remove("disabled");
            onAnswerSelected(i);
        };
    });
}

function setupDistanceMode(q) {
    classroomAnswers.style.display = "none";
    distanceAnswers.style.display = "flex";
    instructionEye.textContent = "Everyone can see your answer";
    instructionTitle.textContent = "Choose your answer";

    distanceQuestionText.textContent = cleanText(q.question);

    const colors = ["dc-purple", "dc-blue", "dc-orange", "dc-green"];
    const badgeColors = ["#8b5cf6", "#3b82f6", "#f97316", "#22c55e"];

    distanceCardsList.innerHTML = "";
    q.options.forEach((opt, i) => {
        const card = document.createElement("div");
        card.className = `distance-card ${colors[i % 4]}`;
        card.dataset.answerIndex = String(i);
        card.setAttribute("aria-label", `Answer ${i + 1}: ${cleanText(opt)}`);
        card.innerHTML = `
            <div class="num-badge" style="background:${badgeColors[i % 4]}">${i + 1}</div>
            <span class="opt-text">${cleanText(opt)}</span>
            <span class="choice-dot" aria-hidden="true"></span>
            <span class="lock-icon">&#128274;</span>
        `;
        card.addEventListener("click", () => {
            if (hasAnswered) return;
            hasAnswered = true;
            selectedAnswerIndex = i;
            card.classList.add("selected");
            distanceCardsList.querySelectorAll(".distance-card").forEach(c => c.classList.add("disabled"));
            card.classList.remove("disabled");
            onAnswerSelected(i);
        });
        distanceCardsList.appendChild(card);
    });
}

function onAnswerSelected(index) {
    // Show locked footer, hide tip
    answeringTip.style.display = "none";
    lockedFooter.style.display = "flex";
    submitAnswer(index);
}

// ===== SUBMIT ANSWER =====
async function submitAnswer(index) {
    const uid = auth.currentUser.uid;
    await setDoc(doc(db, "games", currentGameId, "answers", `${uid}_${currentQIndex}`), {
        uid,
        index,
        qIndex: currentQIndex,
        clientTimeMs: Date.now()
    });
}

// ===== FEEDBACK =====
async function showFeedback(game) {
    const uid = auth.currentUser.uid;

    // Wait for score propagation
    await new Promise(r => setTimeout(r, 1200));

    const pSnap = await getDoc(doc(db, "games", currentGameId, "players", uid));
    const pData = pSnap.data() || { score: 0, lastEarned: 0 };

    const lastEarned = pData.lastEarned || 0;
    const isCorrect = lastEarned > 0;

    // Get question data for answer review
    const q = currentQuizData.questions[game.qIndex];
    const correctIdx = game.correctAnswerIndex;

    // Show correct or wrong state
    if (isCorrect) {
        fbCorrect.style.display = "block";
        fbWrong.style.display = "none";
        fbPointsCorrect.textContent = `+${lastEarned}`;
        document.getElementById("sfxCorrect")?.play().catch(() => {});
        // Mini confetti
        if (window.confetti) {
            window.confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 } });
        }
    } else {
        fbCorrect.style.display = "none";
        fbWrong.style.display = "block";
        fbPointsWrong.textContent = "0";
        document.getElementById("sfxWrong")?.play().catch(() => {});
    }

    // Build answer review list
    fbCorrectLabel.style.display = "block";
    fbAnswerList.innerHTML = "";

    const badgeColors = ["#8b5cf6", "#3b82f6", "#f97316", "#22c55e"];

    if (q && q.options) {
        q.options.forEach((opt, i) => {
            const item = document.createElement("div");
            item.className = "fb-answer-item";
            if (i === correctIdx) item.classList.add("correct-highlight");
            if (i === selectedAnswerIndex && !isCorrect) item.classList.add("wrong-highlight");

            let checkMark = "";
            if (i === correctIdx) checkMark = '<span class="check-mark">&#10003;</span>';
            else if (i === selectedAnswerIndex && !isCorrect) checkMark = '<span class="check-mark">&#10005;</span>';

            item.innerHTML = `
                <div class="mini-badge" style="background:${badgeColors[i % 4]}">${i + 1}</div>
                <span class="ans-text">${cleanText(opt)}</span>
                ${checkMark}
            `;
            fbAnswerList.appendChild(item);
        });
    }

    showScreen("feedback");
}

// ===== FINAL RESULTS =====
async function showFinalResults() {
    const uid = auth.currentUser.uid;

    const pSnap = await getDocs(query(collection(db, "games", currentGameId, "players"), orderBy("score", "desc")));
    const players = pSnap.docs.map((d, i) => ({ id: d.id, rank: i + 1, ...d.data() }));
    let rank = 0;
    let score = 0;

    players.forEach((p) => {
        if (p.id === uid) {
            rank = p.rank;
            score = p.score || 0;
        }
    });

    if (!latestGameData) {
        const gameSnap = await getDoc(doc(db, "games", currentGameId));
        latestGameData = gameSnap.data();
    }

    if (!currentQuizData && latestGameData?.quizId) {
        const quizSnap = await getDoc(doc(db, "quizzes", latestGameData.quizId));
        currentQuizData = quizSnap.data();
    }

    const accuracyByUid = await buildAccuracyMap();
    const enrichedPlayers = players.map(p => ({ ...p, accuracy: accuracyByUid[p.id] ?? null }));
    const rankText = rank === 1 ? "1st" : rank === 2 ? "2nd" : rank === 3 ? "3rd" : `#${rank}`;
    finalRank.textContent = rankText;
    finalScore.textContent = score.toLocaleString();
    renderFinalLeaderboard(enrichedPlayers);

    showScreen("end");

    if (rank <= 3 && window.confetti) {
        const duration = 5000;
        const animationEnd = Date.now() + duration;
        const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 0 };
        const randomInRange = (min, max) => Math.random() * (max - min) + min;
        const interval = setInterval(() => {
            const timeLeft = animationEnd - Date.now();
            if (timeLeft <= 0) return clearInterval(interval);
            const particleCount = 50 * (timeLeft / duration);
            window.confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } });
            window.confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } });
        }, 250);
    }
}

async function buildAccuracyMap() {
    const result = {};
    if (!currentQuizData?.questions?.length) return result;

    const answersSnap = await getDocs(collection(db, "games", currentGameId, "answers"));
    const totals = {};

    answersSnap.forEach((d) => {
        const ans = d.data();
        const q = currentQuizData.questions[ans.qIndex];
        if (!ans.uid || !q) return;
        if (!totals[ans.uid]) totals[ans.uid] = { answered: 0, correct: 0 };
        totals[ans.uid].answered += 1;
        if (ans.index === q.correctIndex) totals[ans.uid].correct += 1;
    });

    Object.entries(totals).forEach(([uid, stat]) => {
        result[uid] = stat.answered ? Math.round((stat.correct / stat.answered) * 100) : null;
    });

    return result;
}

function renderFinalLeaderboard(players) {
    if (!finalPodium || !finalRows) return;

    const podiumOrder = [players[1], players[0], players[2]];
    finalPodium.innerHTML = podiumOrder.map((p, idx) => {
        const place = idx === 0 ? 2 : idx === 1 ? 1 : 3;
        if (!p) return `<div class="final-podium-card place-${place} empty"></div>`;
        return `
            <div class="final-podium-card place-${place}">
              <div class="podium-avatar">${getInitial(p.name)}</div>
              <div class="podium-name">${escapeHtml(p.name || "Student")}</div>
              <div class="podium-score">${(p.score || 0).toLocaleString()}</div>
              ${p.accuracy !== null ? `<div class="podium-accuracy">${p.accuracy}%</div>` : ""}
            </div>
        `;
    }).join("");

    finalRows.innerHTML = players.slice(3, 10).map((p) => `
        <div class="final-row">
          <span class="row-rank">${p.rank}</span>
          <span class="row-avatar">${getInitial(p.name)}</span>
          <span class="row-name">${escapeHtml(p.name || "Student")}</span>
          <span class="row-score">${(p.score || 0).toLocaleString()}${p.accuracy !== null ? ` - ${p.accuracy}%` : ""}</span>
        </div>
    `).join("");

    if (players.length <= 3) {
        finalRows.innerHTML = `<div class="final-row"><span class="row-rank">--</span><span class="row-avatar">E</span><span class="row-name">Final results are in</span><span class="row-score">${players.length}</span></div>`;
    }
}

// ===== HELPERS =====
function cleanText(t) {
    return t ? t.replace(/\*\*/g, "").replace(/\*/g, "").replace(/^\d+[.):] ?/, "").trim() : "";
}

function getInitial(name = "S") {
    return (name.trim().charAt(0) || "S").toUpperCase();
}

function escapeHtml(value = "") {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

shareResultBtn?.addEventListener("click", async () => {
    const text = `I scored ${finalScore.textContent} points in EdTechra.`;
    try {
        if (navigator.share) {
            await navigator.share({ title: "EdTechra result", text });
        } else {
            await navigator.clipboard.writeText(text);
            shareResultBtn.textContent = "Copied!";
            setTimeout(() => { shareResultBtn.textContent = "Share"; }, 1600);
        }
    } catch {
        // Sharing is optional; ignore cancelled share sheets.
    }
});
