import { db, auth, ensureAnonAuth, TS, Fire } from "./firebase.js";
const { doc, setDoc, updateDoc, onSnapshot, collection, query, where, getDoc, writeBatch } = Fire;

let currentGameId = null;
let currentPassage = "";
let durationSec = 60;
let players = {};
let gameInterval = null;
let scoringInterval = null;
let startMs = 0;
let status = 'setup';

const views = {
    setup: document.getElementById("view-setup"),
    lobby: document.getElementById("view-lobby"),
    running: document.getElementById("view-running"),
    finished: document.getElementById("view-finished")
};

const passageInput = document.getElementById("passageInput");
const durationInput = document.getElementById("durationInput");
const presetSelect = document.getElementById("presetSelect");
const createBtn = document.getElementById("createBtn");
const lobbyPin = document.getElementById("lobbyPin");
const shareLink = document.getElementById("shareLink");
const lobbyPlayerList = document.getElementById("lobbyPlayerList");
const playerCountEl = document.getElementById("playerCount");
const startBtn = document.getElementById("startBtn");
const lobbyPassagePreview = document.getElementById("lobbyPassagePreview");
const charCountEl = document.getElementById("charCount");
const durationDisplay = document.getElementById("durationDisplay");
const gameTimer = document.getElementById("gameTimer");
const leaderboardBody = document.getElementById("leaderboardBody");
const passageRunning = document.getElementById("passageRunning");
const timerRing = document.getElementById("timerRing");
const circularTimer = document.getElementById("circularTimer");
const raceLanes = document.getElementById("raceLanes");
const statPlayers = document.getElementById("statPlayers");
const statAvgWpm = document.getElementById("statAvgWpm");
const statTopWpm = document.getElementById("statTopWpm");
const statAvgAcc = document.getElementById("statAvgAcc");
const RACE_COLORS = ['#f59e0b', '#6366f1', '#22d3ee', '#10b981', '#ec4899', '#f97316', '#a78bfa', '#38bdf8'];

// -- Audio ---------------------------------------------------------------------
const sounds = {
    lobby: new Audio("waiting_sound.wav"),
    game: new Audio("quiz)background.mp3"),
    correct: new Audio("https://assets.mixkit.co/active_storage/sfx/2019/2019-preview.mp3"),
    podium: new Audio("https://assets.mixkit.co/active_storage/sfx/2013/2013-preview.mp3"),
    cheer: new Audio("popper.mp3")
};
sounds.lobby.loop = true;
sounds.game.loop = true;

function stopAllBg() {
    sounds.lobby.pause(); sounds.lobby.currentTime = 0;
    sounds.game.pause(); sounds.game.currentTime = 0;
    sounds.podium.pause();
}

// -- Confetti -------------------------------------------------------------------
const confettiCanvas = document.getElementById("confetti-canvas");
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

    sounds.cheer.currentTime = 0;
    sounds.cheer.play().catch(() => { });

    function drawConfetti() {
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

            if (p.y > confettiCanvas.height) {
                p.y = -20;
                p.x = Math.random() * confettiCanvas.width;
            }
        });
        confettiRAF = requestAnimationFrame(drawConfetti);
    }
    confettiRAF = requestAnimationFrame(drawConfetti);

    setTimeout(() => {
        cancelAnimationFrame(confettiRAF);
        ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
        confettiCanvas.style.display = "none";
    }, 8000);
}

// -- Initialization ------------------------------------------------------------
async function init() {
    await ensureAnonAuth();
    if (window.lucide) window.lucide.createIcons();
}

// Preset handling
presetSelect.addEventListener("change", () => {
    if (presetSelect.value) {
        passageInput.value = presetSelect.value;
    }
});

// 1. Create Session
createBtn.addEventListener("click", async () => {
    currentPassage = passageInput.value.trim();
    durationSec = parseInt(durationInput.value) || 60;

    if (!currentPassage || currentPassage.length < 10) {
        alert("Passage must be at least 10 characters!");
        return;
    }

    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    currentGameId = crypto.randomUUID();

    const sessionData = {
        hostUid: auth.currentUser.uid,
        status: 'lobby',
        text: currentPassage,
        durationSec: durationSec,
        createdAt: TS(),
        startMs: 0
    };

    await setDoc(doc(db, "typingSessions", currentGameId), sessionData);
    await setDoc(doc(db, "typingPins", pin), { sid: currentGameId });

    lobbyPin.textContent = pin;
    shareLink.textContent = `${window.location.origin}/livequiz/type.html?sid=${currentGameId}`;
    lobbyPassagePreview.textContent = currentPassage;
    charCountEl.textContent = currentPassage.length;
    durationDisplay.textContent = durationSec;

    showView('lobby');
    listenToPlayers();
});

function showView(viewName) {
    Object.keys(views).forEach(k => views[k].style.display = 'none');
    views[viewName].style.display = viewName === 'running' ? 'flex' : 'block';
    if (viewName === 'finished') views.finished.style.display = 'flex';

    if (viewName === 'lobby') {
        stopAllBg();
        sounds.lobby.play().catch(() => { });
    }
}

function listenToPlayers() {
    const q = collection(db, "typingSessions", currentGameId, "players");
    onSnapshot(q, (snap) => {
        players = {};
        lobbyPlayerList.innerHTML = "";
        snap.forEach(d => {
            const p = d.data();
            players[d.id] = { uid: d.id, ...p };

            // For Lobby
            const span = document.createElement("span");
            span.className = "player-pill";
            span.textContent = p.name;
            lobbyPlayerList.appendChild(span);
        });
        playerCountEl.textContent = `${snap.size} Players Joined`;

        if (status === 'running') {
            updateLeaderboard();
        }
    });
}

// 2. Start Game
startBtn.addEventListener("click", async () => {
    if (Object.keys(players).length === 0) {
        alert("Wait for players to join!");
        return;
    }

    status = 'running';
    startMs = Date.now();
    passageRunning.textContent = currentPassage;

    await updateDoc(doc(db, "typingSessions", currentGameId), {
        status: 'running',
        startMs: startMs
    });

    showView('running');
    stopAllBg();
    sounds.game.play().catch(() => { });
    startTimers();
});

function startTimers() {
    const CIRCUMFERENCE = 2 * Math.PI * 45; // ~283
    if (timerRing) timerRing.style.strokeDasharray = CIRCUMFERENCE;

    gameInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startMs) / 1000);
        const remaining = Math.max(0, durationSec - elapsed);
        gameTimer.textContent = remaining;

        // Update ring
        if (timerRing) {
            const offset = CIRCUMFERENCE * (1 - remaining / durationSec);
            timerRing.style.strokeDashoffset = offset;
        }
        if (circularTimer) {
            if (remaining <= 10) circularTimer.classList.add('timer-critical');
            else circularTimer.classList.remove('timer-critical');
        }

        if (remaining <= 0) {
            finishGame();
        }
    }, 1000);

    scoringInterval = setInterval(() => {
        calculateAllScores();
    }, 1000);
}

function calculateAllScores() {
    const elapsedSec = (Date.now() - startMs) / 1000;
    if (elapsedSec <= 0) return;

    const batch = writeBatch(db);
    let hasUpdates = false;

    Object.values(players).forEach(p => {
        if (p.done) return;

        // WPM = (typedLen / 5) / (min)
        const typedLen = p.typedLen || 0;
        const errors = p.errors || 0;
        const wpm = Math.max(0, Math.round((typedLen / 5) / (elapsedSec / 60)));
        const accuracy = typedLen > 0 ? Math.round(((typedLen - errors) / typedLen) * 100) : 100;

        // Speed-based scoring logic
        // Base score = (WPM * 10) + (Accuracy * 5)
        // Penalty = Errors * 20
        const score = Math.max(0, (wpm * 20) + (accuracy * 10) - (errors * 30));

        // Update local state for immediate re-render
        players[p.uid] = { ...players[p.uid], wpm, accuracy, score };

        // Batch update to Firestore
        const pRef = doc(db, "typingSessions", currentGameId, "players", p.uid);
        batch.update(pRef, { wpm, accuracy, score });
        hasUpdates = true;
    });

    if (hasUpdates) {
        batch.commit();
        updateLeaderboard();
    }
}

function updateLeaderboard() {
    const sorted = Object.values(players).sort((a, b) => (b.score || 0) - (a.score || 0));
    leaderboardBody.innerHTML = "";

    sorted.forEach((p, i) => {
        const rank = i + 1;
        const flags = [];
        if (p.flags?.suspiciousSpeed) flags.push("🚀 Speed!");
        if (p.blurCount > 2) flags.push(`😴 Focus (${p.blurCount})`);

        let rankClass = 'normal';
        let topClass = '';
        let scoreClass = '';
        if (rank === 1) { rankClass = 'gold'; topClass = 'top-1'; scoreClass = 'gold'; }
        else if (rank === 2) { rankClass = 'silver'; topClass = 'top-2'; }
        else if (rank === 3) { rankClass = 'bronze'; topClass = 'top-3'; }

        const medals = ['🥇', '🥈', '🥉'];
        const rankLabel = rank <= 3 ? medals[rank - 1] : rank;

        const card = document.createElement('div');
        card.className = `player-card ${topClass}`;
        card.innerHTML = `
            <div class="rank-badge ${rankClass}">${rankLabel}</div>
            <div class="pc-info">
                <div class="pc-name">${p.name}</div>
                <div class="pc-stats">
                    <div class="pc-stat">⚡ <span class="val">${p.wpm || 0}</span> WPM</div>
                    <div class="pc-stat">🎯 <span class="val">${p.accuracy || 100}%</span></div>
                    ${p.done ? '<div class="pc-stat" style="color:var(--accent-success)">✅ Done</div>' : ''}
                </div>
            </div>
            ${flags.length ? `<div class="pc-flags">${flags.map(f => `<span class="flag-chip">${f}</span>`).join('')}</div>` : ''}
            <div class="pc-score ${scoreClass}">${(p.score || 0).toLocaleString()}</div>
        `;
        leaderboardBody.appendChild(card);
    });

    // Update race lanes
    updateRaceLanes(sorted);
    // Update live stats
    updateLiveStats(sorted);
}

function updateRaceLanes(sorted) {
    if (!raceLanes) return;
    raceLanes.innerHTML = '';
    const passLen = currentPassage.length || 1;

    sorted.forEach((p, i) => {
        const pct = Math.min(100, Math.round(((p.typedLen || 0) / passLen) * 100));
        const color = RACE_COLORS[i % RACE_COLORS.length];
        const lane = document.createElement('div');
        lane.className = 'race-lane';
        lane.innerHTML = `
            <div class="race-name">${p.name}</div>
            <div class="race-bar-wrap">
                <div class="race-bar" style="width:${pct}%; background: linear-gradient(90deg, ${color}, ${color}dd);"></div>
            </div>
            <div class="race-pct">${pct}%</div>
        `;
        raceLanes.appendChild(lane);
    });
}

function updateLiveStats(sorted) {
    const count = sorted.length;
    if (statPlayers) statPlayers.textContent = count;

    if (count === 0) return;

    const totalWpm = sorted.reduce((s, p) => s + (p.wpm || 0), 0);
    const topWpm = sorted.reduce((m, p) => Math.max(m, p.wpm || 0), 0);
    const totalAcc = sorted.reduce((s, p) => s + (p.accuracy || 100), 0);

    if (statAvgWpm) statAvgWpm.textContent = Math.round(totalWpm / count);
    if (statTopWpm) statTopWpm.textContent = topWpm;
    if (statAvgAcc) statAvgAcc.textContent = `${Math.round(totalAcc / count)}%`;
}

// 3. Finish Game
async function finishGame() {
    if (status === 'finished') return;
    clearInterval(gameInterval);
    clearInterval(scoringInterval);
    status = 'finished';

    await updateDoc(doc(db, "typingSessions", currentGameId), {
        status: 'finished'
    });

    stopAllBg();
    showView('finished');
    showPodium();
}

async function showPodium() {
    const sorted = Object.values(players).sort((a, b) => (b.score || 0) - (a.score || 0));
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
            if (sorted[i]) {
                s.querySelector(".name").textContent = sorted[i].name;
                s.querySelector(".score").textContent = `${(sorted[i].score || 0).toLocaleString()} pts`;
            } else {
                s.querySelector(".name").textContent = "---";
                s.querySelector(".score").textContent = "0 pts";
            }
        }
    });

    // === STEP 1: Zoom into 3rd place ===
    setTimeout(() => {
        stage.classList.add("zoom-3rd");
        setTimeout(() => {
            if (spots[2]) spots[2].classList.add("reveal", "spotlight");
        }, 400);

        // === STEP 2: Pan to 2nd place ===
        setTimeout(() => {
            if (spots[2]) spots[2].classList.remove("spotlight");
            stage.classList.remove("zoom-3rd");
            stage.classList.add("zoom-2nd");
            setTimeout(() => {
                if (spots[1]) spots[1].classList.add("reveal", "spotlight");
            }, 400);

            // === STEP 3: Dramatic zoom to 1st place ===
            setTimeout(() => {
                if (spots[1]) spots[1].classList.remove("spotlight");
                stage.classList.remove("zoom-2nd");
                stage.classList.add("zoom-1st");
                setTimeout(() => {
                    if (spots[0]) {
                        spots[0].classList.add("reveal", "spotlight");
                        const crown = spots[0].querySelector(".winner-fx");
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

// -- Fullscreen FAB Handler -----------------------------------------------------
const fullscreenFab = document.getElementById("fullscreenFab");
if (fullscreenFab) {
    fullscreenFab.addEventListener("click", () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => { });
            fullscreenFab.textContent = "\u2715";
        } else {
            document.exitFullscreen().catch(() => { });
            fullscreenFab.textContent = "\u26F6";
        }
    });
    document.addEventListener("fullscreenchange", () => {
        fullscreenFab.textContent = document.fullscreenElement ? "\u2715" : "\u26F6";
    });
}

init();
