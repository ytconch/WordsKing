const HomePage = (() => {
  const { api, setAuth, renderHeader, showMessage, refreshUser, state } = window.WordsApp;

  function goToWords() {
    window.location.replace("/words.html");
  }

  function switchAuthTab(tab) {
    const tabs = ["login", "register", "recovery"];

    tabs.forEach((name) => {
      const panel = document.getElementById(`${name}Panel`);
      panel?.classList.toggle("is-active", name === tab);
    });

    const loginTab = document.getElementById("showLoginTab");
    const registerTab = document.getElementById("showRegisterTab");
    const isLogin = tab === "login";
    const isRegister = tab === "register";

    loginTab.classList.toggle("is-active", isLogin);
    registerTab.classList.toggle("is-active", isRegister);
    loginTab.setAttribute("aria-selected", String(isLogin));
    registerTab.setAttribute("aria-selected", String(isRegister));
  }

  function bindForms() {
    const loginForm = document.getElementById("loginForm");
    const registerForm = document.getElementById("registerForm");
    const recoveryForm = document.getElementById("recoveryForm");

    document.getElementById("showLoginTab").addEventListener("click", () => switchAuthTab("login"));
    document.getElementById("showRegisterTab").addEventListener("click", () => switchAuthTab("register"));
    document.getElementById("showRecoveryLink").addEventListener("click", () => switchAuthTab("recovery"));
    document.getElementById("hideRecoveryLink").addEventListener("click", () => switchAuthTab("login"));

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      try {
        const response = await api("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.fromEntries(new FormData(loginForm).entries()))
        });

        setAuth(response);
        renderHeader();
        goToWords();
      } catch (error) {
        showMessage(error.message);
      }
    });

    registerForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      try {
        const response = await api("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.fromEntries(new FormData(registerForm).entries()))
        });

        setAuth(response);
        renderHeader();
        goToWords();
      } catch (error) {
        showMessage(error.message);
      }
    });

    recoveryForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      try {
        const response = await api("/api/auth/recovery-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.fromEntries(new FormData(recoveryForm).entries()))
        });

        recoveryForm.reset();
        switchAuthTab("login");
        showMessage(response.message);
      } catch (error) {
        showMessage(error.message);
      }
    });
  }

  async function init() {
    await refreshUser();
    if (state.token && state.user) {
      goToWords();
      return;
    }

    const notice = sessionStorage.getItem("wordsKingNotice");
    if (notice) {
      sessionStorage.removeItem("wordsKingNotice");
      switchAuthTab("login");
      showMessage(notice);
    }
    bindForms();
  }

  return { init };
})();

HomePage.init();
