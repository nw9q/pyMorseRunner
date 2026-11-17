/**
 * pyMorseRunner — Station Administration Controller
 */

"use strict";

(() => {
  const adminUsersBody = document.getElementById("adminUsersBody");
  const adminBanner = document.getElementById("adminBanner");
  const adminSelfBadge = document.getElementById("adminSelfBadge");
  const refreshUsersBtn = document.getElementById("refreshUsersBtn");
  const lastUpdatedLabel = document.getElementById("lastUpdatedLabel");

  const statTotalUsers = document.getElementById("statTotalUsers");
  const statActiveSessions = document.getElementById("statActiveSessions");
  const statAdmins = document.getElementById("statAdmins");
  const statBlocked = document.getElementById("statBlocked");

  let csrfToken = "";
  let selfSub = "";

  function showBanner(msg, isError = false) {
    if (!adminBanner) return;
    adminBanner.textContent = msg;
    adminBanner.className = isError
      ? "login-alert login-alert-error"
      : "login-alert login-alert-ok";
    adminBanner.hidden = false;
  }

  async function initAdmin() {
    try {
      const meResp = await fetch("/api/me");
      if (meResp.status === 401) {
        window.location.href = "/login";
        return;
      }
      const meData = await meResp.json();
      csrfToken = meData.csrfToken || "";
      if (meData.user) {
        selfSub = meData.user.sub;
        adminSelfBadge.textContent = `${meData.user.name} (${meData.user.role.toUpperCase()})`;
      }
      await loadUsers();
    } catch (_e) {
      showBanner("Failed to load administrator session.", true);
    }
  }

  async function loadUsers() {
    const resp = await fetch("/api/admin/users");
    if (resp.status === 401) {
      window.location.href = "/login?error=kicked_or_expired";
      return;
    }
    if (resp.status === 403) {
      window.location.href = "/";
      return;
    }
    const data = await resp.json();
    if (data.selfSub) selfSub = data.selfSub;
    renderUsers(data.users || []);
    lastUpdatedLabel.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  function createMetaLine(label, value) {
    const div = document.createElement("div");
    div.className = "meta-line";
    const spanLbl = document.createElement("span");
    spanLbl.className = "meta-lbl";
    spanLbl.textContent = `${label}: `;
    const spanVal = document.createElement("span");
    spanVal.textContent = value;
    div.append(spanLbl, spanVal);
    return div;
  }

  function renderUsers(users) {
    adminUsersBody.textContent = "";

    let activeSessTotal = 0;
    let adminCount = 0;
    let blockedCount = 0;

    for (const u of users) {
      activeSessTotal += Number(u.active_sessions || 0);
      if (u.role === "admin") adminCount++;
      if (u.blocked) blockedCount++;

      const tr = document.createElement("tr");

      // 1. Operator / Email
      const tdOp = document.createElement("td");
      const nameStrong = document.createElement("strong");
      nameStrong.textContent = u.name || "Operator";
      tdOp.appendChild(nameStrong);
      if (u.sub === selfSub) {
        const youBadge = document.createElement("span");
        youBadge.className = "badge-pill badge-accent";
        youBadge.textContent = "YOU";
        tdOp.appendChild(youBadge);
      }
      tdOp.appendChild(createMetaLine("Email", `${u.email || "N/A"}${u.email_verified ? " (verified)" : ""}`));
      if (u.nickname) {
        tdOp.appendChild(createMetaLine("Nickname", u.nickname));
      }

      // 2. Role & Status
      const tdStatus = document.createElement("td");
      const roleBadge = document.createElement("span");
      roleBadge.className = u.role === "admin" ? "badge-pill badge-accent" : "badge-pill";
      roleBadge.textContent = (u.role || "user").toUpperCase();
      const stateBadge = document.createElement("span");
      stateBadge.className = u.blocked
        ? "badge-pill badge-danger"
        : u.active_sessions > 0
        ? "badge-pill badge-success"
        : "badge-pill";
      stateBadge.textContent = u.blocked
        ? "BLOCKED"
        : u.active_sessions > 0
        ? `ONLINE (${u.active_sessions})`
        : "OFFLINE";
      tdStatus.append(roleBadge, document.createElement("br"), stateBadge);

      // 3. Auth0 Sub & IdP
      const tdIdp = document.createElement("td");
      tdIdp.appendChild(createMetaLine("Sub", u.sub || ""));
      tdIdp.appendChild(createMetaLine("Provider", u.provider || "auth0"));
      if (u.locale) tdIdp.appendChild(createMetaLine("Locale", u.locale));

      // 4. Contest Telemetry
      const tdContest = document.createElement("td");
      tdContest.appendChild(createMetaLine("Last Call", u.last_callsign || "N0CALL"));
      tdContest.appendChild(createMetaLine("Runs", String(u.total_runs || 0)));
      tdContest.appendChild(createMetaLine("Best Score", String(u.best_score || 0)));

      // 5. Session & Network Metadata
      const tdNet = document.createElement("td");
      tdNet.appendChild(createMetaLine("Logins", String(u.login_count || 1)));
      tdNet.appendChild(createMetaLine("Last IP", u.last_ip || "unknown"));
      tdNet.appendChild(createMetaLine("UA", (u.user_agent || "unknown").slice(0, 56)));

      // 6. Timestamps
      const tdTime = document.createElement("td");
      tdTime.appendChild(createMetaLine("First", u.first_login_utc || "-"));
      tdTime.appendChild(createMetaLine("Last Login", u.last_login_utc || "-"));
      tdTime.appendChild(createMetaLine("Last Seen", u.last_seen_utc || "-"));
      if (u.kicked_at) {
        tdTime.appendChild(createMetaLine("Last Kick", u.kicked_at));
      }

      // 7. Admin Actions (Kick, Block / Unblock, Make Admin)
      const tdAct = document.createElement("td");
      const btnGroup = document.createElement("div");
      btnGroup.className = "admin-btn-group";

      const kickBtn = document.createElement("button");
      kickBtn.type = "button";
      kickBtn.className = "btn btn-xs";
      kickBtn.textContent = "Kick Sessions";
      kickBtn.title = "Immediately terminate all active browser sessions for this user";
      kickBtn.addEventListener("click", () => performAction(u.sub, "kick"));
      btnGroup.appendChild(kickBtn);

      if (u.sub !== selfSub) {
        const blockBtn = document.createElement("button");
        blockBtn.type = "button";
        blockBtn.className = u.blocked ? "btn btn-xs btn-primary" : "btn btn-xs btn-danger";
        blockBtn.textContent = u.blocked ? "Unblock Login" : "Block Login";
        blockBtn.addEventListener("click", () =>
          performAction(u.sub, u.blocked ? "unblock" : "block")
        );
        btnGroup.appendChild(blockBtn);

        if (u.role !== "admin") {
          const promoteBtn = document.createElement("button");
          promoteBtn.type = "button";
          promoteBtn.className = "btn btn-xs";
          promoteBtn.textContent = "Make Admin";
          promoteBtn.addEventListener("click", () => performAction(u.sub, "promote"));
          btnGroup.appendChild(promoteBtn);
        }
      }

      tdAct.appendChild(btnGroup);
      tr.append(tdOp, tdStatus, tdIdp, tdContest, tdNet, tdTime, tdAct);
      adminUsersBody.appendChild(tr);
    }

    statTotalUsers.textContent = String(users.length);
    statActiveSessions.textContent = String(activeSessTotal);
    statAdmins.textContent = String(adminCount);
    statBlocked.textContent = String(blockedCount);
  }

  async function performAction(targetSub, action) {
    try {
      const resp = await fetch("/api/admin/users/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ sub: targetSub, action }),
      });
      if (resp.status === 401) {
        window.location.href = "/login?error=kicked_or_expired";
        return;
      }
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        showBanner(data.error || data.message || "Action failed", true);
        return;
      }
      showBanner(data.message || "Updated user", false);
      if (data.users) renderUsers(data.users);
    } catch (_e) {
      showBanner("Network error while performing admin action", true);
    }
  }

  refreshUsersBtn.addEventListener("click", loadUsers);
  initAdmin();
})();
