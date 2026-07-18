/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";

// Only the pure extraction pipeline is under test — stub out the modules
// useMatrixStore pulls in for its (untested here) side-effectful paths.
vi.mock("../services/matrixService", () => ({
  mxcToHttp: (mxc: string) => (mxc ? `https://hs.test/media/${mxc.slice("mxc://".length)}` : null),
}));
vi.mock("../services/soundService", () => ({ playMessageReceived: vi.fn() }));
vi.mock("../services/voiceChannelSounds", () => ({
  playPokeCue: vi.fn(), playKickCue: vi.fn(), playMemberKickedCue: vi.fn(), noteKicked: vi.fn(),
}));
vi.mock("../services/adminCommandService", () => ({ findAdminRoom: vi.fn() }));
vi.mock("./useAppStore", () => ({ useAppStore: { getState: () => ({}), subscribe: vi.fn() } }));
vi.mock("./useSettingsStore", () => ({ useSettingsStore: { getState: () => ({}), subscribe: vi.fn() } }));
vi.mock("../utils/messageCache", () => ({
  setCachedRoom: vi.fn(), appendCachedEventIds: vi.fn(), clearCache: vi.fn(),
}));

import {
  extractMessagesFromEvents,
  extractReplyQuoteBody,
  stripReplyFallback,
  stripMxReply,
  parsePollStartContent,
} from "./useMatrixStore";

let seq = 0;
/** Fake matrix-js-sdk event — just the accessor surface the extractor reads. */
function ev(type: string, content: Record<string, unknown>, over: Partial<{
  id: string; sender: string; ts: number; decryptFailure: boolean;
}> = {}) {
  const id = over.id ?? `$e${++seq}`;
  return {
    getType: () => type,
    getContent: () => content,
    getId: () => id,
    getSender: () => over.sender ?? "@alice:hs",
    getTs: () => over.ts ?? 1_700_000_000_000,
    isDecryptionFailure: () => over.decryptFailure ?? false,
  };
}

const room = { getMember: (uid: string) => (uid === "@alice:hs" ? { name: "Alice" } : null) };
const extract = (events: unknown[]) => extractMessagesFromEvents(events as never[], room, null);

describe("extractMessagesFromEvents — texte", () => {
  it("extrait un message texte avec le display name du membre", () => {
    const msgs = extract([ev("m.room.message", { msgtype: "m.text", body: "salut" })]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("salut");
    expect(msgs[0].user).toBe("Alice");
  });

  it("retombe sur le localpart quand le membre est inconnu", () => {
    const msgs = extract([ev("m.room.message", { msgtype: "m.text", body: "yo" }, { sender: "@bob:hs" })]);
    expect(msgs[0].user).toBe("bob");
  });

  it("garde un event encore typé m.room.encrypted mais déchiffré (msgtype présent)", () => {
    // matrix-js-sdk peut laisser getType() périmé après déchiffrement d'un
    // event paginé — le contenu clair fait foi.
    const msgs = extract([ev("m.room.encrypted", { msgtype: "m.text", body: "déchiffré" })]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("déchiffré");
  });

  it("affiche un placeholder pour un échec de déchiffrement", () => {
    const msgs = extract([ev("m.room.message", {}, { decryptFailure: true })]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].msgtype).toBe("m.encrypted");
  });

  it("ignore les events non-message (state, signaling)", () => {
    const msgs = extract([
      ev("m.room.member", { membership: "join" }),
      ev("com.sion.transcript", { text: "segment" }),
    ]);
    expect(msgs).toHaveLength(0);
  });
});

describe("extractMessagesFromEvents — éditions (m.replace)", () => {
  it("applique une édition sur le message d'origine, sans créer de doublon", () => {
    const orig = ev("m.room.message", { msgtype: "m.text", body: "typo" }, { id: "$orig" });
    const edit = ev("m.room.message", {
      msgtype: "m.text",
      body: "* corrigé",
      "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
      "m.new_content": { msgtype: "m.text", body: "corrigé" },
    });
    const msgs = extract([orig, edit]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("corrigé");
    expect(msgs[0].edited).toBe(true);
  });

  it("ignore une édition dont la cible n'est pas dans la fenêtre chargée", () => {
    const edit = ev("m.room.message", {
      msgtype: "m.text",
      body: "* corrigé",
      "m.relates_to": { rel_type: "m.replace", event_id: "$absent" },
      "m.new_content": { msgtype: "m.text", body: "corrigé" },
    });
    expect(extract([edit])).toHaveLength(0);
  });
});

describe("extractMessagesFromEvents — réponses", () => {
  const replyBody = "> <@alice:hs> message original\n\nma réponse";

  it("résout la réponse depuis le message chargé et retire le fallback", () => {
    const orig = ev("m.room.message", { msgtype: "m.text", body: "message original" }, { id: "$orig" });
    const reply = ev("m.room.message", {
      msgtype: "m.text",
      body: replyBody,
      "m.relates_to": { "m.in_reply_to": { event_id: "$orig" } },
    }, { sender: "@bob:hs" });
    const msgs = extract([orig, reply]);
    expect(msgs[1].text).toBe("ma réponse");
    expect(msgs[1].replyTo).toMatchObject({ eventId: "$orig", user: "Alice", text: "message original" });
  });

  it("retombe sur la citation du fallback quand l'original est hors fenêtre", () => {
    const reply = ev("m.room.message", {
      msgtype: "m.text",
      body: replyBody,
      "m.relates_to": { "m.in_reply_to": { event_id: "$absent" } },
    });
    const msgs = extract([reply]);
    expect(msgs[0].replyTo?.text).toBe("message original");
    expect(msgs[0].text).toBe("ma réponse");
  });
});

describe("extractMessagesFromEvents — réactions (m.annotation)", () => {
  const react = (target: string, key: string, sender: string) =>
    ev("m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } }, { sender });

  it("agrège les réactions par emoji et dédoublonne par utilisateur", () => {
    const orig = ev("m.room.message", { msgtype: "m.text", body: "gg" }, { id: "$m" });
    const msgs = extract([
      orig,
      react("$m", "👍", "@alice:hs"),
      react("$m", "👍", "@bob:hs"),
      react("$m", "👍", "@bob:hs"), // doublon même sender
      react("$m", "🎉", "@bob:hs"),
    ]);
    const r = msgs[0].reactions!;
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.emoji === "👍")).toMatchObject({ count: 2, userIds: ["@alice:hs", "@bob:hs"] });
    expect(r.find((x) => x.emoji === "🎉")?.count).toBe(1);
  });

  it("ignore une réaction vers un message hors fenêtre", () => {
    expect(extract([react("$absent", "👍", "@alice:hs")])).toHaveLength(0);
  });
});

describe("extractMessagesFromEvents — médias", () => {
  it("mappe un fichier E2EE (content.file) en gardant les clés de déchiffrement", () => {
    const msgs = extract([
      ev("m.room.message", {
        msgtype: "m.image",
        body: "photo.png",
        info: { mimetype: "image/png", size: 1234, w: 10, h: 20 },
        file: { url: "mxc://hs/abc", key: { k: "secret" }, iv: "iv0" },
      }),
    ]);
    const att = msgs[0].attachments![0];
    expect(att.url).toBe("https://hs.test/media/hs/abc");
    expect(att.name).toBe("photo.png");
    expect(att.encryptedFile).toMatchObject({ key: { k: "secret" }, iv: "iv0" });
  });

  it("ignore un média sans URL résolvable", () => {
    expect(extract([ev("m.room.message", { msgtype: "m.image", body: "x" })])).toHaveLength(0);
  });
});

describe("extractMessagesFromEvents — sondages (MSC3381)", () => {
  const start = ev("org.matrix.msc3381.poll.start", {
    "org.matrix.msc3381.poll.start": {
      question: { "org.matrix.msc1767.text": "Pizza ?" },
      kind: "org.matrix.msc3381.poll.disclosed",
      max_selections: 1,
      answers: [
        { id: "a", "org.matrix.msc1767.text": "Oui" },
        { id: "b", "org.matrix.msc1767.text": "Non" },
      ],
    },
  }, { id: "$poll" });

  it("agrège start + réponses + end en un message sondage", () => {
    const vote = ev("org.matrix.msc3381.poll.response", {
      "m.relates_to": { event_id: "$poll" },
      "org.matrix.msc3381.poll.response": { answers: ["a"] },
    }, { sender: "@bob:hs" });
    const end = ev("org.matrix.msc3381.poll.end", { "m.relates_to": { event_id: "$poll" } });
    const msgs = extract([start, vote, end]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].poll).toMatchObject({ question: "Pizza ?", ended: true, votes: { "@bob:hs": ["a"] } });
  });

  it("refuse les votes arrivés après la clôture", () => {
    const end = ev("org.matrix.msc3381.poll.end", { "m.relates_to": { event_id: "$poll" } });
    const late = ev("org.matrix.msc3381.poll.response", {
      "m.relates_to": { event_id: "$poll" },
      "org.matrix.msc3381.poll.response": { answers: ["b"] },
    }, { sender: "@bob:hs" });
    const msgs = extract([start, end, late]);
    expect(msgs[0].poll?.votes).toEqual({});
  });
});

describe("helpers de fallback reply", () => {
  it("extractReplyQuoteBody extrait la citation multi-lignes", () => {
    expect(extractReplyQuoteBody("> <@a:hs> ligne 1\n> ligne 2\n\nréponse")).toBe("ligne 1\nligne 2");
    expect(extractReplyQuoteBody("pas de citation")).toBeUndefined();
  });

  it("stripReplyFallback retire la citation et la ligne vide", () => {
    expect(stripReplyFallback("> <@a:hs> quoté\n\nma réponse")).toBe("ma réponse");
    expect(stripReplyFallback("sans fallback")).toBe("sans fallback");
  });

  it("stripMxReply retire le bloc <mx-reply>", () => {
    expect(stripMxReply("<mx-reply><blockquote>q</blockquote></mx-reply>réponse")).toBe("réponse");
  });
});

describe("parsePollStartContent", () => {
  it("lit les formes stable et unstable", () => {
    const stable = parsePollStartContent({
      "m.poll.start": { question: { "m.text": "Q" }, answers: [{ id: "x", "m.text": "R" }] },
    });
    expect(stable).toMatchObject({ question: "Q", answers: [{ id: "x", text: "R" }], kind: "disclosed" });
    expect(parsePollStartContent({ foo: 1 })).toBeNull();
  });

  it("détecte le mode undisclosed et le cap de sélections", () => {
    const p = parsePollStartContent({
      "m.poll.start": {
        question: { "m.text": "Q" },
        kind: "org.matrix.msc3381.poll.undisclosed",
        max_selections: 3,
        answers: [{ "m.text": "A" }],
      },
    });
    expect(p).toMatchObject({ kind: "undisclosed", maxSelections: 3 });
  });
});
