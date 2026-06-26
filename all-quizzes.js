import { db, ensureAnonAuth, Fire, TS } from "./firebase.js";

const { doc, setDoc } = Fire;

const categories = ["All", "Grammar", "Vocabulary", "ICT", "Science", "General Knowledge", "AI", "Reading", "Life Skills"];
const quizGrid = document.getElementById("quizGrid");
const pageStatus = document.getElementById("pageStatus");
const quizSearch = document.getElementById("quizSearch");
const categoryFilters = document.getElementById("categoryFilters");

const readyMadeQuizzes = [
  quiz("basic-grammar", "Basic Grammar", "Grammar", "Easy", "#9d35ff", "Practice nouns, verbs, articles, and simple sentence rules."),
  quiz("tenses-quiz", "Tenses Quiz", "Grammar", "Medium", "#7c3aed", "Review present, past, and future tense patterns."),
  quiz("parts-of-speech", "Parts of Speech", "Grammar", "Easy", "#a855f7", "Identify nouns, verbs, adjectives, and adverbs."),
  quiz("vocabulary-sprint", "Vocabulary Sprint", "Vocabulary", "Easy", "#e92c8f", "Build confidence with useful everyday words."),
  quiz("ict-basics", "ICT Basics", "ICT", "Easy", "#1268ff", "Explore computers, devices, software, and online tools."),
  quiz("ai-basics", "AI Basics", "AI", "Medium", "#22d3ee", "Introduce artificial intelligence and smart systems."),
  quiz("solar-system", "Solar System", "Science", "Medium", "#f7b733", "Learn planets, moons, orbits, and space facts."),
  quiz("human-body", "Human Body", "Science", "Medium", "#19c878", "Review organs, body systems, and healthy habits."),
  quiz("reading-check", "Reading Check", "Reading", "Easy", "#60a5fa", "Practice comprehension with short passage questions."),
  quiz("life-skills", "Life Skills", "Life Skills", "Easy", "#f97316", "Discuss choices, teamwork, safety, and responsibility."),
  quiz("internet-safety", "Internet Safety", "ICT", "Easy", "#38bdf8", "Learn passwords, privacy, scams, and safe browsing."),
  quiz("computer-parts", "Computer Parts", "ICT", "Easy", "#2563eb", "Identify common computer hardware and uses."),
  quiz("python-basics", "Python Basics", "ICT", "Medium", "#10b981", "Start with variables, output, and simple code ideas."),
  quiz("world-facts", "World Facts", "General Knowledge", "Medium", "#f59e0b", "Explore countries, landmarks, cultures, and records."),
  quiz("environment-quiz", "Environment Quiz", "Science", "Medium", "#22c55e", "Review ecosystems, pollution, recycling, and climate.")
];

let activeCategory = "All";

function quiz(id, title, category, difficulty, accent, description) {
  return {
    id,
    title,
    category,
    difficulty,
    accent,
    description,
    questions: buildQuestions(title, category)
  };
}

function buildQuestions(title, category) {
  return Array.from({ length: 10 }, (_, index) => ({
    question: `${title}: question ${index + 1}`,
    options: [
      `${category} answer A`,
      `${category} answer B`,
      `${category} answer C`,
      `${category} answer D`
    ],
    correctIndex: index % 4
  }));
}

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

function renderFilters() {
  if (!categoryFilters) return;
  categoryFilters.innerHTML = categories.map((category) => `
    <button type="button" class="filter-chip ${category === activeCategory ? "active" : ""}" data-category="${escapeHtml(category)}">
      ${escapeHtml(category)}
    </button>
  `).join("");
}

function getVisibleQuizzes() {
  const term = (quizSearch?.value || "").trim().toLowerCase();
  return readyMadeQuizzes.filter((item) => {
    const matchesCategory = activeCategory === "All" || item.category === activeCategory;
    const matchesSearch = !term || [item.title, item.description, item.category].join(" ").toLowerCase().includes(term);
    return matchesCategory && matchesSearch;
  });
}

function renderQuizzes() {
  if (!quizGrid) return;
  const items = getVisibleQuizzes();
  quizGrid.innerHTML = items.map((item) => `
    <article class="quiz-card" style="--accent:${item.accent}">
      <div class="topic-icon"><i data-lucide="${iconForCategory(item.category)}"></i></div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.description)}</p>
      <div class="meta-row">
        <span class="badge">${item.questions.length} questions</span>
        <span class="badge">${escapeHtml(item.difficulty)}</span>
        <span class="badge">${escapeHtml(item.category)}</span>
      </div>
      <button type="button" class="primary-pill" data-use-quiz="${escapeHtml(item.id)}">
        Use Quiz
        <i data-lucide="chevron-right"></i>
      </button>
    </article>
  `).join("");
  setStatus(items.length ? "" : "No quizzes match your search.");
  if (window.lucide) window.lucide.createIcons();
}

function iconForCategory(category) {
  const icons = {
    Grammar: "book-open",
    Vocabulary: "spell-check",
    ICT: "monitor",
    Science: "flask-conical",
    "General Knowledge": "globe",
    AI: "bot",
    Reading: "book-marked",
    "Life Skills": "users"
  };
  return icons[category] || "sparkles";
}

async function useQuiz(id) {
  const selected = readyMadeQuizzes.find((item) => item.id === id);
  if (!selected) return;

  setStatus(`Preparing "${selected.title}"...`);
  try {
    await ensureAnonAuth();
    await setDoc(doc(db, "quizzes", selected.id), {
      title: selected.title,
      description: selected.description,
      category: selected.category,
      difficulty: selected.difficulty,
      questions: selected.questions,
      source: "all-quizzes",
      updatedAt: TS()
    }, { merge: true });

    console.info("[LiveQuiz][AllQuizzes] Selected quiz:", selected.id, selected.title);

    // Persist selection when storage is available (may be blocked by iframe sandbox)
    try {
      localStorage.setItem("edtechra_selected_quiz", JSON.stringify({
        id: selected.id,
        title: selected.title,
        source: "all-quizzes",
        questionCount: selected.questions.length
      }));
      console.info("[LiveQuiz][AllQuizzes] localStorage: available, selection stored");
    } catch {
      console.warn("[LiveQuiz][AllQuizzes] localStorage: unavailable (sandboxed iframe), skipping storage");
    }

    // URL query param is the primary transport — host.js reads quizId from URL first
    const targetUrl = `host.html?quizId=${encodeURIComponent(selected.id)}`;
    console.info("[LiveQuiz][AllQuizzes] Target host URL:", targetUrl);

    // Notify parent frame (Edtechra classroom) about the quiz selection
    if (window.parent !== window) {
      try {
        window.parent.postMessage({
          type: "livequiz:select",
          quizId: selected.id,
          title: selected.title,
          source: "all-quizzes",
          questionCount: selected.questions.length,
          navigateTo: targetUrl
        }, "*");
        console.info("[LiveQuiz][AllQuizzes] postMessage sent to parent frame");
      } catch (err) {
        console.warn("[LiveQuiz][AllQuizzes] postMessage to parent failed:", err);
      }
    }

    // Navigate within the current iframe (safe even when sandbox blocks top navigation)
    window.location.href = targetUrl;
  } catch (error) {
    console.error("[LiveQuiz] Ready-made quiz select failed", error);
    setStatus("Could not select this quiz. Check Firebase and try again.", "error");
  }
}

categoryFilters?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  activeCategory = button.dataset.category || "All";
  renderFilters();
  renderQuizzes();
});

quizSearch?.addEventListener("input", renderQuizzes);

quizGrid?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-use-quiz]");
  if (button) useQuiz(button.dataset.useQuiz);
});

renderFilters();
renderQuizzes();
