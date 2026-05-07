import { db, TS, Fire } from "./firebase.js";
const { collection, addDoc } = Fire;

const quizInput = document.getElementById("quizInput");
const importBtn = document.getElementById("importBtn");
const statusDiv = document.getElementById("status");

function setStatus(msg, type = "info") {
    statusDiv.textContent = msg;
    statusDiv.style.color =
        type === "error" ? "var(--accent-error)" :
            type === "success" ? "var(--accent-success)" :
                "var(--text-bright)";
}

importBtn.addEventListener("click", async () => {
    const text = quizInput.value.trim();
    if (!text) return setStatus("Please paste some quiz data first!", "error");

    try {
        setStatus("Parsing quiz data...", "info");
        const quizData = parseEQM(text);

        if (!quizData.questions || quizData.questions.length === 0) {
            throw new Error("No questions found. Check your format!");
        }

        const noAnswer = quizData.questions.filter(q => q.correctIndex === -1);
        if (noAnswer.length > 0) {
            throw new Error(`${noAnswer.length} question(s) have no correct answer marked with *. Please mark the correct answer with * (e.g. A: Paris*)`);
        }

        setStatus(`Saving "${quizData.title}" to Firestore...`, "info");

        const docRef = await addDoc(collection(db, "quizzes"), {
            ...quizData,
            createdAt: TS()
        });

        setStatus(`✅ Success! Quiz "${quizData.title}" is ready. Redirecting...`, "success");
        setTimeout(() => {
            window.location.href = `host.html?quizId=${docRef.id}`;
        }, 1500);

    } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`, "error");
    }
});

/**
 * Parse EQM (EdTechra Quiz Markup) format.
 *
 * Supported question prefixes:  Q:  Q1:  1.  1)  Question:
 * Supported answer prefixes:    A:  A)  a)  a.  A.  B)  B.  1)  -
 * Correct answer: mark with *  anywhere in the answer text, or (correct) / [correct]
 *
 * Example:
 *   TITLE: My Quiz
 *   Q: What is 2+2?
 *   A: 3
 *   A: 4*
 *   A: 5
 *   A: 22
 */
function parseEQM(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
    let title = "Untitled Quiz";
    const questions = [];
    let currentQ = null;

    // Strip markdown bold/italic and leading numbering from text
    const stripMd = s => s
        .replace(/\*\*/g, "")
        .replace(/^\*+|\*+$/g, "")
        .replace(/^__(.+)__$/, "$1")
        .trim();

    // Detect question lines
    const isQuestionLine = l =>
        /^Q\s*\d*\s*[:.]/i.test(l) ||           // Q:  Q1:  Q.
        /^QUESTION\s*\d*\s*[:.]/i.test(l) ||    // Question:
        /^\d+\s*[.:]\s+\S/.test(l);             // 1. text  or  1: text (must have space + char after)

    // Detect answer lines (must start with known prefix, optional leading *)
    const isAnswerLine = l =>
        /^[\*]?\s*[A-Da-d]\s*[):.\-]\s/.test(l) ||      // *A)  A:  a.  B)
        /^[\*]?\s*A:\s/i.test(l) ||                     // *A:
        /^[\*]?\s*ANS(WER)?\s*:\s/i.test(l) ||          // *ANSWER:  *ANS:
        /^[\*]?\s*-\s/.test(l) ||                       // *-  (bullet)
        /^\*\s/.test(l);                                // * (marker only)

    for (const line of lines) {
        // TITLE
        if (/^TITLE:/i.test(line)) {
            title = stripMd(line.replace(/^TITLE:\s*/i, ""));
        }
        // QUESTION
        else if (isQuestionLine(line)) {
            if (currentQ) questions.push(currentQ);
            // Remove all common question prefixes
            const qText = line
                .replace(/^Q\s*\d*\s*[:.]\s*/i, "")
                .replace(/^QUESTION\s*\d*\s*[:.]\s*/i, "")
                .replace(/^\d+\s*[.:]\s*/, "")
                .trim();
            currentQ = { question: stripMd(qText), options: [], correctIndex: -1 };
        }
        // ANSWER
        else if (isAnswerLine(line) && currentQ) {
            // Remove the answer prefix (including optional leading *)
            let ans = line
                .replace(/^[\*]?\s*[A-Da-d]\s*[):.\-]\s*/i, "")
                .replace(/^[\*]?\s*A:\s*/i, "")
                .replace(/^[\*]?\s*ANS(WER)?\s*:\s*/i, "")
                .replace(/^[\*]?\s*-\s*/, "")
                .replace(/^\*\s*/, "")
                .trim();

            // Detect correct marker before stripping
            const isCorrect =
                line.trimStart().charAt(0) === "*" ||   // line starts with *
                ans.startsWith("*") ||
                ans.endsWith("*") ||
                /\(correct\)/i.test(ans) ||
                /\[correct\]/i.test(ans);

            // Clean correct markers from answer text
            ans = ans
                .replace(/^\*+|\*+$/g, "")
                .replace(/\s*\(correct\)\s*/i, "")
                .replace(/\s*\[correct\]\s*/i, "")
                .trim();

            ans = stripMd(ans);

            if (isCorrect) currentQ.correctIndex = currentQ.options.length;
            currentQ.options.push(ans);
        }
        // All other lines (blank separators, decorators) are silently skipped
    }

    if (currentQ) questions.push(currentQ);
    return { title, questions };
}
