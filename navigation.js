const HOST_SESSION_KEY = "edtechra.hostSession";
const FORCE_HOMEPAGE_NAVIGATION_KEY = "forceHomepageNavigation";

export function isForceHomepageNavigation() {
    try {
        return sessionStorage.getItem(FORCE_HOMEPAGE_NAVIGATION_KEY) === "true";
    } catch {
        return false;
    }
}

export function clearForceHomepageNavigation() {
    try {
        sessionStorage.removeItem(FORCE_HOMEPAGE_NAVIGATION_KEY);
    } catch {
        // Storage can be unavailable in restrictive browser modes.
    }
}

export function clearHomeNavigationState() {
    try {
        sessionStorage.removeItem(HOST_SESSION_KEY);
        localStorage.removeItem(HOST_SESSION_KEY);
    } catch {
        // Storage can be unavailable in restrictive browser modes.
    }
}

export function goHomeSafely() {
    try {
        sessionStorage.setItem(FORCE_HOMEPAGE_NAVIGATION_KEY, "true");
        clearHomeNavigationState();
        if (window.top && window.top !== window) {
            window.top.location.replace("index.html");
            return;
        }
        window.location.replace("index.html");
    } catch (err) {
        console.error("Safe navigation failed", err);
        window.location.href = "index.html";
    }
}
