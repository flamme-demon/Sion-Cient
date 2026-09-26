# Passage à matrix-rust-sdk — plan de l'étape 2

*Document de conception, ouvert le 26/09/2026. À tenir à jour : il doit
permettre de reprendre le travail sans rien savoir de la discussion qui l'a
précédé. L'étape 1 (prototype) est faite ; ce document détaille l'étape 2 et
situe les étapes 3 et 4.*

## Le problème

Sion a deux moitiés qui ne se parlent qu'à travers l'IPC : la voix est en Rust
(LiveKit natif), Matrix est en JavaScript (matrix-js-sdk) dans la webview. Deux
conséquences mesurées le 26/09/2026 :

- **Le chiffrement gèle l'interface.** matrix-js-sdk chiffre avec
  `matrix-sdk-crypto-wasm`, qui tourne sur le fil principal de la webview —
  celui qui fait aussi le rendu et le défilement. Chaque réponse `/sync`, même
  vide, bloquait ce fil **0,4 à 0,9 s** (reconstruction du compte Olm à chaque
  transaction). Un filtre (`eviterSynchroCryptoInutile`, commit `da8f280`)
  évite les appels inutiles, mais chaque message to-device paie encore ~500 ms.
- **Les clés de la voix font un aller-retour.** Elles arrivent par Matrix côté
  JS (`MatrixRTCSession`), puis sont renvoyées une à une au moteur LiveKit Rust
  par IPC (`src/services/matrixRTCE2EE.ts`).

Le banc d'essai (`~/dev/sion-banc-ui`, série du 26/09) montre ce que coûte
cette architecture : sous une tâche lourde de 500 ms toutes les 2 s, la webview
gèle jusqu'à 492 ms (28 gels par minute) quand une interface dont le calcul
tourne sur un autre cœur ne dépasse pas 11 ms.

## Le principe

**Matrix passe côté Rust, l'interface React reste.** Un cœur Matrix en Rust
possède le client, la synchronisation, le chiffrement et les médias ; il pousse
à l'interface des données toutes prêtes. Le fil principal de la webview ne fait
plus que dessiner.

Ce n'est pas un pari : c'est le SDK d'Element X (iOS, Android), le même moteur
de chiffrement qu'aujourd'hui, mais natif et multi-cœur.

Et c'est la bonne première marche quelle que soit la suite : un cœur Rust
indépendant de l'interface est le prérequis d'une éventuelle interface native
(Iced, Slint) — elle se brancherait sur le même cœur.

## Ce que l'étape 1 a validé (prototype, 26/09/2026)

Prototype `~/dev/sion-proto-matrix` (hors dépôt), matrix-sdk 0.19.1, compte de
test sur sionchat.fr (Continuwuity 26.9.0) :

| Brique | Résultat |
|---|---|
| Connexion d'un nouvel appareil | 103 ms |
| Capacité « jeton de connexion » (`m.get_login_token`) | activée — migration sans mot de passe possible |
| `recovery().recover(clé)` | 30 ms, appareil aussitôt signé par le compte |
| Historique chiffré via `backups().download_room_keys_for_room` | 17/17 messages déchiffrés |
| Synchronisation vide | 8 à 11 ms, ~0 de CPU |
| to-device chiffré A → B (canal des clés de la voix) | 21 ms de bout en bout |
| Scénario complet | 0,4 s de CPU, 51 Mo |

Serveur : spec v1.18, `org.matrix.msc4143` (MatrixRTC), `org.matrix.simplified_msc3575`
(synchro glissante simplifiée). Ni MSC4354 (événements « collants ») ni MSC4140
(événements différés).

## L'architecture retenue

```
src-tauri/
├── sion-matrix/            nouveau crate du workspace, SANS Tauri
│   ├── client.rs           Client, magasins SQLite, session, synchro
│   ├── salons.rs           liste des salons → `Channel`
│   ├── fil.rs              Timeline (matrix-sdk-ui) → `ChatMessage`, diffs
│   ├── envoi.rs            messages, réponses, réactions, sondages, fichiers
│   ├── membres.rs          membres, rôles, administration de salon
│   ├── confiance.rs        récupération, amorçage, vérification SAS
│   ├── medias.rs           téléchargement + déchiffrement + cache
│   └── sion.rs             événements propres à Sion (com.sion.*)
└── src/matrix_pont.rs      commandes et événements Tauri, protocole sion-media://
src/services/matrixCore.ts  façade typée côté JS (invoke / listen)
```

**Pourquoi un crate à part.** Il se teste avec `cargo test` sans Tauri ni
webview, il se compile isolément, et une future interface native le réutilise
tel quel.

**Pourquoi dans le dépôt Sion et pas dans un dépôt dédié.** Pendant les
étapes 2 à 4, une fonctionnalité touche souvent le crate, le pont et React à la
fois : un seul dépôt, c'est un commit cohérent, une CI, et des types générés qui
ne peuvent pas se désynchroniser. Le crate ne dépendant pas de Tauri, il
s'extraira avec tout son historique (`git subtree split`) le jour où un second
projet voudra s'en servir — fork, interface native, bot. Pas avant.

**Compilé à la demande.** Le pont est derrière la feature Cargo
`moteur-matrix-rust`, désactivée par défaut : ni les bêtas ni la CI ne payent
la compilation de matrix-sdk (~9 min) tant que le moteur n'est pas livrable.
Les tests du crate, eux, tournent dans la CI.

**Session et coffre.** Même règle que la session JS actuelle (`lib.rs`,
`secure_session_*`) : les secrets vont dans le coffre du système (`keyring`),
vérifié par relecture, avec le fichier en repli ; Android garde tout dans le
fichier. Le crate ne connaît qu'une interface `Coffre` fournie par
l'application. Les secrets : jetons d'accès **et** phrase de passe qui chiffre
les magasins SQLite (tirée au hasard à la première connexion, comme Element X).

**Synchronisation.** `SyncService` de matrix-sdk-ui (liste des salons +
synchro de chiffrement) sur la synchro glissante simplifiée que le serveur
annonce. Repli prévu : synchro classique `/v3/sync` si Continuwuity se montre
fragile — matrix-sdk sait faire les deux, c'est la liste des salons qu'il
faudrait alors construire nous-mêmes. À trancher dès T1 par la mesure.

**Fil de messages.** `Timeline` de matrix-sdk-ui : elle gère déjà éditions,
réactions, réponses, sondages, écho local, file d'envoi et nouvelle tentative
de déchiffrement. Elle émet des diffs (`VectorDiff`) ; on les traduit en
`ChatMessage` et on les pousse **par lots** à l'interface, jamais la liste
entière.

**Types.** Une seule source de vérité : les structures Rust, avec génération
des types TypeScript (`ts-rs`, licence MIT) compatibles avec
`src/types/matrix.ts`. L'interface ne change pas de modèle.

**Médias.** Un protocole `sion-media://` servi par Rust : téléchargement
authentifié, déchiffrement des fichiers chiffrés, cache disque, vignettes. La
webview ne voit plus jamais une clé de déchiffrement ; le champ
`FileAttachment.encryptedFile` disparaît.

**Secrets.** Le jeton d'accès reste côté Rust. Les écrans d'administration qui
l'utilisent aujourd'hui (API admin Continuwuity) passent par une commande
mandataire `matrix_admin_requete`.

**Coexistence.** Un seul moteur actif par lancement, choisi par
`SION_MATRIX_MOTEUR=rust` (développement). Le moteur JS reste celui par défaut
jusqu'à la parité complète. Le moteur Rust se connecte comme **un appareil
distinct** : on développe avec le compte de test.

## Les tranches de l'étape 2

Chaque tranche se livre seule, se teste seule, et ne touche pas le moteur JS.

| Tranche | Contenu | Terminée quand |
|---|---|---|
| **T0 — Fondations** | Crate `sion-matrix`, client + SQLite dans le dossier de données de l'appli, connexion / déconnexion / reprise de session, état de connexion, journal. **Compilation Windows et Android vérifiée** | Connexion au compte de test, relance de Sion sans reconnexion, builds Linux + Windows + Android verts |
| **T1 — Salons** | `SyncService`, liste → `Channel` (vocal, MP, soundboard, sujet, icône, activité), non-lus, invitations | Même liste de salons que le moteur JS sur le même compte |
| **T2 — Lecture du fil** | `Timeline` → `ChatMessage` (texte, formaté, éditions, réponses, réactions, sondages, pièces jointes via `sion-media://`, messages indéchiffrables), pagination, accusés de lecture, épinglés en lecture | Rendu identique au moteur JS sur les mêmes salons ; tests de conversion sur événements témoins |
| **T3 — Envoi** | Texte, réponse, édition, suppression, réaction, fichiers et images, sondages (créer, voter, clore), épingler, « poke » | Aller-retour complet avec une instance sur moteur JS |
| **T4 — Membres et administration** | Membres, rôles, invitations, expulsions, bannissements, règles d'accès, création de salons et de MP, nom / sujet / avatar, profil, mot de passe, appareils ; écrans d'administration via le mandataire | Tous les écrans d'administration fonctionnent sur moteur Rust |
| **T5 — Chiffrement et confiance** | Récupération par clé, amorçage d'un compte neuf (signature croisée + sauvegarde + clé de récupération), vérification SAS par emoji, état « messages indéchiffrables » | Compte neuf amorcé ; vérification croisée entre deux appareils |
| **T6 — Fonctions propres à Sion** | Soundboard, memeboard (`com.sion.meme`), transcriptions (`com.sion.transcript`), version du client (`com.sion.client_version`), notifications push, TTS | Parité fonctionnelle hors voix |

La **voix** n'est pas dans l'étape 2 : elle dépend de `MatrixRTCSession`, qui
n'existe pas côté Rust. En moteur Rust, la voix reste indisponible jusqu'à
l'étape 3. Conséquence : le moteur Rust ne peut pas être livré aux
utilisateurs avant la fin de l'étape 3.

Ordre de grandeur : de 4 à 6 semaines de travail effectif pour T0 à T6, dont
la moitié pour T2, T4 et T6.

## Les étapes suivantes

- **Étape 3 — MatrixRTC en Rust.** Port maison depuis
  `matrix-js-sdk/src/matrixrtc` (Apache-2.0, 4 538 lignes de TypeScript ; on
  n'en garde que le transport LiveKit et les clés en to-device, estimé à 1 500 –
  2 500 lignes de Rust). Appartenance en état du salon (le serveur n'a pas les
  événements collants), clés directement dans le moteur LiveKit, plus d'IPC.
  `element-hq/matrix-rust-rtc` sert de **lecture** pour l'architecture, jamais
  de source : il est en AGPL et Sion est en MIT OU Apache-2.0.
- **Étape 4 — Migration et retrait.** À la première ouverture de la nouvelle
  version, l'ancienne pile fait `requestLoginToken()` + `exportSecretsBundle()`
  + `exportRoomKeys()` ; le cœur Rust fait `login_token` (nouvel appareil),
  `import_secrets_bundle` (appareil auto-vérifié) et `import_room_keys`
  (historique lisible aussitôt), puis l'ancien appareil est déconnecté. Retrait
  de matrix-js-sdk et de `matrix-sdk-crypto-wasm`. Au passage, chaque
  utilisateur repart d'un compte Olm sain.

## Comment on teste

- **Unitaires** (`cargo test -p sion-matrix`) : conversion d'événements témoins
  en `ChatMessage` (édition, réponse, réaction, sondage, pièce jointe chiffrée,
  indéchiffrable), classement des salons (vocal, MP, soundboard).
- **Intégration** : un scénario scripté sur le compte de test, sur le modèle du
  prototype — connexion, liste, lecture, envoi, réception depuis un autre
  appareil, nettoyage des appareils.
- **Interopérabilité** : deux instances de développement sur le compte de
  test, l'une sur moteur JS, l'autre sur moteur Rust, qui échangent messages,
  réactions, sondages et fichiers.
- **Mesures à chaque tranche**, avec la méthode du 26/09 : CPU du fil
  principal de la webview (`pidstat`, fils), coût d'une synchronisation,
  mémoire réelle (PSS) — comparées au moteur JS dans les mêmes conditions.
- **CI** : les tests de `sion-matrix` rejoignent le job `cargo test`.

## Risques et questions ouvertes

- **Synchro glissante sur Continuwuity** : annoncée, pas encore éprouvée par
  Sion. Repli : synchro classique (voir plus haut).
- **Compilation** : matrix-sdk tire `aws-lc-rs` (TLS) et SQLite embarqué. À
  valider dès T0 sous Windows (MSVC) et Android (NDK), où `aws-lc-sys` peut
  exiger CMake / NASM.
- **Taille** : plusieurs mégaoctets de plus dans chaque paquet, à mesurer.
- **Mémoire** : pas de gain attendu sur la webview elle-même (elle reste) ; le
  gain vient du tas JS allégé (plus de matrix-js-sdk ni du module WASM de
  chiffrement). À mesurer, sans le promettre.
- **Volume d'IPC** : les diffs du fil doivent partir par lots et être
  regroupés côté JS, sinon on recrée le problème qu'on veut résoudre.
- **Événements propres à Sion** : chaque type `com.sion.*` doit être relu à
  l'identique ; T6 en dresse la liste exhaustive avant d'écrire du code.

## Invariants à ne pas casser

- **Jamais** réutiliser un `device_id` existant avec un magasin de chiffrement
  neuf : c'est ce qui a vidé le chiffrement d'un utilisateur (purge de cache,
  corrigé en `709af50`). Un nouveau magasin = un nouvel appareil. Concrètement :
  une session sauvegardée dont le magasin a disparu n'est **pas** reprise ; on
  l'efface et on redemande une connexion.
- `EncryptionSettings` sans rien d'automatique (`auto_enable_cross_signing`,
  `auto_enable_backups` à `false`) : le cœur ne doit jamais créer une nouvelle
  identité ni une nouvelle sauvegarde sur un compte qui en a déjà une. Seul
  l'amorçage explicite d'un compte neuf (T5) le fait.
- Le jeton d'accès ne quitte pas Rust.
- Aucun code sous AGPL dans Sion (voir étape 3).
- Le moteur JS reste intact et par défaut tant que les étapes 2 et 3 ne sont
  pas terminées.

## Annexe — correspondance des fonctions de `matrixService.ts`

| Tranche | Fonctions |
|---|---|
| T0 | `initMatrixClient`, `startSync`, `getMatrixClient` (remplacé par la façade), `logout`, `checkSuspended`, `getRegistrationFlows`, `registerUser` ; `sessionPersist.ts` ; `eviterSynchroCryptoInutile` (disparaît) ; `__setMatrixClientForTest` (les tests injecteront une fausse façade `matrixCore`) |
| T1 | `joinRoom`, `leaveRoom`, `isDMRoom`, `getAvatarUrl`, `mxcToHttp`, `mxcToThumbnail` (→ `sion-media://`) |
| T2 | historique (`loadRoomHistory` du store), `resolveServerEventId`, `markRoomAsRead`, `getPinnedEventIds`, `getPinnedSummaries` |
| T3 | `sendTextMessage`, `sendReply`, `editMessage`, `redactMessage`, `sendReaction`, `uploadFile`, `sendFileMessage`, `sendImageUrl`, `getMaxUploadSize`, `sendPoke`, `createPoll`, `votePoll`, `endPoll`, `pinMessage` |
| T4 | `getRoomMembers`, `getRoomMemberInfo`, `getUserPowerLevel`, `getStatePowerLevel`, `getInvitePowerLevel`, `getMemberPowerLevel`, `canSendMessage`, `setUserPowerLevel`, `inviteUser`, `kickUser`, `banUser`, `setRoomJoinRule`, `createChannel`, `createOrGetDMRoom`, `setRoomName`, `setRoomTopic`, `setRoomAvatar`, `getServerAdminUserIds`, `setDisplayName`, `setAvatar`, `changePassword`, `fetchDisplayName`, `getDevices`, `deleteDevice` ; composants `AdminActions`, `AdminStats`, `PendingUsers`, `MemberPanel`, `ChatHeader`, `ChannelItem`, `UserContextMenu`, `AccountPopover` ; `adminCommandService.ts`, `usePendingUsersStore.ts` |
| T5 | `checkDeviceVerified`, `hasUndecryptableMessages`, `restoreKeyBackup`, `tryAutoRestoreKeyBackup`, `requestOwnUserVerification`, `checkNeedsBootstrap`, `bootstrapAll`, `regenerateRecoveryKey`, `shareHistoricKeys` |
| T6 | `publishClientVersion`, `ouvrirDroitAnnonceVersion`, `getRoomClientVersions`, `refreshDeviceVersionLabel`, `sendTranscriptSegment`, `sendSummaryMessage`, `sendTranscriptSession`, `backfillTranscript`, `findSoundboardRoom`, `invalidateSoundboardRoomCache`, `createOrSyncSoundboardRoom` ; `soundboardService.ts`, `memeboardService.ts`, `pushService.ts`, `ttsService.ts`, `SoundboardPanel`, `MemeboardPanel` |
| Étape 3 | `buildCallMemberContent`, `sendCallMemberEvent`, `removeCallMemberEvent`, `getLocalVoiceState`, `publishLocalVoiceState`, `republishCallMember` ; `useVoiceChannel.ts`, `livekitTokenService.ts`, `matrixRTCE2EE.ts`, `voiceNativeService.ts` |
