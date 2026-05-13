import { bindExitFullscreenButtons, enterFullscreen } from "./fullscreen.js";
import { initializeEdectraLaunchContext } from "./edectra-context.js";
import { clearForceHomepageNavigation, clearHomeNavigationState, isForceHomepageNavigation } from "./navigation.js";

initializeEdectraLaunchContext();

const appLinks = document.querySelectorAll("[data-app-route]");
const quitAppBtn = document.getElementById("quitAppBtn");
let appFrame = null;
let activeModal = null;
const forceHomepageNavigation = isForceHomepageNavigation();

if (forceHomepageNavigation) {
    clearForceHomepageNavigation();
    clearHomeNavigationState();
}

function isFullscreenActive() {
    return Boolean(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.msFullscreenElement
    );
}

function closePremiumModal() {
    if (!activeModal) return;

    const modal = activeModal;
    activeModal = null;
    modal.classList.remove("is-visible");
    window.setTimeout(() => modal.remove(), 180);
}

function showPremiumModal({ title, message, primaryText, secondaryText, primaryClass = "primary", onPrimary, onSecondary }) {
    closePremiumModal();

    const overlay = document.createElement("div");
    overlay.className = "premium-modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
        <div class="premium-modal">
            <h2>${title}</h2>
            <p>${message}</p>
            <div class="premium-modal-actions">
                <button type="button" class="premium-modal-btn secondary" data-modal-secondary>${secondaryText}</button>
                <button type="button" class="premium-modal-btn ${primaryClass}" data-modal-primary>${primaryText}</button>
            </div>
        </div>
    `;

    overlay.querySelector("[data-modal-primary]")?.addEventListener("click", () => {
        closePremiumModal();
        onPrimary?.();
    });
    overlay.querySelector("[data-modal-secondary]")?.addEventListener("click", () => {
        closePremiumModal();
        onSecondary?.();
    });

    document.body.appendChild(overlay);
    activeModal = overlay;
    requestAnimationFrame(() => overlay.classList.add("is-visible"));
}

function showInfoModal(title, message) {
    showPremiumModal({
        title,
        message,
        primaryText: "OK",
        secondaryText: "Stay",
        onPrimary: () => {},
        onSecondary: () => {}
    });
}

function promptForFullscreen() {
    if (sessionStorage.getItem("fullscreenPromptDismissed") === "true" || isFullscreenActive()) {
        return;
    }

    showPremiumModal({
        title: "Better in Full Screen",
        message: "Would you like to enable full screen for a better experience?",
        primaryText: "Yes",
        secondaryText: "No",
        onPrimary: async () => {
            sessionStorage.setItem("fullscreenPromptDismissed", "true");
            const didEnterFullscreen = await enterFullscreen();
            if (!didEnterFullscreen && !isFullscreenActive()) {
                showInfoModal("Full Screen Blocked", "Your browser blocked full screen. You can continue normally.");
            }
        },
        onSecondary: () => {
            sessionStorage.setItem("fullscreenPromptDismissed", "true");
        }
    });
}

function ensureAppFrame() {
    if (appFrame) return appFrame;

    appFrame = document.createElement("iframe");
    appFrame.id = "appShellFrame";
    appFrame.className = "app-shell-frame";
    appFrame.title = "EdTechra App";
    appFrame.setAttribute("allow", "fullscreen");
    appFrame.allowFullscreen = true;
    document.body.appendChild(appFrame);

    return appFrame;
}

function openAppRoute(url) {
    const frame = ensureAppFrame();
    document.body.classList.add("app-shell-active");
    frame.src = url;
}

appLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
        event.preventDefault();
        openAppRoute(link.href);
    });
});

quitAppBtn?.addEventListener("click", () => {
    showPremiumModal({
        title: "Quit EdTechra?",
        message: "You can close this tab, or return later to continue.",
        primaryText: "Close Tab",
        secondaryText: "Stay",
        primaryClass: "danger",
        onPrimary: () => {
            window.close();
            window.setTimeout(() => {
                if (!window.closed) {
                    showInfoModal("Close Tab", "Your browser blocked automatic closing. Please close this tab manually.");
                }
            }, 180);
        },
        onSecondary: () => {}
    });
});

bindExitFullscreenButtons();
if (!forceHomepageNavigation) {
    promptForFullscreen();
}
