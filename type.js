import { db, auth, ensureAnonAuth, Fire } from "./firebase.js";
const { doc, setDoc, updateDoc, onSnapshot, collection, query, where, getDocs, limit } = Fire;

let sid = new URLSearchParams(window.location.search).get("sid");
let uid = null;
let name = "";
let passage = "";
let status = "lobby";
let unsubSession = null;
let blurCount = 0;
let lastTypedLen = 0;
let flags = { suspiciousSpeed: false };
let updateThrottleTimer = null;

const views = {
    join: document.getElementById("view-join"),
    waiting: document.getElementById("view-waiting"),
    game: document.getElementById("view-game"),
    results: document.getElementById("view-results")
};

const playerNameInput = document.getElementById("playerName");
const pinInput = document.getElementById("pinInput");
const joinBtn = document.getElementById("joinBtn");
const waitingName = document.getElementById("waitingName");
const passageDisplay = document.getElementById("passageDisplay");
const typingArea = document.getElementById("typingArea");
const timerDisplay = document.getElementById("timerDisplay");
const progressDisplay = document.getElementById("progressDisplay");
const lockOverlay = document.getElementById("lockOverlay");

async function init() {
    const user = await ensureAnonAuth();
    uid = user.uid;

    // Block mobile devices
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
        || (window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900);
    if (isMobile) {
        const overlay = document.getElementById('mobileBlock');
        if (overlay) overlay.classList.add('active');
        return; // Stop all further initialization
    }

    if (sid) {
        pinInput.style.display = "none";
    }
}

joinBtn.addEventListener("click", async () => {
    name = playerNameInput.value.trim();
    if (!name) return alert("Enter your name!");

    if (!sid) {
        const pin = pinInput.value.trim();
        if (!pin) return alert("Enter PIN!");

        const q = query(collection(db, "typingPins"), where("sid", "==", pin), limit(1)); // Wait, pin mapping is pin -> sid
        const pinSnap = await getDocs(query(collection(db, "typingPins"), where("__name__", "==", pin), limit(1)));

        if (pinSnap.empty) return alert("Invalid PIN!");
        sid = pinSnap.docs[0].data().sid;
    }

    joinSession();
});

async function joinSession() {
    const sessionSnap = await Fire.getDoc(doc(db, "typingSessions", sid));
    if (!sessionSnap.exists()) return alert("Session not found!");

    passage = sessionSnap.data().text.replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-");
    waitingName.textContent = `Joined as ${name}`;
    showView('waiting');

    // Create player record
    await setDoc(doc(db, "typingSessions", sid, "players", uid), {
        name: name,
        typedLen: 0,
        errors: 0,
        blurCount: 0,
        done: false,
        lastUpdateMs: Date.now(),
        flags: {}
    });

    listenToSession();
}

function showView(viewName) {
    Object.keys(views).forEach(k => views[k].style.display = 'none');
    views[viewName].style.display = 'block';
}

function listenToSession() {
    unsubSession = onSnapshot(doc(db, "typingSessions", sid), (snap) => {
        const data = snap.data();
        if (!data) return;

        if (data.status === 'running' && status !== 'running') {
            startGame(data);
        } else if (data.status === 'finished' && status !== 'finished') {
            finishGame();
        }

        if (status === 'running') {
            if (!window._studentTimerInterval) {
                window._studentTimerInterval = setInterval(() => {
                    const elapsed = Math.floor((Date.now() - data.startMs) / 1000);
                    const remaining = Math.max(0, data.durationSec - elapsed);
                    timerDisplay.textContent = `Timer: ${remaining}s`;
                    if (remaining <= 0) {
                        clearInterval(window._studentTimerInterval);
                        window._studentTimerInterval = null;
                        finishGame();
                    }
                }, 1000);
            }
        } else if (window._studentTimerInterval) {
            clearInterval(window._studentTimerInterval);
            window._studentTimerInterval = null;
        }
    });

    // Also listen to own results
    onSnapshot(doc(db, "typingSessions", sid, "players", uid), (snap) => {
        const p = snap.data();
        if (status === 'finished' && p) {
            document.getElementById("finalScore").textContent = p.score || 0;
            document.getElementById("finalWpm").textContent = p.wpm || 0;
            document.getElementById("finalAccuracy").textContent = `${p.accuracy || 0}%`;
        }
    });
}

function startGame(session) {
    status = 'running';
    showView('game');
    renderPassage();
    setupTypingLogic();
    setupAntiCheat();
}

function renderPassage() {
    passageDisplay.innerHTML = "";
    passage.split("").forEach((char, i) => {
        const span = document.createElement("span");
        span.textContent = char;
        span.id = `char-${i}`;
        passageDisplay.appendChild(span);
    });
}

function setupTypingLogic() {
    typingArea.focus();
    typingArea.addEventListener("input", () => {
        const typed = typingArea.value.replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-");
        const currentLen = typed.length;

        // Anti-cheat: suspicious jumps
        if (currentLen - lastTypedLen > 60) {
            flags.suspiciousSpeed = true;
        }
        lastTypedLen = currentLen;

        let errors = 0;
        passage.split("").forEach((char, i) => {
            const span = document.getElementById(`char-${i}`);
            if (i < currentLen) {
                if (typed[i] === char) {
                    span.className = "char-correct";
                } else {
                    span.className = "char-error";
                    errors++;
                }
            } else if (i === currentLen) {
                span.className = "char-current";
            } else {
                span.className = "";
            }
        });

        // Auto-scroll passage box to keep current character visible
        const activeCharId = currentLen < passage.length ? `char-${currentLen}` : `char-${currentLen - 1}`;
        const activeSpan = document.getElementById(activeCharId);
        if (activeSpan) {
            const containerRect = passageDisplay.getBoundingClientRect();
            const spanRect = activeSpan.getBoundingClientRect();
            // If the active char is near the bottom or below the visible area, scroll down
            const offsetInContainer = spanRect.top - containerRect.top + passageDisplay.scrollTop;
            const targetScroll = offsetInContainer - containerRect.height / 2;
            passageDisplay.scrollTop = Math.max(0, targetScroll);
        }

        const progress = Math.min(100, Math.round((currentLen / passage.length) * 100));
        progressDisplay.textContent = `Progress: ${progress}%`;

        if (currentLen >= passage.length) {
            finishGame();
        }

        throttleUpdate(currentLen, errors);
    });
}

function throttleUpdate(len, err) {
    if (updateThrottleTimer) return;

    updateThrottleTimer = setTimeout(async () => {
        await updateDoc(doc(db, "typingSessions", sid, "players", uid), {
            typedLen: len,
            errors: err,
            lastUpdateMs: Date.now(),
            blurCount: blurCount,
            flags: flags
        });
        updateThrottleTimer = null;
    }, 2000); // 2 second throttle
}

function setupAntiCheat() {
    // Disable paste, cut, drop, contextmenu
    ['paste', 'cut', 'drop', 'contextmenu'].forEach(evt => {
        typingArea.addEventListener(evt, e => e.preventDefault());
    });

    // Block Ctrl+V / Cmd+V keyboard shortcut as secondary defense
    typingArea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
            e.preventDefault();
        }
    });

    // Detect blur
    window.addEventListener("blur", () => {
        blurCount++;
        syncMetaNow();
    });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            blurCount++;
            syncMetaNow();
        }
    });
}

async function syncMetaNow() {
    await updateDoc(doc(db, "typingSessions", sid, "players", uid), {
        blurCount: blurCount
    });
}

async function finishGame() {
    if (status === 'finished') return;
    status = 'finished';
    typingArea.disabled = true;
    lockOverlay.style.display = "flex";

    // Final update
    const typed = typingArea.value.replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-");
    let errors = 0;
    for (let i = 0; i < typed.length; i++) {
        if (typed[i] !== passage[i]) errors++;
    }

    await updateDoc(doc(db, "typingSessions", sid, "players", uid), {
        typedLen: typed.length,
        errors: errors,
        done: true,
        lastUpdateMs: Date.now(),
        blurCount: blurCount,
        flags: flags
    });

    setTimeout(() => showView('results'), 1500);
}

init();
