import { db, ensureAnonAuth, Fire } from "./firebase.js";

const { collection, getDocs, doc, deleteDoc } = Fire;

const quizGrid = document.getElementById("quizGrid");
const pageStatus = document.getElementById("pageStatus");
const quizSearch = document.getElementById("quizSearch");
let quizzes = [];

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setStatus(message = "", type = "info") {
  if (!pageStatus) return;
  pageStatus.textContent = message;
  pageStatus.style.color = type === "error" ? "#fca5a5" : type === "success" ? "#86efac" : "rgba(235,238,255,0.72)";
}

function formatDate(value) {
  if (!value) return "Not recorded";
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function loadQuizzes() {
  setStatus("Loading your quizzes...");
  try {
    await ensureAnonAuth();
    const snap = await getDocs(collection(db, "quizzes"));
    quizzes = [];
    snap.forEach((item) => {
      const data = item.data();
      quizzes.push({
        id: item.id,
        title: data.title || "Untitled",
        questionCount: Array.isArray(data.questions) ? data.questions.length : 0,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        source: data.source || "teacher-created"
      });
    });
    renderQuizzes();
  } catch (error) {
    console.error("[LiveQuiz] Teacher quizzes load failed", error);
    setStatus("Could not load quizzes. Check Firebase and try again.", "error");
  }
}

function getVisibleQuizzes() {
  const term = (quizSearch?.value || "").trim().toLowerCase();
  return quizzes
    .filter((item) => item.source !== "all-quizzes")
    .filter((item) => !term || item.title.toLowerCase().includes(term));
}

function renderQuizzes() {
  if (!quizGrid) return;
  const visible = getVisibleQuizzes();
  quizGrid.innerHTML = visible.map((item) => `
    <article class="quiz-card" style="--accent:#1268ff">
      <div class="topic-icon"><i data-lucide="folder-open"></i></div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${item.questionCount} question${item.questionCount === 1 ? "" : "s"} ready for your next live session.</p>
      <div class="meta-row">
        <span class="badge">${item.questionCount} questions</span>
        <span class="badge">Created: ${escapeHtml(formatDate(item.createdAt))}</span>
        <span class="badge">Updated: ${escapeHtml(formatDate(item.updatedAt))}</span>
      </div>
      <div class="form-actions">
        <button type="button" class="primary-pill blue" data-select-quiz="${escapeHtml(item.id)}">
          Select
          <i data-lucide="chevron-right"></i>
        </button>
        <a class="ghost-pill" href="create-quiz.html">
          <i data-lucide="pencil"></i>
          Edit
        </a>
        <button type="button" class="danger-pill" data-delete-quiz="${escapeHtml(item.id)}">
          <i data-lucide="trash-2"></i>
          Delete
        </button>
      </div>
    </article>
  `).join("");
  setStatus(visible.length ? "" : "No teacher-created quizzes found yet.");
  if (window.lucide) window.lucide.createIcons();
}

function selectQuiz(id) {
  const selected = quizzes.find((item) => item.id === id);
  if (!selected) return;

  console.info("[LiveQuiz][YourQuizzes] Selected quiz:", selected.id, selected.title);

  // Persist selection when storage is available (may be blocked by iframe sandbox)
  try {
    localStorage.setItem("edtechra_selected_quiz", JSON.stringify({
      id: selected.id,
      title: selected.title,
      source: "teacher-created",
      questionCount: selected.questionCount
    }));
    console.info("[LiveQuiz][YourQuizzes] localStorage: available, selection stored");
  } catch {
    console.warn("[LiveQuiz][YourQuizzes] localStorage: unavailable (sandboxed iframe), skipping storage");
  }

  // URL query param is the primary transport — host.js reads quizId from URL first
  const targetUrl = `host.html?quizId=${encodeURIComponent(selected.id)}`;
  console.info("[LiveQuiz][YourQuizzes] Target host URL:", targetUrl);

  // Notify parent frame (Edtechra classroom) about the quiz selection
  if (window.parent !== window) {
    try {
      window.parent.postMessage({
        type: "livequiz:select",
        quizId: selected.id,
        title: selected.title,
        source: "teacher-created",
        questionCount: selected.questionCount,
        navigateTo: targetUrl
      }, "*");
      console.info("[LiveQuiz][YourQuizzes] postMessage sent to parent frame");
    } catch (err) {
      console.warn("[LiveQuiz][YourQuizzes] postMessage to parent failed:", err);
    }
  }

  // Navigate within the current iframe (safe even when sandbox blocks top navigation)
  window.location.href = targetUrl;
}

async function deleteQuiz(id) {
  const selected = quizzes.find((item) => item.id === id);
  if (!selected) return;
  if (!confirm(`Delete "${selected.title}"?`)) return;

  setStatus("Deleting quiz...");
  try {
    await deleteDoc(doc(db, "quizzes", id));
    quizzes = quizzes.filter((item) => item.id !== id);
    renderQuizzes();
    setStatus("Quiz deleted.", "success");
  } catch (error) {
    console.error("[LiveQuiz] Quiz delete failed", error);
    setStatus("Could not delete this quiz. Check Firebase and try again.", "error");
  }
}

quizSearch?.addEventListener("input", renderQuizzes);
quizGrid?.addEventListener("click", (event) => {
  const selectBtn = event.target.closest("[data-select-quiz]");
  const deleteBtn = event.target.closest("[data-delete-quiz]");
  if (selectBtn) selectQuiz(selectBtn.dataset.selectQuiz);
  if (deleteBtn) deleteQuiz(deleteBtn.dataset.deleteQuiz);
});

loadQuizzes();
