/**
 * pyMorseRunner — Front Login Page Controller
 */

"use strict";

(() => {
  const alertBox = document.getElementById("loginAlertBox");
  const loginBtn = document.getElementById("auth0LoginBtn");

  const ERROR_MESSAGES = {
    auth0_not_configured:
      "Authentication service is temporarily unavailable.",
    account_blocked:
      "Access Denied: Your operator account has been blocked by the Station Administrator.",
    kicked_or_expired:
      "Your session was terminated by the Administrator or has expired. Please sign in again.",
    token_exchange_failed:
      "Auth0 authentication handshake failed or expired. Please try signing in again.",
    missing_code: "Missing OAuth2 authorization code from identity provider.",
    access_denied: "Authentication was cancelled or denied by the identity provider.",
  };

  function showBanner(msg, isError = true) {
    if (!alertBox) return;
    alertBox.textContent = msg;
    alertBox.className = isError ? "login-alert login-alert-error" : "login-alert login-alert-ok";
    alertBox.hidden = false;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get("next") === "/admin" && loginBtn) {
    loginBtn.href = "/auth/login?next=/admin";
  }
  const rawErrKey = params.get("error");
  if (rawErrKey) {
    const errKey = rawErrKey.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
    showBanner(ERROR_MESSAGES[errKey] || `Authentication error: ${errKey}`, true);
  } else if (params.get("logged_out") === "1") {
    showBanner("You have been signed out safely. 73!", false);
  }

  fetch("/api/auth/status")
    .then((r) => r.json())
    .then((status) => {
      if (!status.configured && loginBtn) {
        loginBtn.classList.add("btn-disabled");
      }
    })
    .catch(() => {});
})();
