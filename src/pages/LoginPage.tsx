import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/useAuthStore";
import { EyeIcon, EyeOffIcon } from "../components/icons";

type AuthMode = "login" | "register";

export function LoginPage() {
  const { t } = useTranslation();
  const { login, register, isLoading, error, clearError } = useAuthStore();

  const [mode, setMode] = useState<AuthMode>("login");
  const [homeserver, setHomeserver] = useState(
    () => localStorage.getItem("sion_last_homeserver") || "https://",
  );
  const [username, setUsername] = useState(
    () => localStorage.getItem("sion_last_username") || "",
  );
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    try {
      if (mode === "register") {
        await register(homeserver, username, password, displayName || undefined);
      } else {
        await login(homeserver, username, password);
      }
    } catch {
      // Error is already set in the store
    }
  };

  const switchMode = (newMode: AuthMode) => {
    setMode(newMode);
    clearError();
  };

  const styles = {
    container: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100vh",
      width: "100vw",
      background: "var(--color-surface)",
      fontFamily: "inherit",
    } as React.CSSProperties,
    card: {
      width: "100%",
      maxWidth: 420,
      background: "var(--color-surface-container-low)",
      borderRadius: 28,
      padding: "40px 32px 32px 32px",
      boxShadow: "0 2px 16px rgba(0,0,0,0.18)",
    } as React.CSSProperties,
    logo: {
      textAlign: "center" as const,
      marginBottom: 32,
    },
    logoText: {
      fontSize: 32,
      fontWeight: 700,
      color: "var(--color-primary)",
      letterSpacing: "-0.02em",
    },
    logoSub: {
      fontSize: 13,
      color: "var(--color-on-surface-variant)",
      marginTop: 4,
    },
    segmented: {
      display: "flex",
      gap: 0,
      marginBottom: 24,
      borderRadius: 20,
      background: "var(--color-surface-container)",
      padding: 4,
    },
    segmentBtn: (active: boolean) => ({
      flex: 1,
      padding: "10px 0",
      border: "none",
      cursor: "pointer",
      borderRadius: 16,
      fontSize: 14,
      fontWeight: 600,
      fontFamily: "inherit",
      transition: "all 200ms",
      background: active ? "var(--color-secondary-container)" : "transparent",
      color: active ? "var(--color-on-secondary-container)" : "var(--color-on-surface-variant)",
    }) as React.CSSProperties,
    fieldGroup: {
      marginBottom: 16,
    },
    label: {
      display: "block",
      fontSize: 12,
      fontWeight: 500,
      color: "var(--color-on-surface-variant)",
      marginBottom: 6,
      paddingLeft: 4,
    },
    input: {
      width: "100%",
      padding: "14px 16px",
      border: "none",
      outline: "none",
      fontSize: 14,
      fontFamily: "inherit",
      color: "var(--color-on-surface)",
      background: "var(--color-surface-container-high)",
      borderRadius: "12px 12px 4px 4px",
      boxSizing: "border-box" as const,
      transition: "background 200ms",
    } as React.CSSProperties,
    inputPassword: {
      width: "100%",
      padding: "14px 48px 14px 16px",
      border: "none",
      outline: "none",
      fontSize: 14,
      fontFamily: "inherit",
      color: "var(--color-on-surface)",
      background: "var(--color-surface-container-high)",
      borderRadius: "12px 12px 4px 4px",
      boxSizing: "border-box" as const,
    } as React.CSSProperties,
    passwordWrap: {
      position: "relative" as const,
    },
    eyeBtn: {
      position: "absolute" as const,
      right: 8,
      top: "50%",
      transform: "translateY(-50%)",
      background: "transparent",
      border: "none",
      cursor: "pointer",
      padding: 8,
      borderRadius: 12,
      display: "flex",
      color: "var(--color-on-surface-variant)",
    },
    submitBtn: {
      width: "100%",
      padding: "16px 0",
      border: "none",
      cursor: "pointer",
      borderRadius: 28,
      fontSize: 15,
      fontWeight: 600,
      fontFamily: "inherit",
      background: "var(--color-primary)",
      color: "var(--color-on-primary)",
      marginTop: 8,
      transition: "opacity 200ms",
      opacity: isLoading ? 0.7 : 1,
    } as React.CSSProperties,
    errorBox: {
      background: "var(--color-error-container)",
      color: "var(--color-on-error-container)",
      borderRadius: 16,
      padding: "12px 16px",
      fontSize: 13,
      marginBottom: 16,
    },
    spinner: {
      display: "inline-block",
      width: 18,
      height: 18,
      border: "2px solid var(--color-on-primary)",
      borderTopColor: "transparent",
      borderRadius: "50%",
      animation: "spin 0.6s linear infinite",
      verticalAlign: "middle",
      marginRight: 8,
    },
  };

  return (
    <div style={styles.container}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        input::placeholder { color: var(--color-outline); }
      `}</style>
      <div style={styles.card}>
        <div style={styles.logo}>
          <div style={styles.logoText}>Sion</div>
          <div style={styles.logoSub}>Matrix Voice & Text Client</div>
        </div>

        <div style={styles.segmented}>
          <button style={styles.segmentBtn(mode === "login")} onClick={() => switchMode("login")}>
            {t("auth.login")}
          </button>
          <button style={styles.segmentBtn(mode === "register")} onClick={() => switchMode("register")}>
            {t("auth.register")}
          </button>
        </div>

        {error && <div style={styles.errorBox}>{error}</div>}

        <form onSubmit={handleSubmit} autoComplete="off">
          <div style={styles.fieldGroup}>
            <label style={styles.label}>{t("auth.homeserver")}</label>
            <input
              style={styles.input}
              type="url"
              value={homeserver}
              onChange={(e) => setHomeserver(e.target.value)}
              placeholder="https://matrix.example.com"
              required
            />
          </div>

          <div style={styles.fieldGroup}>
            <label style={styles.label}>{t("auth.username")}</label>
            <input
              style={styles.input}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="@user:server.com"
              required
              autoComplete="off"
              name="sion-identity"
            />
          </div>

          <div style={styles.fieldGroup}>
            <label style={styles.label}>{t("auth.password")}</label>
            <div style={styles.passwordWrap}>
              <input
                style={{
                  ...styles.inputPassword,
                  ...(!showPassword ? { WebkitTextSecurity: 'disc' as never } : {}),
                }}
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="off"
                name="sion-key"
              />
              <button type="button" style={styles.eyeBtn} onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>

          {mode === "register" && (
            <div style={styles.fieldGroup}>
              <label style={styles.label}>{t("auth.displayName")}</label>
              <input
                style={styles.input}
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t("auth.displayName")}
              />
            </div>
          )}

          <button type="submit" style={styles.submitBtn} disabled={isLoading}>
            {isLoading && <span style={styles.spinner} />}
            {isLoading
              ? mode === "register"
                ? t("auth.registering")
                : t("auth.loggingIn")
              : mode === "register"
                ? t("auth.registerButton")
                : t("auth.loginButton")}
          </button>
        </form>
      </div>
    </div>
  );
}