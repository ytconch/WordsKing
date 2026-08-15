const SettingsPage = (() => {
  const { api, setAuth, renderHeader, refreshUser, enforcePageAccess, showMessage, state } =
    window.WordsApp;

  async function loadProfile() {
    const { user } = await api("/api/auth/me");
    document.getElementById("displayName").value = user.displayName || "";
    document.getElementById("theme").value = user.theme || "sage";
    document.getElementById("leaderboardVisible").checked = user.leaderboardVisible !== false;
    document.getElementById("practiceNextQuestionDelayMs").value =
      user.practiceNextQuestionDelayMs ?? 1000;
    document.getElementById("practiceChoiceTimeLimitSeconds").value =
      user.practiceChoiceTimeLimitSeconds ?? 15;
    document.getElementById("practiceTypingTimeLimitSeconds").value =
      user.practiceTypingTimeLimitSeconds ?? 30;
  }

  function readPracticeTimeLimitSeconds(inputId, label) {
    const input = document.getElementById(inputId);
    const seconds = Number(input.value);
    const isValid = Number.isInteger(seconds) && (seconds === 0 || (seconds >= 5 && seconds <= 40));

    if (!isValid) {
      input.focus();
      throw new Error(`${label}必須是 0，或 5 至 40 的整數秒數。`);
    }

    return seconds;
  }

  function bindProfileForm() {
    document.getElementById("profileForm").addEventListener("submit", async (event) => {
      event.preventDefault();

      try {
        const practiceChoiceTimeLimitSeconds = readPracticeTimeLimitSeconds(
          "practiceChoiceTimeLimitSeconds",
          "選擇題倒數"
        );
        const practiceTypingTimeLimitSeconds = readPracticeTimeLimitSeconds(
          "practiceTypingTimeLimitSeconds",
          "手寫與克漏字倒數"
        );
        const response = await api("/api/auth/me/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: document.getElementById("displayName").value.trim(),
            theme: document.getElementById("theme").value,
            leaderboardVisible: document.getElementById("leaderboardVisible").checked,
            practiceNextQuestionDelayMs: Number(
              document.getElementById("practiceNextQuestionDelayMs").value
            ),
            practiceChoiceTimeLimitSeconds,
            practiceTypingTimeLimitSeconds
          })
        });

        setAuth({ token: state.token, user: response.user });
        renderHeader();
        showMessage("設定已更新。");
      } catch (error) {
        showMessage(error.message);
      }
    });
  }

  function bindPasswordForm() {
    document.getElementById("passwordForm").addEventListener("submit", async (event) => {
      event.preventDefault();

      const currentPassword = document.getElementById("currentPassword").value;
      const newPassword = document.getElementById("newPassword").value;
      const confirmPassword = document.getElementById("confirmPassword").value;

      if (newPassword !== confirmPassword) {
        showMessage("新密碼與確認密碼不一致。");
        return;
      }

      try {
        await api("/api/auth/me/password", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPassword, newPassword })
        });

        event.currentTarget.reset();
        sessionStorage.setItem("wordsKingNotice", "密碼已更新，請重新登入。");
        setAuth(null);
        window.location.replace("/home.html");
      } catch (error) {
        showMessage(error.message);
      }
    });
  }

  function bindDeleteAccountForm() {
    document.getElementById("deleteAccountForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();

      const currentPassword = document.getElementById("deleteAccountPassword").value;
      const confirmed = window.confirm("註銷後將無法復原帳號與學習紀錄，確定要註銷嗎？");
      if (!confirmed) {
        return;
      }

      try {
        await api("/api/auth/me", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPassword })
        });

        event.currentTarget.reset();
        sessionStorage.setItem("wordsKingNotice", "帳號已註銷。");
        setAuth(null);
        window.location.replace("/home.html");
      } catch (error) {
        showMessage(error.message);
      }
    });
  }

  async function init() {
    await refreshUser();
    if (!enforcePageAccess()) return;

    await loadProfile();
    bindProfileForm();
    bindPasswordForm();
    bindDeleteAccountForm();
  }

  return { init };
})();

SettingsPage.init().catch((error) => window.WordsApp.showMessage(error.message));
