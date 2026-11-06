# Fondateur-QuartierPlus
Plateforme hybride communautaire, sécuritaire et sociale

## Schéma PostgreSQL du serveur

Pour une base serveur vierge disposant des extensions PostgreSQL `uuid-ossp` et
PostGIS, exécuter dans cet ordre :

```sh
psql "$DATABASE_URL" -f server/db/init.sql
psql "$DATABASE_URL" -f server/db/seeds.sql
```

`init.sql` crée le schéma idempotent utilisé par l'API; `seeds.sql` peut être
rejoué pour mettre à jour les pays et créer les canaux MVP sans doublons.
Les seeds couvrent 193 membres de l'ONU ainsi que Taïwan, le Kosovo, la
Palestine et le Vatican. Les préfixes détaillés sont stockés dans
`country_phone_prefixes`; l'API choisit le préfixe correspondant le plus long
pour distinguer les plans partagés comme +1 et +7.
Les numéros d'urgence inconnus sont laissés vides plutôt que supposés égaux à
112.
`server/db/schema.sql` est un ancien schéma initial : ne pas le combiner avec
`init.sql` ni avec `database/schema.sql`, qui définit déjà des tables `users`
et `sos_alerts` avec des colonnes différentes.

## API Express et authentification

L'API du dossier `server/` utilise Node.js, Express et PostgreSQL (`pg`).
Copier `server/.env.example` vers `server/.env`, renseigner `DATABASE_URL` et
un `JWT_SECRET` aléatoire d'au moins 32 caractères, puis lancer `npm install`
et `npm start` depuis `server/`. En production, le serveur refuse aussi de
démarrer sans la livraison SMS HTTPS, Google OAuth, les trois variables
LiveKit et un `TICKET_QR_SECRET` distinct d'au moins 32 caractères. Pour une
base créée avec l'ancien schéma A.1,
appliquer `server/db/auth-migration.sql`; une nouvelle base utilise directement
`server/db/init.sql`, puis `server/db/seeds.sql`. Pour une base existante avant la prise en charge du type
d'urgence SOS, appliquer aussi `server/db/sos-emergency-type-migration.sql`.
Avant de déployer une version utilisant la détection mondiale des pays sur une
base existante, rejouer aussi `server/db/init.sql`, puis `server/db/seeds.sql`.

`POST /api/v1/auth/request-otp` accepte un identifiant de connexion (téléphone
E.164 ou e-mail) et envoie un code au numéro vérifié du compte. Pour
l'inscription, il reçoit prénom, nom, pays, téléphone E.164, e-mail et
confirmation obligatoire des conditions/confidentialité; le compte est créé
seulement après validation du code. Un identifiant inconnu reçoit une réponse
qui propose de créer un compte. En développement, `OTP_TEST_MODE=true` n'active le code fixe
`123456` que pour les numéros E.164 listés dans `OTP_TEST_ALLOWLIST` (séparés
par des virgules); les autres numéros utilisent un code aléatoire et la
livraison SMS normale. Le mode est refusé au démarrage en production, même avec
une liste blanche.
En production, configurer `SMS_DELIVERY_URL` et `SMS_DELIVERY_TOKEN`: le serveur
fait un POST HTTPS avec Bearer et un JSON `{ "to", "message" }` au relais SMS.
Les codes expirent après cinq minutes, sont stockés sous forme de HMAC, sont
limités à cinq essais et une demande par minute et par numéro; des limiteurs
supplémentaires s'appliquent par IP.

`POST /api/v1/auth/verify-otp` accepte `{ "identifier", "code" }` et renvoie
un JWT d'application avec le profil. `POST /api/v1/auth/google` accepte un
`id_token`, un `access_token` ou un `credential` Google vérifié par le serveur
avec `GOOGLE_CLIENT_ID` et, facultativement, les identifiants supplémentaires
de `GOOGLE_CLIENT_IDS` (liste séparée par des virgules); l'adresse e-mail doit
être vérifiée par Google.
Le premier lancement propose le parcours invité : « Explorer l'app » ouvre les
écrans accessibles sans compte. Les actions nécessitant une identité affichent
la demande de connexion; les informations d'urgence invitées restent
disponibles depuis le profil.
`GET` et `PUT /api/v1/users/me` nécessitent `Authorization: Bearer <JWT>`.
Les routes `/v1/...` sont aussi montées pour compatibilité avec l'URL d'API
utilisée par l'application mobile.

### Authentification mobile B.2

L'inscription mobile collecte prénom(s), nom, pays/indicatif, téléphone,
e-mail et l'acceptation des conditions et de la politique de confidentialité.
Elle envoie un code à six chiffres par
`POST /api/v1/auth/request-otp`, puis le valide par
`POST /api/v1/auth/verify-otp`; la connexion n'affiche que le téléphone E.164
ou l'e-mail comme identifiant, puis le code. Un e-mail de connexion reçoit le
code par SMS au numéro vérifié associé. Le client tolère jusqu'à 60 secondes
pour le réveil de l'API et affiche les erreurs en français. Le JWT et le profil
retournés sont conservés via `AuthContext` et le stockage sécurisé natif.
Google Sign-In utilise `@react-native-google-signin/google-signin`, configure
le client OAuth Web et transmet l'ID token à `POST /api/v1/auth/google`.

Copier `mobile/.env.example` pour la configuration locale. Configurer
`EXPO_PUBLIC_API_URL` ainsi que les identifiants OAuth publics
`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` et `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` dans
l'environnement Expo. Android charge son client OAuth natif depuis
`mobile/google-services.json` ; Firebase doit contenir les SHA-1 et SHA-256 du
certificat de signature EAS. Le serveur doit accepter le client Web via
`GOOGLE_CLIENT_ID` ou `GOOGLE_CLIENT_IDS`. Configurer également
`EXPO_PUBLIC_LIVEKIT_URL` et `EXPO_PUBLIC_EAS_PROJECT_ID` ; ces valeurs OAuth
publiques ne sont pas des secrets. L'application utilise le schéma de
redirection `quartierplus`.

Pour enregistrer le canal OTA, lancer manuellement le workflow
`.github/workflows/eas-setup.yml`; il vérifie le compte `quartierplus_bf` et
relie `preview` à la branche `preview`. Les publications passent ensuite par
`.github/workflows/eas-update.yml` et ciblent cette branche.

Après vérification OTP, un compte avec prénom et nom entre directement dans
l'application; le quartier peut être ajouté ensuite au profil. Les comptes
sans nom peuvent utiliser l'écran de finalisation de profil.

## Socket.IO (SOS et canaux)

Le même serveur HTTP que Express héberge Socket.IO. Toute connexion doit
présenter le JWT applicatif dans `auth.token` (ou `auth.accessToken`) lors du
handshake; les connexions non authentifiées ou dont l'utilisateur n'existe
plus sont refusées. Configurer `SOCKET_CORS_ORIGIN` avec les origines web
autorisées, séparées par des virgules, pour activer le transport polling depuis
un navigateur.

Les clients envoient `sos:location_update` avec `{ "latitude", "longitude" }`
pour enregistrer leur position temporairement en mémoire serveur; elle n'est
pas écrite dans PostgreSQL ni diffusée. `sos:trigger` reçoit ces coordonnées
(et facultativement `escalation_level` de 1 à 3 et `emergency_image_url` HTTPS),
crée une alerte et diffuse `sos:new_alert` uniquement aux sockets dont la
position temporaire est à moins de 3, 10 ou 30 km (niveaux 1, 2 ou 3). Seuls
l'auteur et les métadonnées publiques de l'alerte sont enregistrés; aucune
identité d'utilisateur n'est incluse dans les émissions. `sos:resolve` et
`sos:cancel` n'acceptent que les alertes actives de l'utilisateur authentifié
et diffusent respectivement `sos:resolved` et `sos:cancelled` aux voisins
présents dans le même rayon.

`channel:join` et `channel:leave` acceptent l'UUID du canal ou les alias
`emergency`/`URGENCES` et `announcements`/`ANNONCES`. `channel:send_message`
accepte `channel_id`, `body` (ou `content`) et, facultativement, `media_url`
HTTPS avec `media_type`. Le serveur vérifie l'appartenance au salon,
enregistre le message dans PostgreSQL et émet `channel:new_message`. Les noms
historiques `join_channel`, `leave_channel` et `new_message` sont maintenus
pour les versions mobiles existantes. Les coordonnées temporaires de présence
étant en mémoire de processus, une présence distribuée multi-instance devra
utiliser un adaptateur Socket.IO et un stockage partagé avant le déploiement
multi-réplicas.

## Talkie-walkie, notifications et paramètres B.5

Pour une base existante, appliquer `server/db/notifications-migration.sql`
après le schéma A.1. Cette migration crée les jetons push et les abonnements
persistants aux canaux; les notifications de messages sont envoyées uniquement
aux utilisateurs abonnés et excluent l'expéditeur. Quitter explicitement un
canal supprime l'abonnement, tandis qu'une déconnexion réseau conserve
l'abonnement pour permettre les notifications en arrière-plan.

Configurer `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` et `LIVEKIT_URL` dans
`server/.env` pour le service de jetons audio. Pour l'application native,
configurer l'identifiant de projet EAS dans `EXPO_PUBLIC_EAS_PROJECT_ID` ou
`expo.extra.eas.projectId`, et configurer les credentials push Android/iOS
dans EAS. Le client utilise Expo Push Tokens; il ne s'agit pas d'un jeton FCM
direct. Sans projet EAS et credentials natifs valides, l'enregistrement ou la
livraison push ne peut pas fonctionner.

L'onglet Talkie rejoint la room LiveKit `emergency`, garde le microphone coupé
par défaut et ne le publie que pendant l'appui maintenu. Les préférences de
thème, de langue et d'alertes SOS ainsi que les contacts SOS sont enregistrés
localement; la mise à jour du numéro de téléphone nécessite la confirmation
d'un OTP envoyé au nouveau numéro.

## Grin du quartier C.1

L'onglet `Grin` rejoint la room LiveKit `grin`. Le service de jetons autorise
les pistes caméra/microphone dans cette room et limite sa capacité à six
participants. La caméra et le microphone ne sont activés qu'après l'action
explicite « Prendre une chaise »; les participants peuvent ensuite les couper
individuellement.

Le PiP iOS utilise la prise en charge native de `VideoTrack` de LiveKit. Sur
Android, le module Expo local `mobile/modules/grin-pip` active le mode PiP de
l'activité via son bouton dédié; le plugin `mobile/plugins/withGrinPip.js`
configure le manifeste lors du prebuild. Ces intégrations natives demandent un
rebuild EAS/de développement natif et ne fonctionnent pas dans Expo Go. Le PiP
Android nécessite Android 8 ou ultérieur.

## Carte Radar

Le schéma PostGIS de `database/schema.sql` définit les marqueurs publics de la
carte, leurs catégories et les confirmations de coupure. Les incidents
électricité/eau restent `CONFIRMING` jusqu'à trois validations distinctes dans
les 30 minutes. `confirm_map_outage` valide une position située à 500 m au plus
du marqueur (hors auteur du signalement); la position de validation est un
argument temporaire et n'est pas enregistrée dans `map_marker_confirmations`.
L'API doit appeler `expire_unconfirmed_map_outages` lors de la lecture des
marqueurs ou via une tâche planifiée pour clore les signalements non confirmés.

L'application mobile attend les routes suivantes sur l'API configurée par
`EXPO_PUBLIC_API_URL` :

- `GET /v1/map/markers?latitude=...&longitude=...&radius_m=...` renvoie un
  tableau de marqueurs ou `{ "markers": [...] }`. Les coordonnées sont des
  objets `{ "latitude": ..., "longitude": ... }` ou des coordonnées GeoJSON
  `[longitude, latitude]`. Pour les commerces, `catalog_url` (HTTPS) ouvre la
  fiche catalogue. Les épingles sponsorisées sont mises en évidence; le forfait
  de visibilité radar est affiché à 2 000 FCFA/semaine.
- `POST /v1/map/markers` crée un signalement de coupure et renvoie le marqueur
  créé en `CONFIRMING`.
- `POST /v1/map/markers/{id}/confirm` reçoit la latitude/longitude GPS courante,
  applique côté serveur les contrôles de proximité et d'identité, puis renvoie
  le marqueur actualisé.
- Les événements Socket.IO `map:marker:new` et `map:marker:update` diffusent les
  changements de marqueurs publics.

Les coordonnées de confirmation ne doivent pas être conservées ni diffusées.
L'API doit dériver l'identité du déclarant/validateur de la session authentifiée,
et non accepter un `user_id` fourni par le client; les `user_id` des marqueurs et
des validations ne doivent pas figurer dans les réponses publiques. Les alertes
SOS restent prioritaires et les seules positions individuelles montrées à
l'utilisateur sont celles des alertes SOS actives; aucun marqueur de position
des autres citoyens n'est diffusé.

## Profil MVP

L'écran Profil récupère les informations de l'utilisateur courant depuis
`GET /v1/users/me` et enregistre son nom, son quartier et son pays actif via
`PUT /v1/users/me`. La réponse peut contenir l'objet utilisateur directement
ou sous la clé `user`; elle doit fournir `name`, `neighborhood`, `role`,
`reputation_score` et `is_verified` (les noms `full_name`, `user_type`,
`reputationScore` et `isVerified` sont aussi acceptés côté client). Le rôle
`relay`/`Voisin Relais` affiche le badge « Voisin Relais »; les autres rôles
affichent « Habitant ».

Le sélecteur propose le Burkina Faso, la Côte d'Ivoire, le Mali et le Sénégal.
Le pays choisi ainsi que les contacts SOS de confiance (maximum trois, nom et
téléphone) sont conservés dans la base SQLite locale du mobile pour rester
disponibles hors ligne. Les numéros d'urgence affichés sont ceux configurés
localement pour le pays choisi.

## Architecture mobile hors ligne

L'application mobile initialise `quartierplus-offline.db` avec `expo-sqlite`.
Les réponses GET de l'API sont mises en cache; si NetInfo détecte l'absence
d'accès Internet, le client Axios restitue la dernière réponse locale
disponible, ou remonte explicitement une erreur si aucun cache n'existe. Les
annonces et alertes sont aussi indexées dans `cached_posts` et `cached_alerts`.
La persistance TanStack Query conserve son cache 24 heures dans SQLite et
NetInfo/React Native réactive les requêtes lorsque le réseau revient.

Le token de session natif est conservé dans `expo-secure-store` et injecté
automatiquement dans les appels HTTP. Le `AuthProvider` expose `user`, `token`,
`isOffline`, la restauration/actualisation de session, `setSession`, la
déconnexion et la file d'actions hors ligne. Les annonces et SOS lancés sans
réseau depuis le flux de capture photo/audio sont stockés dans `sync_queue`,
liés au compte, puis rejoués au retour de la connexion. Les pièces jointes
correspondantes sont copiées dans le dossier document persistant de
l'application. Une alerte SOS en attente n'est pas présentée comme transmise;
l'écran prévient l'utilisateur et lui recommande d'appeler les secours pour une
urgence immédiate.

Le bouton SOS principal de la carte utilise `sos:trigger` sur la socket
authentifiée et affiche un compte à rebours annulable de trois secondes. Le
type d'urgence (médical, sécurité ou incendie) et le niveau d'escalade (3, 10
ou 30 km) sont transmis au serveur. La position GPS est envoyée à
`sos:location_update` à la connexion et à chaque mise à jour significative.
Lorsque NetInfo détecte l'absence de réseau de données, le bouton charge les
contacts de confiance dans `quartierplus.db` et ouvre le compositeur SMS avec
leurs numéros, les coordonnées brutes et un lien Google Maps. L'utilisateur
doit confirmer l'envoi dans l'application SMS native; le client ne prétend pas
qu'un SMS a été transmis automatiquement. Les données précédemment stockées
dans `quartierplus-profile.db` sont migrées vers la base commune sans perdre
les contacts ou le pays configuré.

Sur web, le réseau/cache s'appuie sur NetInfo et `localStorage`, et non sur le
coffre natif SecureStore/SQLite. Ne pas considérer le stockage de session web
comme équivalent au Keychain/Keystore natif.

## Messagerie MVP

L'écran mobile affiche uniquement les canaux `emergency` (URGENCES, sélectionné
par défaut) et `announcements` (ANNONCES). Les messages se chargent depuis
`GET /v1/channels/{channelId}/messages` (tableau ou `{ "messages": [...] }`) et
sont envoyés à `POST /v1/channels/{channelId}/messages`. Une photo est redimensionnée
et compressée en WebP avant d'être envoyée en multipart sous le champ `image`;
la réponse contient le message créé.

Le client Socket.IO rejoint le canal par `join_channel` avec `{ "channel_id":
"..." }`, écoute `new_message` (le payload doit contenir `channel_id`) et le
quitte par `leave_channel`. Les appuis longs signalent à `POST /v1/reports` avec
`{ "target_type": "message", "target_id": "...", "reason": "..." }`.
L'API doit dériver l'auteur des messages et signalements de la session
authentifiée, et vérifier que l'utilisateur a accès au canal et au message
signalé.

L'onglet `Privés` charge `GET /v1/conversations` (tableau ou
`{ "conversations": [...] }`). Chaque entrée doit contenir `id`, les données du
correspondant (`participant: { "id", "name", "type" }` ou les champs
`participant_id`, `participant_name`, `participant_type`), ainsi que
`last_message`, `updated_at` et `unread_count` facultatifs. Le type du
correspondant distingue un voisin (`neighbor`) d'un vendeur (`seller`). Ouvrir
une entrée charge `GET /v1/conversations/{id}/messages`; l'envoi texte ou photo
utilise `POST /v1/conversations/{id}/messages`, au même format JSON ou multipart
que pour un canal.

Les derniers 100 messages de chaque canal et conversation sont enregistrés
localement, isolés par compte et effacés à la déconnexion. À l'ouverture hors
ligne ou si le chargement réseau échoue, l'écran affiche ces messages avec une
indication explicite de leur origine locale. Les événements Socket.IO
`new_message`, `channel:new_message` et `chat:message` actualisent le fil et le
cache local.

Le PTT utilise le SDK natif LiveKit et requiert une compilation Expo
development-build (il n'est pas disponible dans Expo Go). Configurer
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` et `LIVEKIT_URL` dans l'environnement
du serveur; ne jamais embarquer les identifiants secrets dans le client.
`POST /api/v1/livekit/token` (alias `/v1/livekit/token`) exige
`Authorization: Bearer <JWT>` et accepte `{ "roomName": "channel_<id>" }`,
`{ "roomName": "sos_<id>" }` ou, pour compatibilité, `{ "room": "emergency" }`.
Le jeton LiveKit, limité à la room et à l'identité du compte authentifié, expire
après dix minutes; il autorise la connexion, la réception audio et la
publication microphone seulement. La réponse `{ "token": "...", "url":
"wss://..." }` est consommée par le client PTT.

## Marché MVP

L'écran Marché récupère la position foreground et appelle
`GET /v1/marketplace/items` avec `latitude`, `longitude`, `radius_m`,
`item_type` (`listing`, `local` ou `service`), `category` (omis pour « Tous »)
et le pays lorsqu'un pays précis est sélectionné. La réponse est un tableau ou
`{ "items": [...] }`; chaque objet fournit `id`, `title`, `category`,
`item_type`, un `price` numérique et `currency: "FCFA"` ou `is_free: true`,
ainsi que les données de vendeur/contact (`seller.name`, `seller.phone`,
`seller.whatsapp`) nécessaires à l'affichage et au contact direct. Les
catégories envoyées par le client sont en majuscules (`ALIMENTATION`,
`ELECTRONIQUE`, `MODE`, `EQUIPEMENTS`, `MADE_IN`, `ELECTRICITE`, `PLOMBERIE`, `MACONNERIE`,
`COUTURE`, `BOULANGERIE`); `ALL` est omis de la requête.

Le formulaire du FAB envoie les annonces multipart à `POST
/v1/marketplace/items` avec les champs `title`, `description`, `category`,
`item_type`, `price` (omis en cas de don), `is_free`, `currency: "FCFA"`,
`location` (JSON `{ "latitude": ..., "longitude": ... }`) et l'image WebP
facultative `image`, strictement inférieure à 300 Ko. Le serveur doit valider à
nouveau titre, catégorie, prix/devise et coordonnées. Le signalement d'une
annonce passe par `POST /v1/reports` avec
`{ "target_type": "marketplace_item", "target_id": "...", "reason": "..." }`.

## Fil de proximité B.4

L'onglet Accueil affiche les annonces du Marché et alertes SOS proches depuis
`GET /v1/marketplace/items` et `GET /v1/sos/alerts`. Il lit aussi les dernières
réponses mémorisées dans `cached_posts` et `cached_alerts` hors ligne.
L'actualisation manuelle recharge la position et les résultats.

La publication avec synchronisation différée est disponible dans l'onglet
Marché: hors ligne, le formulaire stocke le brouillon et sa photo persistante
dans `sync_queue`; `AuthContext` le rejoue sur
`POST /v1/marketplace/items` lors du retour du réseau. Les routes REST Marché,
SOS et lecture des canaux décrites dans ce document restent des contrats côté
client et ne sont pas encore montées dans le serveur Express présent dans ce
dépôt. Tant qu'elles ne sont pas déployées, le fil affiche une erreur explicite
et conserve les données déjà mises en cache.

## Assistant vocal global C.2 — Écran 4

Le bouton microphone flottant ouvre l'assistant sur les écrans invités et
authentifiés. Un bouton microphone est également disponible dans les champs de
messages, annonces, profil et recherche. Chaque activation lance une seule
reconnaissance (aucune écoute continue). Au premier usage, un écran explique la
permission avant la demande système. Si la reconnaissance n'est pas disponible,
les microphones sont masqués et l'application affiche « Reconnaissance vocale
indisponible ».

La reconnaissance native utilise la langue enregistrée dans les préférences
(fr-FR par défaut, en-US pour l'application en anglais) et `expo-speech` lit les
réponses. Les commandes locales ouvrent la carte, le Marché, les canaux
URGENCES/ANNONCES, le profil et les messages, proposent la dictée, ou ouvrent
les formulaires d'annonce sans publier. Un appel aux secours officiels ouvre le
composeur du téléphone avec les numéros du pays sélectionné et ne requiert pas
de compte. Une commande inconnue propose des exemples reconnus.

« Lancer un SOS » exige une seconde confirmation vocale (« confirmer ») ou une
action explicite dans l'assistant, puis un compte à rebours annulable. L'écran
SOS conserve sa confirmation et son compte à rebours de publication. Toute
action protégée en mode invité propose la connexion.

L'audio n'est ni stocké ni envoyé à QuartierPlus; le système de reconnaissance
du téléphone peut traiter la voix. Le texte reconnu n'est pas écrit dans les
journaux ni dans Crashlytics. Le microphone n'est actif que pendant une
activation ponctuelle et son état est affiché. La compilation native Android
doit être régénérée (APK/EAS, pas Expo Go ni OTA) pour embarquer
`expo-speech-recognition` et `RECORD_AUDIO`. Hors ligne, la dictée nécessite un
modèle de langue installé; les commandes restent locales.

Les intentions et synonymes testés sont dans
[`mobile/src/services/voiceAssistant.ts`](./mobile/src/services/voiceAssistant.ts);
voir aussi le [cahier vocal](./docs/VOICE_ASSISTANT.md).

## Billetterie anti-fraude D.4

Pour activer l’accès gratuit de découverte, définir `IS_PROMO_FREE_ACCESS=true`
dans l’environnement du serveur; la valeur par défaut est `false`. Le serveur
renvoie cette configuration au mobile et accorde alors aux comptes connectés
l’accès à la création d’événements ainsi qu’aux tableaux de bord Pro sans
abonnement. La période découverte ne rend pas gratuits les billets payants.

Appliquer `migrations/007_events_ticketing.sql` après le schéma serveur et les
migrations monétisation précédentes. Configurer `TICKET_QR_SECRET` avec une clé
aléatoire stable d’au moins 32 caractères (obligatoire en production); la
modifier invalide les signatures de pass déjà émis. Les réservations de billets
payants retiennent une place jusqu’à la confirmation ou l’annulation FedaPay.
Les notifications webhook FedaPay doivent donc être configurées pour finaliser
les transactions et libérer les réservations non payées.

`GET /v1/events` liste les événements publiés. La création passe par
`POST /v1/events`, protégée par Alliance Pro ou le mode découverte. `POST
/v1/events/:id/buy-ticket` émet immédiatement un pass HMAC pour un billet
gratuit, ou renvoie l’URL de paiement FedaPay; le pass payé n’est créé qu’après
validation du webhook. `GET /v1/tickets/my-tickets` renvoie les QR codes signés.
`POST /v1/tickets/scan` n’accepte que les billets des événements de
l’organisateur authentifié, vérifie la signature et marque atomiquement le
premier scan comme utilisé. La réponse de scan expose `SUCCESS`,
`ALREADY_USED` ou `INVALID_TICKET`. Le compteur d’entrées organisateur est
actualisé toutes les dix secondes dans l’application.

L’application nécessite un rebuild natif avec `expo-camera` et `expo-brightness`
pour le scan QR et l’augmentation temporaire de luminosité. `react-native-svg`
et `react-native-qrcode-svg` rendent les passes localement, sans transmettre le
code de billet à un service QR tiers.

## Fonctionnalités Pro D.3

Après la migration FedaPay 005, appliquer `migrations/006_pro_selected_features.sql`
sur le schéma serveur (`server/db/schema.sql`). Le checkout ouvre FedaPay pour
Alliance Pro (5 000 FCFA/mois), Syndic (2 500 FCFA/mois), Mairie (75 000
FCFA/mois), Accès Certifié Secours (50 000 FCFA/mois) et l'épingle sponsorisée
(2 000 FCFA/semaine). Seul le webhook FedaPay vérifié active l'abonnement.

Les rattachements `residence_members` et `municipality_members`, les résidences,
les municipalités (centre GPS et rayon), les artisans, les certificats de
secouristes et les fiches `emergency_profiles` doivent être administrés côté
base; les UUID envoyés par le client sont vérifiés contre ces rattachements.
Une fiche médicale absente est représentée par `{}`. Le regroupement Mairie
utilise les alertes SOS actives géolocalisées des sept derniers jours, agrégées
par type et cellule d'environ 1 km; le centre et le rayon configurés pour la
municipalité délimitent les résultats. Les ventes flash ciblent les jetons push
des citoyens avec une position connue à moins de 800 m.
