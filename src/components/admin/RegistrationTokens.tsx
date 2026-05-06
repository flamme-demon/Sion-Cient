import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { sendAdminCommand } from "../../services/adminCommandService";

/**
 * Extract token identifiers from the bot's `!admin token list` response.
 * Continuwuity's output format is semi-structured (text/markdown), so we
 * pick up anything that looks like a token on its own line or after a
 * `token:` label. Whitespace tolerant, case sensitive for the charset
 * defined in the Matrix spec (`[A-Za-z0-9._~-]{1,64}`).
 *
 * Returns a de-duplicated array; empty when the response says "no tokens".
 */
function extractTokens(response: string): string[] {
  const clean = response.replace(/<[^>]+>/g, " ");
  const tokens = new Set<string>();

  // Pattern A — explicit "token: XYZ" key/value.
  for (const m of clean.matchAll(/\btoken\s*[:=]\s*([A-Za-z0-9._~-]{4,64})/gi)) {
    tokens.add(m[1]);
  }

  // Pattern B — a line consisting of just a token (plus optional
  // decoration). We avoid matching timestamps, numbers, or common words
  // by requiring both letters and either a digit or a token-only symbol.
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[-*•|]\s*/, "");
    if (!/^[A-Za-z0-9._~-]{6,64}$/.test(trimmed)) continue;
    if (!/[A-Za-z]/.test(trimmed) || !/[0-9._~-]/.test(trimmed)) continue;
    tokens.add(trimmed);
  }

  return Array.from(tokens);
}

/**
 * Returns true only when we actually parsed at least one token. Earlier
 * iterations also tried regex-matching "no tokens" / "error" phrases in the
 * raw response, but those branches always resolved to `false` anyway, so
 * the only signal that matters is whether the extractor produced anything.
 */
function hasTokens(extracted: string[]): boolean {
  return extracted.length > 0;
}

export function RegistrationTokens() {
  const { t } = useTranslation();
  const [response, setResponse] = useState<string | null>(null);
  const [tokens, setTokens] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const raw = await sendAdminCommand("!admin token list");
      setResponse(raw);
      setTokens(extractTokens(raw));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResponse(null);
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const hasAnyTokens = response !== null && hasTokens(tokens);

  return (
    <div style={{
      background: 'var(--color-surface-container)',
      borderRadius: 16,
      padding: '14px 8px',
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0 8px',
        marginBottom: 8,
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase' as const,
          letterSpacing: '0.06em',
          color: 'var(--color-on-surface-variant)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          {t("admin.tokens.title")}
          {tokens.length > 0 && (
            <span style={{
              background: 'var(--color-tertiary-container)',
              color: 'var(--color-on-tertiary-container)',
              borderRadius: 10,
              padding: '1px 7px',
              fontSize: 10,
              fontWeight: 700,
            }}>
              {tokens.length}
            </span>
          )}
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          style={{
            background: 'none',
            border: 'none',
            cursor: loading ? 'not-allowed' : 'pointer',
            color: 'var(--color-on-surface-variant)',
            fontSize: 14,
            padding: '2px 6px',
            borderRadius: 8,
            opacity: loading ? 0.4 : 0.7,
          }}
          title={t("admin.tokens.refresh")}
        >
          ↻
        </button>
      </div>

      {hasAnyTokens && (
        <div
          role="status"
          style={{
            margin: '0 8px 8px 8px',
            padding: '8px 10px',
            borderRadius: 10,
            background: 'var(--color-tertiary-container)',
            color: 'var(--color-on-tertiary-container)',
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {t("admin.tokens.limitedBanner")}
        </div>
      )}

      {loading && response === null ? (
        <div style={{ padding: '12px 8px', textAlign: 'center', color: 'var(--color-outline)', fontSize: 12 }}>
          ...
        </div>
      ) : error ? (
        <div style={{ padding: '12px 8px', textAlign: 'center', color: 'var(--color-error)', fontSize: 11 }}>
          {t("admin.tokens.error", { defaultValue: "Erreur" })} — {error}
        </div>
      ) : tokens.length === 0 ? (
        <div style={{ padding: '12px 8px', textAlign: 'center', color: 'var(--color-outline)', fontSize: 12 }}>
          {t("admin.tokens.openBanner")}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {tokens.map((tok) => (
            <div
              key={tok}
              style={{
                padding: '8px 10px',
                borderRadius: 12,
                background: 'var(--color-surface-container-high)',
                fontFamily: 'monospace',
                fontSize: 12,
                color: 'var(--color-on-surface)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap' as const,
              }}
              title={tok}
            >
              {tok}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
