function getParentDocument() {
    try {
        if (window.parent && window.parent !== window) {
            return window.parent.document;
        }
    } catch {
        // Cross-origin parents cannot be inspected; fall back to this document.
    }
    return null;
}

function getFullscreenDocument() {
    if (document.fullscreenElement) return document;

    const parentDocument = getParentDocument();
    if (parentDocument?.fullscreenElement) return parentDocument;

    return null;
}

export function isFullscreenActive() {
    return Boolean(getFullscreenDocument());
}

export async function enterFullscreen() {
    const root = document.documentElement;

    if (!document.fullscreenElement && !getFullscreenDocument() && root.requestFullscreen) {
        try {
            await root.requestFullscreen();
            return true;
        } catch (error) {
            console.warn("Fullscreen request failed:", error);
            return false;
        }
    }

    return true;
}

export async function exitFullscreen() {
    const fullscreenDocument = getFullscreenDocument() || document;

    if (fullscreenDocument.fullscreenElement && fullscreenDocument.exitFullscreen) {
        try {
            await fullscreenDocument.exitFullscreen();
        } catch (error) {
            console.warn("Fullscreen exit failed:", error);
        }
    }
}

export function bindExitFullscreenButtons(selector = ".exitFullscreenBtn") {
    const buttons = Array.from(document.querySelectorAll(selector));
    if (!buttons.length) return;

    const updateButtons = () => {
        const active = isFullscreenActive();
        buttons.forEach((button) => {
            button.hidden = !active;
            if (!button.textContent.trim()) {
                button.textContent = "Exit Fullscreen";
            }
            button.setAttribute("aria-label", "Exit Fullscreen");
        });
    };

    buttons.forEach((button) => {
        button.addEventListener("click", exitFullscreen);
    });

    document.addEventListener("fullscreenchange", updateButtons);

    const parentDocument = getParentDocument();
    if (parentDocument) {
        parentDocument.addEventListener("fullscreenchange", updateButtons);
    }

    updateButtons();
}
