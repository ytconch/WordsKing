const NotificationsPage = (() => {
  const { api, refreshUser, enforcePageAccess, refreshUnreadCount, showMessage } = window.WordsApp;
  const state = {
    notifications: [],
    unreadCount: 0
  };

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function formatDateTime(value) {
    if (!value) return "未知時間";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  function getSummary(message) {
    const normalized = String(message || "").replace(/\s+/g, " ").trim();
    if (!normalized) return "沒有內容。";
    return normalized.length > 68 ? `${normalized.slice(0, 68)}...` : normalized;
  }

  function renderMetrics() {
    const target = document.getElementById("notificationMetrics");
    const total = state.notifications.length;
    const unread = state.notifications.filter((item) => !item.isRead).length;
    const latest = state.notifications[0]?.createdAt ? formatDateTime(state.notifications[0].createdAt) : "目前沒有通知";

    target.innerHTML = `
      <article class="metric-card">
        <span>未讀</span>
        <strong>${unread}</strong>
      </article>
      <article class="metric-card">
        <span>總通知</span>
        <strong>${total}</strong>
      </article>
      <article class="metric-card">
        <span>最近通知</span>
        <strong class="metric-small">${escapeHtml(latest)}</strong>
      </article>
    `;
  }

  function renderList() {
    const target = document.getElementById("notificationInboxList");
    const hint = document.getElementById("notificationHint");

    renderMetrics();

    if (!state.notifications.length) {
      hint.textContent = "目前沒有通知。";
      target.innerHTML = `<div class="empty">目前沒有通知。</div>`;
      return;
    }

    hint.textContent = `共 ${state.notifications.length} 則，未讀 ${state.notifications.filter((item) => !item.isRead).length} 則。`;
    target.innerHTML = state.notifications
      .map(
        (item) => `
          <article class="notification-card ${item.isRead ? "" : "unread"}" data-id="${item.id}">
            <div class="notification-card-top">
              <button type="button" class="notification-card-toggle" aria-expanded="${item.isOpen ? "true" : "false"}">
                <div class="notification-card-head">
                  <div class="notification-card-title-wrap">
                    <strong>${escapeHtml(item.title || "通知")}</strong>
                    ${item.isRead ? "" : `<span class="pill unread-pill">未讀</span>`}
                  </div>
                  <span class="muted small-text">${escapeHtml(formatDateTime(item.createdAt))}</span>
                </div>
                <div class="notification-card-summary">${escapeHtml(getSummary(item.message))}</div>
                <div class="notification-card-meta muted small-text">
                  <span>${escapeHtml(item.senderName || "系統")}</span>
                  <span>${item.isOpen ? "收起" : "展開全文"}</span>
                </div>
              </button>
              <button type="button" class="ghost-btn notification-delete-btn" data-id="${item.id}">刪除</button>
            </div>
            <div class="notification-card-detail ${item.isOpen ? "open" : "hidden"}">
              <div class="notification-card-message">${escapeHtml(item.message || "沒有內容。").replace(/\n/g, "<br>")}</div>
            </div>
          </article>
        `
      )
      .join("");

    target.querySelectorAll(".notification-delete-btn").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const id = Number(button.dataset.id);
        const ok = window.confirm("確定要刪除此通知嗎？");
        if (!ok) return;

        try {
          await api(`/api/notifications/${id}`, { method: "DELETE" });
          state.notifications = state.notifications.filter((item) => item.id !== id);
          renderList();
          await refreshUnreadCount();
          showMessage("通知已刪除。");
        } catch (error) {
          showMessage(error.message);
        }
      });
    });

    target.querySelectorAll(".notification-card-toggle").forEach((button) => {
      button.addEventListener("click", async () => {
        const card = button.closest(".notification-card");
        const id = Number(card?.dataset.id);
        const item = state.notifications.find((entry) => entry.id === id);
        if (!item) return;

        item.isOpen = !item.isOpen;
        if (!item.isRead && item.isOpen) {
          try {
            await api(`/api/notifications/${id}/read`, { method: "PATCH" });
            item.isRead = true;
            await refreshUnreadCount();
          } catch (error) {
            showMessage(error.message);
          }
        }
        renderList();
      });
    });
  }

  async function loadInbox() {
    const data = await api("/api/notifications/inbox");
    state.unreadCount = Number(data.unreadCount || 0);
    state.notifications = (data.notifications || []).map((item) => ({
      ...item,
      isOpen: false
    }));
    renderList();
    await refreshUnreadCount();
  }

  async function markAllRead() {
    if (!state.notifications.some((item) => !item.isRead)) {
      showMessage("目前沒有未讀通知。");
      return;
    }

    await api("/api/notifications/read-all", { method: "PATCH" });
    state.notifications = state.notifications.map((item) => ({ ...item, isRead: true }));
    renderList();
    await refreshUnreadCount();
    showMessage("已全部標記為已讀。");
  }

  async function init() {
    await refreshUser();
    if (!enforcePageAccess()) return;

    document.getElementById("markAllNotificationsReadBtn").addEventListener("click", () => {
      markAllRead().catch((error) => showMessage(error.message));
    });

    await loadInbox();
  }

  return { init };
})();

NotificationsPage.init().catch((error) => window.WordsApp.showMessage(error.message));
