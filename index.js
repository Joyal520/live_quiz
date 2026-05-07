import { bindExitFullscreenButtons, enterFullscreen } from "./fullscreen.js";

const appLinks = document.querySelectorAll("[data-app-route]");
let appFrame = null;

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
    link.addEventListener("click", async (event) => {
        event.preventDefault();
        await enterFullscreen();
        openAppRoute(link.href);
    });
});

bindExitFullscreenButtons();
