import { db, ensureAnonAuth, Fire, TS } from "./firebase.js";

const { collection, addDoc } = Fire;

const createQuizForm = document.getElementById("createQuizForm");
const quizTitleInput = document.getElementById("quizTitleInput");
const creationMode = document.getElementById("creationMode");
const manualModeForm = document.getElementById("manualModeForm");
const aiModeForm = document.getElementById("aiModeForm");
const questionList = document.getElementById("questionList");
const addQuestionBtn = document.getElementById("addQuestionBtn");
const saveQuizBtn = document.getElementById("saveQuizBtn");
const createStatus = document.getElementById("createStatus");
const aiTopicInput = document.getElementById("aiTopicInput");
const aiQuestionCountInput = document.getElementById("aiQuestionCountInput");
const aiPromptText = document.getElementById("aiPromptText");
const copyAiPromptBtn = document.getElementById("copyAiPromptBtn");

let questionKey = 0;

function setStatus(message = "", type = "info") {
  if (!createStatus) return;
  createStatus.textContent = message;
  createStatus.style.color = type === "error" ? "#fca5a5" : type === "success" ? "#86efac" : "rgba(235,238,255,0.72)";
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function createQuestionCard(values = {}) {
  const key = questionKey++;
  const card = document.createElement("section");
  card.className = "question-card";
  card.innerHTML = `
    <div class="toolbar" style="margin:0">
      <strong class="question-label">Question</strong>
      <button type="button" class="danger-pill remove-question-btn">
        <i data-lucide="trash-2"></i>
        Remove
      </button>
    </div>
    <textarea class="question-input" placeholder="Enter question text...">${escapeHtml(values.question || "")}</textarea>
    <div class="option-grid">
      ${[0, 1, 2, 3].map((index) => `
        <label class="option-row">
          <input class="field option-input" type="text" placeholder="Option ${index + 1}" value="${escapeHtml(values.options?.[index] || "")}" />
          <span class="correct-choice">
            <input type="radio" name="correct-${key}" value="${index}" ${index === (values.correctIndex ?? 0) ? "checked" : ""} />
            Correct
          </span>
        </label>
      `).join("")}
    </div>
  `;

  card.querySelector(".remove-question-btn")?.addEventListener("click", () => {
    if ((questionList?.querySelectorAll(".question-card").length || 0) <= 1) return;
    card.remove();
    refreshQuestionLabels();
  });

  return card;
}

function refreshQuestionLabels() {
  questionList?.querySelectorAll(".question-card").forEach((card, index) => {
    const label = card.querySelector(".question-label");
    if (label) label.textContent = `Question ${index + 1}`;
  });
  if (window.lucide) window.lucide.createIcons();
}

function addQuestion(values = {}, focus = false) {
  if (!questionList) return;
  const card = createQuestionCard(values);
  questionList.appendChild(card);
  refreshQuestionLabels();
  if (focus) card.querySelector(".question-input")?.focus();
}

function collectQuiz() {
  const title = quizTitleInput?.value.trim() || "";
  if (!title) {
    quizTitleInput?.focus();
    setStatus("Please enter a quiz title.", "error");
    return null;
  }

  const cards = Array.from(questionList?.querySelectorAll(".question-card") || []);
  const questions = [];

  for (let index = 0; index < cards.length; index++) {
    const card = cards[index];
    const questionInput = card.querySelector(".question-input");
    const optionInputs = Array.from(card.querySelectorAll(".option-input"));
    const question = questionInput?.value.trim() || "";
    const options = optionInputs.map((input) => input.value.trim());
    const correctIndex = Number(card.querySelector("input[type='radio']:checked")?.value ?? 0);

    if (!question) {
      questionInput?.focus();
      setStatus(`Please enter text for question ${index + 1}.`, "error");
      return null;
    }

    const firstEmpty = optionInputs.find((input) => !input.value.trim());
    if (firstEmpty) {
      firstEmpty.focus();
      setStatus(`Please enter all 4 answer options for question ${index + 1}.`, "error");
      return null;
    }

    questions.push({ question, options, correctIndex });
  }

  return { title, questions };
}

function buildAiPrompt() {
  const count = Math.min(30, Math.max(1, parseInt(aiQuestionCountInput?.value || "10", 10) || 10));
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

function setMode(mode) {
  const isAi = mode === "ai";
  if (manualModeForm) manualModeForm.style.display = isAi ? "none" : "grid";
  if (aiModeForm) aiModeForm.style.display = isAi ? "grid" : "none";
  if (isAi) updateAiPrompt();
}

async function saveQuiz(event) {
  event.preventDefault();
  if (creationMode?.value === "ai") {
    setStatus("Copy the AI prompt or open the importer to create this quiz.", "info");
    return;
  }

  const quizData = collectQuiz();
  if (!quizData) return;

  saveQuizBtn.disabled = true;
  setStatus("Saving quiz...");
  try {
    await ensureAnonAuth();
    const ref = await addDoc(collection(db, "quizzes"), {
      ...quizData,
      source: "teacher-created",
      createdAt: TS(),
      updatedAt: TS()
    });

    localStorage.setItem("edtechra_selected_quiz", JSON.stringify({
      id: ref.id,
      title: quizData.title,
      source: "teacher-created",
      questionCount: quizData.questions.length
    }));
    setStatus(`Saved "${quizData.title}". Returning to preparation...`, "success");
    window.setTimeout(() => {
      window.location.href = `host.html?quizId=${encodeURIComponent(ref.id)}`;
    }, 500);
  } catch (error) {
    console.error("[LiveQuiz] Quiz save failed", error);
    setStatus("Could not save this quiz. Check Firebase and try again.", "error");
  } finally {
    saveQuizBtn.disabled = false;
  }
}

creationMode?.addEventListener("change", () => setMode(creationMode.value));
addQuestionBtn?.addEventListener("click", () => addQuestion({}, true));
createQuizForm?.addEventListener("submit", saveQuiz);
aiTopicInput?.addEventListener("input", updateAiPrompt);
aiQuestionCountInput?.addEventListener("input", updateAiPrompt);
copyAiPromptBtn?.addEventListener("click", async () => {
  updateAiPrompt();
  try {
    await navigator.clipboard.writeText(aiPromptText?.value || "");
    setStatus("Prompt copied.", "success");
  } catch {
    aiPromptText?.focus();
    aiPromptText?.select();
    setStatus("Select and copy the prompt.", "error");
  }
});

addQuestion();
setMode("manual");
if (window.lucide) window.lucide.createIcons();
