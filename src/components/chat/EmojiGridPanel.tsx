import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EMOJI_DATA, EMOJI_GROUPS, EMOJI_BY_GROUP } from "../../utils/emojiData";
import { useRecentEmojisStore } from "../../stores/useRecentEmojisStore";

interface Props {
  /** Called with the chosen unicode emoji. Recents are tracked automatically. */
  onPick: (emoji: string) => void;
  /** Grid button size in px (default 34). */
  emojiSize?: number;
  /** Focus the search field on mount (default true). */
  autoFocusSearch?: boolean;
}

/** Shared emoji picker body: search + recents + category tabs + grid.
 *  The caller owns the surrounding popover (sizing, position, open/close).
 *  Used by the chat input, message reactions, and the poll creator. */
export function EmojiGridPanel({ onPick, emojiSize = 34, autoFocusSearch = true }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState(0);
  const recent = useRecentEmojisStore((s) => s.recent);
  const addRecent = useRecentEmojisStore((s) => s.add);

  const pick = (emoji: string) => { addRecent(emoji); onPick(emoji); };

  const list = search.length >= 2
    ? (() => {
        const q = search.toLowerCase();
        const starts = EMOJI_DATA.filter((e) => e.shortcode.startsWith(q));
        const contains = EMOJI_DATA.filter((e) => !e.shortcode.startsWith(q) && e.shortcode.includes(q));
        return [...starts, ...contains];
      })()
    : (EMOJI_BY_GROUP.get(group) || []);

  const recentSize = Math.max(28, emojiSize - 4);

  return (
    <>
      <div style={{ padding: '10px 10px 6px 10px' }}>
        <input
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={t("chat.searchEmoji")} autoFocus={autoFocusSearch}
          style={{ width: '100%', padding: '8px 12px', borderRadius: 12, border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-container-high)', color: 'var(--color-on-surface)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
        />
      </div>

      {search.length < 2 && recent.length > 0 && (
        <div style={{ display: 'flex', gap: 2, padding: '4px 8px 6px 8px', overflowX: 'auto', borderBottom: '1px solid var(--color-outline-variant)' }}>
          {recent.map((emoji, i) => (
            <button key={`recent-${i}`} onMouseDown={(e) => { e.preventDefault(); pick(emoji); }} title={t("chat.recentEmojis")}
              style={{ width: recentSize, height: recentSize, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer', transition: 'background 100ms', padding: 0 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-secondary-container)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >{emoji}</button>
          ))}
        </div>
      )}

      {search.length < 2 && (
        <div style={{ display: 'flex', padding: '0 6px', borderBottom: '1px solid var(--color-outline-variant)' }}>
          {EMOJI_GROUPS.map((g) => (
            <button key={g.id} onMouseDown={(e) => { e.preventDefault(); setGroup(g.id); }} title={g.label}
              style={{ flex: 1, padding: '6px 0', border: 'none', background: 'transparent', fontSize: 14, cursor: 'pointer',
                borderBottom: group === g.id ? '2px solid var(--color-primary)' : '2px solid transparent',
                opacity: group === g.id ? 1 : 0.5, transition: 'all 150ms' }}
            >{g.icon}</button>
          ))}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px 8px', display: 'flex', flexWrap: 'wrap', gap: 2, alignContent: 'flex-start' }}>
        {list.map((entry) => (
          <button key={entry.shortcode} onMouseDown={(e) => { e.preventDefault(); pick(entry.emoji); }} title={`:${entry.shortcode}:`}
            style={{ width: emojiSize, height: emojiSize, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, border: 'none', borderRadius: 8, background: 'transparent', cursor: 'pointer', transition: 'background 100ms', padding: 0 }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-secondary-container)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >{entry.emoji}</button>
        ))}
      </div>
    </>
  );
}
