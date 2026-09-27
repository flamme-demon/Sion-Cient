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

### État — T0 (branche `feat/matrix-rust`, 26/09/2026)

Fait : crate `sion-matrix` (coffre, session, cycle de vie du client, 10 tests
sans réseau dont l'invariant « magasin disparu = pas de reprise ») ; pont
`matrix_pont.rs` derrière la feature `moteur-matrix-rust` ; façade
`src/services/matrixCore.ts` ; écran de développement
`src/components/dev/MoteurRustApercu.tsx`, affiché au lieu de l'appli quand
`SION_MATRIX_MOTEUR=rust` ; workflow `matrix-rust.yml` (tests Linux +
compilation Windows). Compilation Android (arm64) vérifiée à la main.

Appris en route :

- **matrix-sdk 0.19.1 exige Rust ≥ 1.96.** Le Rust d'Arch (1.98) convient ; la
  chaîne rustup `stable`, qu'utilise `build-android.sh`, était restée en 1.94 —
  mise à jour le 26/09.
- **Le lockfile monte 14 dépendances existantes** (mineures ou correctives :
  `http`, `reqwest`, `futures`, `uuid`, `wasm-bindgen`…), toutes imposées par
  les versions minimales de matrix-sdk — vérifié une à une. rdev, LiveKit,
  webrtc-sys, Tauri, wry, keyring et tokio n'ont pas bougé. Même désactivé par
  la feature, le crate pèse sur le lockfile : c'est inévitable.
- **vitest 4** : un simulacre remis à zéro dans `beforeEach` fait signaler
  comme erreur un rejet pourtant traité par le code testé.

**T0 terminé le 26/09/2026.** Sur sionchat.fr, avec le compte de test : connexion
d'un nouvel appareil, reprise sans mot de passe (même appareil) après
« fermeture », déconnexion (appareil supprimé), puis reprise impossible — test
`sion-matrix/tests/compte_reel.rs`, ignoré par défaut :

```sh
SION_TEST_SERVEUR=sionchat.fr SION_TEST_IDENTIFIANT=… SION_TEST_MOT_DE_PASSE=… \
  cargo test -p sion-matrix --test compte_reel -- --ignored --nocapture
```

Compilation Windows MSVC verte en CI (le risque `aws-lc-rs` est levé), Linux et
Android arm64 vérifiés. Pour essayer l'écran de développement :
`SION_MATRIX_MOTEUR=rust ./build-scripts/run-native.sh --features moteur-matrix-rust`.

### État — T1 (26/09/2026)

**Décision : synchro classique, pas la synchro glissante.** La liste de salons
d'Element X (`RoomListService`) ne demande au serveur qu'une liste d'états
**figée dans son code** (`DEFAULT_REQUIRED_STATE`) : `org.matrix.msc3401.call.member`
y est, mais pas `m.room.type` — le marqueur que Sion pose sur ses salons
vocaux (`m.voice_channel`, voir `createChannel`). Le sujet « voice » n'est
qu'un complément, modifiable : un salon vocal renommé deviendrait un salon
texte. La synchro classique donne l'état complet ; pour des serveurs
communautaires, son coût est négligeable (114–173 ms pour 8 salons). Une
synchro glissante avec nos propres listes (`matrix_sdk::sliding_sync`) reste
possible si de gros comptes l'exigent.

Fait :

- `appels.rs` — participants vocaux (`extractVoiceUsers`), les 9 tests JS
  portés à l'identique, plus 3.
- `salons.rs` — classement pur (`mapRoomToChannel`) : vocal, MP (`m.direct`,
  salon à deux, MP orphelin), soundboard, nom, icône ; sérialisé au format
  `Channel` exact (dont `isDM`).
- `horloge.rs` — écart avec le serveur par l'en-tête `Date` (port de
  `serverClock.ts`, même tolérance de 5 min, même validité de 10 min).
- `synchro.rs` — boucle de synchro, invitations acceptées d'office (et
  `m.direct` mis à jour pour un MP, comme le JS), dernière activité gardée
  d'un lancement à l'autre (`activite.json`), liste republiée seulement si
  elle change.
- Pont : commande `matrix_salons`, événement `matrix-salons`,
  `matrix_ecart_horloge` ; l'écran de développement affiche la liste.

**Parité vérifiée sur le compte de test : 8 salons de chaque côté, 0 écart**
(nom, sujet, icône, vocal, MP et correspondant, soundboard, création,
participants vocaux ; dernière activité identique aussi). Outil réutilisable
pour les tranches suivantes :

```sh
SION_TEST_SERVEUR=sionchat.fr SION_TEST_IDENTIFIANT=… SION_TEST_MOT_DE_PASSE=… \
  ./build-scripts/parite-moteurs.sh
```

Il fait tourner le vrai `mapRoomToChannel` du moteur JS
(`src/stores/pariteSalons.test.ts`, ignoré sans ces variables) et le cœur Rust
(`tests/compte_reel.rs`) sur le même compte, puis compare champ par champ.

Pas encore couvert, rattaché à T2 : les non-lus (le JS les compte à partir des
messages reçus depuis le début de la session).

Appris en route (26/09, sur un compte réel en écran de développement) :

- **Invitation vers un salon banni du serveur** : `403 M_FORBIDDEN « This room
  is banned on this homeserver »`, qui échouera toujours. La boucle la
  retentait à chaque synchro ; désormais une seule tentative par invitation
  et par session, comme le JS. Une nouvelle invitation reste traitée à son
  arrivée.
- **`reprendre()` est idempotent**, vérifié sous verrou : en développement,
  React monte l'écran deux fois, et le second appel relançait toute la
  synchro.

### État — T2 (branche `feat/matrix-rust`, 27/09/2026)

Fait :

- `messages.rs` — port pur de `extractMessagesFromEvents` (texte, formaté,
  éditions, réponses, réactions, sondages, pièces jointes, indéchiffrables),
  les tests JS portés à l'identique, plus ceux des écarts voulus.
- `fil.rs` — un abonnement au cache d'événements de matrix-sdk par salon
  (persisté en SQLite, re-déchiffrement tardif géré par le SDK), fil republié
  seulement s'il change ; historique par pages de 30 événements jusqu'à ~30
  messages affichables (`loadRoomHistory`), accusé de lecture à l'ouverture.
  Les fils de TOUS les salons sont publiés : l'interface en tire les non-lus
  comme aujourd'hui (`ChannelItem`, `ChannelList`), rien à porter côté cœur.
- `epingles.rs` — identifiants des épinglés joints à chaque fil
  (`getPinnedEventIds`) et résumés (`getPinnedSummaries`), un épinglé hors du
  fil chargé étant lu dans le cache ou demandé au serveur.
- `medias.rs` — protocole `sion-media://localhost/<clé>` (Windows et Android :
  `http://sion-media.localhost/<clé>`) : la clé est opaque, les clés de
  déchiffrement ne quittent jamais Rust, le téléchargement est authentifié.
  Type MIME reconnu aux premiers octets.
- **Son et vidéo** : sous WebKitGTK, `<audio>` et `<video>` passent par
  GStreamer, qui ignore les protocoles personnalisés (déjà constaté le 17/09
  pour `asset://`). Le serveur média local sert donc aussi `/matrix/<clé>` :
  le cœur télécharge — et déchiffre — le média une fois, le dépose (0600) dans
  le dossier média, purgé après 24 h, et il est servi avec les requêtes par
  plage. `urlLecture()` de la façade fait la conversion.
- Pont : `matrix_fils`, `matrix_charger_historique`, `matrix_marquer_lu`,
  `matrix_epingles`, événement `matrix-messages` ; l'écran de développement
  affiche le fil (images, sons, vidéos, épinglés, « charger plus »).

**Parité vérifiée sur le compte de test : 113 messages comparés, 0 écart
strict** ; épinglés identiques (5 sur 2 salons). L'outil est devenu
`build-scripts/parite-moteurs.sh` : les deux moteurs remontent l'historique,
le banc JS a la crypto (en mémoire) comme le vrai Sion, et un message absent
d'un côté alors qu'il est dans la fenêtre chargée de l'autre est un écart.
`SION_PARITE_SORTIES=<dossier>` garde les sorties pour examen.

Écarts VOULUS (documentés dans `messages.rs` et `epingles.rs`) :

- **Éditions** : comme matrix-js-sdk, la dernière édition de l'auteur
  remplace tout le contenu, type compris (un « poke » corrigé devient un
  texte). Mais une réponse éditée reste une réponse (le JS perdait la
  relation), une « édition » par un autre que l'auteur est ignorée (le JS en
  affichait le texte : usurpation possible), une édition de média n'est pas
  affichée en double (le JS le faisait — visible dans le salon soundboard), et
  un média édité est marqué « modifié ».
- La miniature d'une image chiffrée, et le média d'un épinglé chiffré, sont
  servis déchiffrés ; le JS n'en affichait aucun.
- L'heure affichée (`time`) est calculée par l'interface.

Appris en route (27/09) :

- **Le cache d'événements n'écoute que les synchros qui suivent son
  activation** : il est activé avant la première synchro, sinon le fil de
  celle-ci lui échappait — mais APRÈS l'authentification (voir T5).
- `getEvents()` de matrix-js-sdk rend le tableau interne, qui grandit en place
  pendant un `scrollback` : noter sa longueur avant.
- Les futurs de matrix-sdk sont si imbriqués que le compilateur dépasse sa
  profondeur de requêtes (« queries overflow the depth limit »). La limite est
  relevée dans `sion-matrix` seulement, et ses méthodes publiques rendent des
  futurs en boîte : l'appli n'a rien à changer.
- Au lancement suivant, matrix-sdk ne recharge que le dernier segment du fil
  (souvent des événements d'appel, sans message) : c'est l'ouverture du salon
  qui remonte l'historique, depuis le disque d'abord. Le moteur JS, lui,
  refait une synchro initiale de 20 événements par salon à chaque lancement.

Reste pour le branchement de la vraie interface : le lecteur vidéo natif
reçoit aujourd'hui une URL http ou un fichier ; il devra accepter un média
`sion-media` (via `/matrix/<clé>`, ou le fichier déposé). `resolveServerEventId`
(échos locaux `~…`) relève de T3 (envoi).

### État — T3 (branche `feat/matrix-rust`, 27/09/2026)

Fait :

- `envoi.rs` — contenus construits À L'IDENTIQUE de `matrixService.ts` :
  texte (mentions `@Nom` → `formatted_body` + `m.mentions`, port de
  `parseMentions` et de ses tests), réponse, édition, réaction, poke, sondage
  (+ échéance Sion), vote, clôture, épinglage (bascule), fichier.
- `emission.rs` — envoi par `send_raw` (matrix-sdk chiffre d'office dans un
  salon chiffré), suppression, épinglage par l'état `m.room.pinned_events`,
  fichier téléversé chiffré si le salon l'est, GIF téléchargé par le cœur,
  taille maximale d'envoi. Chaque envoi rend l'identifiant serveur : pas
  d'écho local `~…`, donc rien à porter de `resolveServerEventId`.
- `membres.rs` — noms des membres calculés comme matrix-js-sdk
  (`shouldDisambiguate`) : matrix-sdk jugeait ambigu tout nom contenant un
  caractère invisible (« pierre 🏳️‍⚧️ » et son ZWJ).
- Pont : 13 commandes `matrix_envoyer_texte` … `matrix_taille_max_envoi` ; le
  fichier passe par `stage_media` (octets bruts) et doit être dans le dossier
  média ; façade `matrixCore.ts` ; saisie dans l'écran de développement.

**Aller-retour vérifié sur le compte de test** (`build-scripts/aller-retour.sh`) :
les deux moteurs tournent EN MÊME TEMPS, comme deux appareils, dans un salon
de test privé et chiffré (« Sion — banc d'essai des moteurs », réutilisé).
Chacun envoie la série complète — texte avec mention, réponse, édition,
réaction, poke, sondage + vote + clôture, fichier, message supprimé,
épinglage — et vérifie celle de l'autre ; côté JS, par les VRAIES fonctions de
`matrixService.ts`. Le fichier chiffré par Rust et le fichier du JS sont relus
octet pour octet. La parité T1/T2 reste à 0 écart (9 salons, 146 messages).

**Défaut du moteur JS actuel, trouvé en route** : `editMessage` envoie
l'édition par une requête REST brute, qui contourne le chiffrement du SDK — dans
un salon chiffré, **le nouveau texte d'un message édité part en clair** (le
serveur le lit). Même contournement pour les fichiers : `sendFileMessage` et
`sendImageUrl` téléversent en clair. Le cœur Rust chiffre les trois. À corriger
aussi dans le moteur JS tant qu'il reste celui livré.

Écart voulu, conséquence du défaut ci-dessus : un message indéchiffrable dont
l'édition (en clair) est lisible affiche le texte de l'édition, comme le JS.

Vu à l'écran le 27/09 au matin (écran de développement, piloté par
`xdotool`) : message tapé et envoyé par Entrée, poke, réaction 👍 — chacun
revenu par la synchro.

### État — T4 (branche `feat/matrix-rust`, 27/09/2026)

Fait :

- `administration.rs` (pur) — reconnaissance du salon d'administration
  (`findAdminRoom`, et le barème un peu différent de
  `getServerAdminUserIds`), administrateurs du serveur, lecture de
  `list-users` (`parseUserList`), niveaux avec les valeurs par défaut du JS,
  liste blanche du mandataire.
- `gestion.rs` — membres et niveaux d'un salon (`details_salon` : membres
  rejoints, niveaux, droit d'écrire, règle d'accès), invitation (avec partage
  de l'historique des clés, MSC4268, comme `shareHistoricKeys`), expulsion,
  bannissement, niveau d'un membre, rejoindre / quitter, nom / sujet / avatar
  du salon, règle d'accès, création de salon (même état initial et mêmes
  niveaux que `createChannel`, ouverture à tout le serveur si public par le
  robot puis repli sur l'invitation), MP (`createOrGetDMRoom` : m.direct, puis
  tout salon « en forme de MP », réinvitation, sinon création), profil,
  mot de passe et suppression d'appareil (UIA par mot de passe), suspension,
  inscription (étapes, puis compte et connexion), mandataire de l'API
  d'administration, commandes au robot d'administration.
- Pont : 27 commandes (générées avec leurs doublures « feature absente ») ;
  façade `matrixCore.ts` dont `requeteAdmin` lève la même erreur
  qu'`adminService.ts` (statut, errcode).

**Vérifié sur le compte de test** : parité des membres et niveaux, 0 écart
sur les 9 salons (noms, niveaux, droit d'écrire, règle d'accès, avatars) ;
`tests/gestion_reelle.rs` — création d'un salon privé vocal (état conforme
au JS, puis quitté), renommage et sujet aller-retour, MP existant retrouvé sans
rien créer, second appareil supprimé par mot de passe, mandataire (version du
serveur ; 403 sur l'API d'administration, le compte de test n'étant pas
administrateur ; chemin hors liste blanche refusé), salon d'administration
absent → « Admin room not found », inscription fermée sur ce serveur (403).

Pas vérifiable avec ce compte, donc seulement compilé et relu : invitation,
expulsion, bannissement (il faudrait une vraie personne à qui l'infliger),
changement de nom / avatar du compte (visibles dans tous les salons),
mot de passe, salon public (ouvert à tout le serveur), commandes du robot et
API d'administration réussies (le compte n'est pas administrateur). À refaire
avec un compte administrateur de test.

Appris en route (27/09) :

- **Salons en version 12 : le créateur a un niveau infini.** matrix-js-sdk le
  rend en `Infinity` (qui devient `null` en JSON) ; le cœur le code
  `i64::MAX`, que la façade rend en `Infinity`. matrix-sdk refuse à raison
  d'inscrire un créateur dans la table des niveaux (`CreatorInUsersMap`).
- L'état d'un salon tout juste créé n'arrive qu'à la synchro suivante.
- `checkSuspended` du moteur JS teste la suspension en ÉCRIVANT la partie
  locale de l'identifiant comme nom d'affichage ; le cœur réécrit le nom
  actuel. `registerUser` laissait un appareil orphelin (session créée à
  l'inscription puis nouvelle connexion) ; le cœur s'inscrit avec
  `inhibit_login`.
- Chaque méthode publique de `gestion.rs` rend un futur en boîte (enveloppe
  + jumelle suffixée `_`) : sans cela, le crate de l'appli dépassait sa
  profondeur de requêtes.

### État — T5 (branche `feat/matrix-rust`, 27/09/2026)

Fait (`confiance.rs`) :

- Vérification par emojis entre deux appareils du compte, avec la machine à
  états de `useMatrixStore` (`requesting` → `waiting` → `comparing` →
  `confirmed` → `done`, ou `cancelled` / `error`) : demande émise
  (`startCrossDeviceVerification`) ou reçue d'un autre appareil (acceptée
  d'office, comme le JS), emojis publiés par l'événement
  `matrix-verification`, confirmation, refus, annulation ; à l'issue,
  restauration de la sauvegarde avec les secrets reçus.
- Récupération par clé (`restoreKeyBackup`) : secrets importés, appareil
  vérifié, clés de la sauvegarde restaurées salon par salon.
- Amorçage d'un compte neuf (`bootstrapAll`) : signature croisée (UIA par mot
  de passe), stockage de secrets et sauvegarde, clé de récupération rendue ;
  nouvelle clé (`regenerateRecoveryKey`, la sauvegarde est gardée) ; état
  (`checkDeviceVerified`, `checkNeedsBootstrap`, `hasUndecryptableMessages`).
- Pont : 12 commandes et l'événement `matrix-verification` ; façade.

**Banc local** (`tests/banc_local.rs`, Continuwuity jetable en conteneur,
commande en tête du fichier) — deux passages verts de bout en bout :
inscription par jeton d'un compte neuf ; amorçage, second amorçage REFUSÉ ;
message chiffré sauvegardé ; second appareil qui le lit indéchiffrable puis le
déchiffre après la clé de récupération ; troisième appareil vérifié par
emojis avec le premier (mêmes 7 emojis des deux côtés) et lisant l'historique
grâce aux secrets reçus ; nouvelle clé (l'ancienne refusée). Et ce que T4 ne
pouvait pas vérifier sur le compte de test : commandes au robot
(`list-users`), API d'administration (200), suspension (MSC4323), salon public
ouvert d'office à un utilisateur par le robot, niveau, expulsion, invitation
acceptée, bannissement, nom / avatar / mot de passe d'un compte.

**Compte de test réel** : avec sa clé de récupération (facultative dans
`tests/compte_reel.rs`), l'appareil devient vérifié et la sauvegarde
re-déchiffre l'historique — les 17 messages chiffrés de Limonadistant
deviennent lisibles (indéchiffrables 58 → 41, le reste venant des appareils
éphémères des tests, sans sauvegarde).

Trois défauts trouvés et corrigés grâce au banc :

- **Le re-déchiffreur du cache d'événements (« R2D2 ») était mort-né** :
  activé avant l'authentification, il ne trouvait pas de machine de
  chiffrement et s'arrêtait pour de bon. Aucune clé arrivée en retard, ni
  restaurée, ne re-déchiffrait le fil. Le cache est désormais activé juste
  après l'authentification, avant la première synchro (`activer_cache`).
- **Le garde-fou de l'amorçage lisait le magasin local**, qui n'apprend
  l'account data qu'à la synchro suivante : un second amorçage, juste après le
  premier, PASSAIT (il aurait remplacé l'identité du compte). Il interroge
  maintenant le serveur (stockage de secrets ET identité de signature
  croisée), et refuse dans le doute.
- Après un import depuis la sauvegarde, le cœur redemande explicitement le
  déchiffrement des messages en échec du salon (`request_decryption`).

À savoir : une demande de vérification part vers TOUS les appareils du
compte ; chacun l'accepte et ceux qui ne sont pas retenus sont annulés (le JS
se comporte pareil).

**Vérification croisée entre moteurs** (`build-scripts/verification-croisee.sh`,
compte réel, 27/09) : le cas de la migration. Un appareil JS vérifié par la
clé de récupération (même déroulé que `restoreKeyBackup`) accepte la demande
d'un NOUVEL appareil Rust ; les deux affichent les mêmes emojis, confirment ;
l'appareil Rust est vérifié, reçoit la clé de sauvegarde par partage de
secrets et restaure 3 salons. Aucun autre appareil du compte ne doit tourner
pendant le test.

### État — T6 (branche `feat/matrix-rust`, 27/09/2026)

Inventaire des événements propres à Sion, dressé avant d'écrire du code :
`com.sion.soundboard` (métadonnées d'un son `m.audio`), `com.sion.meme`
(`m.video` / `m.image`, dans le salon de la soundboard), `com.sion.transcript`,
`com.sion.transcript.session`, `com.sion.transcript.summary_of` (clé d'un
message de résumé), `com.sion.voice_kick`, `com.sion.client_version` (état,
clé = utilisateur), `app.sion.poll_ends_ts` (fait en T3), `m.poke` (fait en
T3). Plus les notifications push (pousseur ntfy, règles) et les médias mxc lus
par la soundboard et la synthèse vocale.

Fait :

- `sion.rs` (pur) — lecture des sons (`listSounds` : métadonnées, dernière
  édition appliquée, gain ancien et nouveau format, voix), contenus d'ajout et
  d'édition de son, lecture et contenu des memes, versions des membres,
  ouverture du droit d'annonce de version.
- `fonctions_sion.rs` — salon de la soundboard (alias, création avec les
  niveaux du JS, ajout d'office de tout le serveur), sons et memes par
  pagination filtrée côté serveur (types voulus + `m.room.encrypted`, triés
  après déchiffrement), ajout (mêmes refus : 1 Mo, audio, 20 s), édition,
  suppression, envoi d'un meme préparé ; événements et états quelconques ;
  RELAIS EN DIRECT des événements `com.sion.*` (déchiffrés) vers l'interface,
  qui garde sa logique (transcriptions, éjection vocale) ; historique filtré
  (`backfillTranscript`) ; version publiée seulement si elle a changé ; nom
  d'appareil ; pousseur et règles de notification ; URL `sion-media` d'un mxc
  (remplace `mxcUrlToHttp` + jeton).
- Pont : 19 commandes et l'événement `matrix-evenement-sion` ; façade.

Vérifié : parité sur le compte réel, **227 sons et 25 memes identiques champ par
champ** entre `listSounds` / `listMemes` du JS et le cœur ; banc local —
salon de la soundboard créé et utilisateur ajouté d'office, refus d'ajout,
son ajouté / édité / relu octet pour octet / supprimé, meme, transcription
relayée en direct dans un salon chiffré et relue dans l'historique, versions,
droit d'annonce, nom d'appareil, pousseur déclaré puis retiré.

Écarts voulus : le droit d'annonce de version s'ouvre aussi dans un salon v12
dont on est créateur (le JS lisait la table des niveaux et s'y croyait à 0) ;
l'historique filtré demande aussi les événements chiffrés (un filtre serveur
sur `com.sion.transcript` ne voit rien dans un salon chiffré).

À savoir : une édition de son sans emoji garde l'emoji d'origine (règle du JS,
qui ne sait pas l'effacer par édition).

### Avatars et icônes de salon (27/09)

Le serveur refuse désormais les médias non authentifiés (403 « Unauthenticated
media is disabled » sur `/_matrix/media/v3/…`, constaté le 27/09). Les avatars
et icônes de salon, que le cœur fournissait jusque-là en URL de téléchargement
comme le moteur JS (`mxcUrlToHttp`), ne s'affichaient donc pas. Ils passent
maintenant par `sion-media` comme tous les autres médias (`?avatar=1` :
vignette 96×96 recadrée, téléchargée authentifiée par le cœur) : membres du
fil, participants vocaux, icônes de salon, écrans de gestion. La parité
compare leur présence, les URL différant par construction.

**Le moteur JS livré est touché de la même façon** : ses avatars, icônes et
vignettes d'images (`mxcToHttp`, `mxcToThumbnail`) sont des URL non
authentifiées ; seules les images déjà dans le cache de la webview peuvent
encore s'afficher.

**WebKitGTK ne réutilise pas une image `sion-media://`** déjà chargée dans la
page : un second `<img>` à la même adresse échoue aussitôt, sans redemander
le cœur (mesuré le 27/09 : une requête servie pour un avatar, une dizaine
d'échecs immédiats pour ses autres `<img>` ; `Cache-Control: no-store` n'y
change rien). Symptômes : avatars du fil vides, images du fil perdues au
défilement (`ImageDuFil` démonte et remonte), et TOUT vide après une
déconnexion-reconnexion dans la même appli (mêmes clés, donc mêmes
adresses). `repriseImages.ts` recharge une fois, sous une adresse unique,
toute image du cœur qui échoue (capture de l'erreur sur `window`, avant le
`onError` du composant) ; les aperçus de memes, décodés hors du document, le
font eux-mêmes. Une image du cœur ne doit donc JAMAIS être un fond CSS
(`background: url(…)`) : son échec ne lève aucun événement, elle reste vide
(mini-avatars du menu réduit, corrigés le 27/09).

### Salons fantômes (27/09)

Un salon quitté PUIS oublié depuis un autre appareil pendant que celui-ci est
éteint n'est plus jamais renvoyé par le serveur dans la synchro : cet appareil
le croyait encore rejoint (vu sur l'appareil de l'écran de développement, deux
salons de test restés affichés). Au démarrage de la synchro, puis toutes les
10 minutes, le cœur compare ses salons à `/joined_rooms` ; un fantôme est
quitté (matrix-sdk le marque alors quitté pour de bon), ou à défaut écarté de
la liste et des fils. Vérifié : les deux fantômes marqués quittés au lancement.

### Branchement de l'interface (27/09, en cours)

`SION_MATRIX_MOTEUR=rust` lance désormais la VRAIE interface de Sion sur le
cœur Rust (`=rust-apercu` garde l'écran de diagnostic). Le moteur JS reste le
défaut, son chemin inchangé :

- `services/moteur.ts` — drapeau du moteur, fixé au démarrage ; chaque
  fonction exportée de `matrixService.ts` s'y aiguille vers `matrixCore`.
- `services/cacheRust.ts` — ce que l'interface lit de façon synchrone
  (niveaux, membres, épinglés, versions, MP, salon d'administration),
  rafraîchi en arrière-plan ; une réponse fait redessiner.
- `stores/moteurRustStore.ts` — l'équivalent d'`initSync` : salons, fils,
  sons de réception, salon par défaut, épinglés, vérification, tâches de
  début de session.
- `useAuthStore` — connexion, inscription, reprise par le cœur ; identifiants
  sous une clé distincte, sans jeton.
- Soundboard et memeboard, administration (API par le mandataire du cœur,
  commandes au robot), écrans d'admin, membres, en-tête : aiguillés.
- Lecteur vidéo natif et memeboard : une URL `sion-media` ou un `mxc://`
  est résolu en fichier par le cœur (`fichier_media_matrix`).
- La voix passe par le cœur (étape 3, voir plus haut).
- Les erreurs JS non rattrapées partent dans le journal Rust.

Trouvé en route : en développement, les deux moteurs partagent le même
`localStorage` ; des identifiants d'une autre session ont renommé le compte de
test (nom repris de la session JS). Les identifiants d'un autre compte sont
désormais ignorés, et le nom n'est poussé que pour le compte connecté.

### État — étape 3, la voix (branche `feat/matrix-rust`, 27/09/2026)

MatrixRTC porté dans le cœur, limité à ce que Sion emploie :
- `rtc.rs` (pur) : appartenance `call.member` (même contenu que
  `MembershipManager.makeMyMembership`, plus `sion_muted` / `sion_deafened`),
  participants valables (`sessionMembershipsForSlot`), service LiveKit annoncé,
  clés en to-device (`ToDeviceKeyTransport`) et leur gestion
  (`RTCEncryptionManager` : clé partagée aux arrivants pendant 10 s,
  renouvelée au départ d'un participant, utilisée 1 s après sa
  distribution, index modulo 256). 13 tests.
- `voix.rs` : service trouvé comme `getMatrixRTCToken` (salon, autres
  salons, `.well-known`), jeton OpenID échangé contre un jeton LiveKit
  (`/sfu/get`), appartenance publiée et renouvelée (une heure de plus avant
  chaque échéance, même `created_ts`), mute et sourdine, départ ; clés reçues
  par la synchro (DÉCHIFFRÉES seulement, expéditeur garanti par Olm) et
  envoyées par `encrypt_and_send_raw_to_device`.
- Pont : les clés vont du cœur au moteur vocal natif SANS passer par la
  webview (`voice_native::importer_cle_e2ee`) ; départ publié aussi par le
  cœur à la fermeture de la fenêtre. Interface : branche Rust de
  `useVoiceChannel` (le reste du parcours — moteur natif, sons, mute — est
  inchangé), entrée automatique en vocal comme le moteur JS.

Vérifié :
- `tests/voix_locale.rs` (banc local, deux comptes, salon chiffré) : clés
  échangées sous les identités LiveKit, mute vu depuis l'autre compte,
  rotation au départ (la clé neuve ne va pas à celui qui part), retour
  servi avec la clé en usage, appel vide à la fin.
- `build-scripts/voix-croisee.sh` (compte réel) : le VRAI `MatrixRTCSession`
  de matrix-js-sdk voit l'appareil Rust comme participant, sous
  `@compte:serveur:APPAREIL` ; clés à l'identique dans les deux sens ; le
  jeton délivré par le service de sionchat.fr porte cette identité
  (`sub`). Le service hache le nom de la salle : même nom envoyé que le
  moteur JS, donc même salle.

Essai en vrai le 27/09 : conversation sans difficulté entre flamme (moteur
Rust) et flammemob (Sion habituel), dans un salon vocal en clair — après un
correctif : avec matrix-sdk compilé, rustls avait deux fournisseurs et
LiveKit paniquait à la connexion (ring installé par défaut, `d0a34a7`).
Puis dans un salon vocal chiffré : bon aussi (clé renouvelée à l'arrivée de
flammemob, sa clé reçue en une seconde, déchiffrement « Ok »).

Deux défauts trouvés en route, corrigés dans le cœur — le moteur JS a les
mêmes :
- au rejeu des clés (à chaque changement de participants), nos ANCIENNES
  clés étaient remises au moteur média avant la courante : il chiffrait un
  instant avec une clé que l'arrivant n'avait pas, et l'ordre par index se
  trompe quand l'index boucle (255 → 0). Seule la clé en usage est rejouée ;
- la barre latérale comptait l'expiration d'une appartenance depuis sa
  dernière réécriture et non depuis la jonction (`created_ts`) : un client
  parti sans le dire restait affiché des heures (picsou dans
  Chihuahuatistant, expiré depuis 1 h 30 pour MatrixRTC, affiché encore
  3 h 30).

## Bilan de l'étape 2 (27/09/2026)

T0 à T6 sont faites dans `sion-matrix`, exposées par le pont et la façade
`matrixCore.ts`. **L'interface de Sion, elle, tourne toujours sur le moteur
JS** : seul l'écran de développement (`SION_MATRIX_MOTEUR=rust`) parle au cœur
Rust. Le branchement de la vraie interface — `useMatrixStore` et les services
qui appellent `getMatrixClient()` — reste à faire, avec la voix (étape 3),
qui en dépend.

Outils de vérification, à relancer à chaque changement du cœur :

- `build-scripts/parite-moteurs.sh` (compte réel) : salons, messages, membres
  et niveaux, soundboard et memes, les deux moteurs comparés champ par champ ;
- `build-scripts/aller-retour.sh` (compte réel) : les deux moteurs en
  parallèle dans un salon chiffré, envoi et lecture croisés ;
- `build-scripts/verification-croisee.sh` (compte réel) : un appareil JS
  vérifié vérifie par emojis un nouvel appareil Rust ;
- `build-scripts/voix-croisee.sh` (compte réel) : la voix entre le vrai
  `MatrixRTCSession` et le cœur (appartenances, clés, jeton LiveKit) ;
- `tests/voix_locale.rs` (banc local) : la voix entre deux comptes ;
- `tests/compte_reel.rs`, `tests/gestion_reelle.rs` (compte réel) ;
- `tests/banc_local.rs` (Continuwuity jetable en conteneur) : compte neuf,
  chiffrement et confiance, administration, fonctions propres à Sion.

Défauts du moteur JS actuel trouvés en route, à corriger de son côté tant
qu'il est livré : éditions, fichiers et GIF envoyés EN CLAIR dans un salon
chiffré (T3) ; `checkSuspended` qui réécrit le nom d'affichage, `registerUser`
qui laisse un appareil orphelin (T4) ; une « édition » par un autre que
l'auteur affichée (T2).

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
