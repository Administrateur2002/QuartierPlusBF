# Déployer l'API QuartierPlus sur Render

## Ce qu'il faut savoir

- Serveur : Node.js 20, Express 5.1.0, écoute sur `PORT` (3000 par défaut en
  local). La commande de démarrage est `npm start`, soit `node index.js`.
  `server/package.json` ne verrouille pas le numéro de Node ; les workflows du
  dépôt utilisent Node 20.
- Base requise : PostgreSQL avec les extensions `uuid-ossp` et **PostGIS**. Le
  schéma utilise des colonnes spatiales ; PostgreSQL seul ne suffit pas.
- `GET /health` répond immédiatement avec le statut, le commit Render et la
  version du contrat API sans effectuer de requête SQL. Au démarrage, l'API
  attend toutefois la création idempotente des canaux publics par pays.
- Le démarrage (`npm start`) n'exécute pas de migration. Sur une base existante,
  appliquez les migrations manquantes ci-dessous avant de déployer le code.
- L'API de production est hébergée sur Render. Les workflows de build et de
  mise à jour EAS utilisent son URL publique par défaut; un secret GitHub
  `EXPO_PUBLIC_API_URL` défini explicitement la remplace.

## Flux de déploiement

- Un push sur la branche reliée à Render déploie le serveur. Dans Render,
  ouvrez **Settings → Build & Deploy → Build Filters** et ajoutez `server/**`
  aux chemins inclus : un changement limité à `mobile/` ne redéploiera alors
  pas l'API.
- Pour une modification de l'interface sans changement natif, lancez
  manuellement le workflow **EAS Update (OTA)** dans GitHub Actions. Il compare
  l'empreinte native Android aux derniers APK avant de publier.
- Pour une nouvelle dépendance native, un plugin ou une permission, lancez
  manuellement **Build Android Preview APK**. Une OTA ne remplace pas un nouvel
  APK; relancez ensuite **EAS Update (OTA)** si nécessaire.

## 1. Créer la base PostgreSQL

Depuis le téléphone, créez une base dans Neon ou Supabase et copiez son URL de
connexion PostgreSQL complète. Gardez-la privée : elle contient les
informations d'accès à la base.

Dans l'éditeur SQL de cette base, assurez-vous que les extensions suivantes
sont activées :

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
```

Puis exécutez, sans supprimer de table ni de données, dans cet ordre :

1. `server/db/init.sql`
2. `server/db/country-config-radius-migration.sql`
3. `server/db/auth-migration.sql`
4. `server/db/notifications-migration.sql`
5. `server/db/posts-migration.sql`
6. `server/db/push-tokens-migration.sql`
7. `server/db/sos-emergency-type-migration.sql`
8. `migrations/005_monetization_fedapay.sql`
9. `migrations/006_pro_selected_features.sql`
10. `migrations/007_events_ticketing.sql`
11. `migrations/008_posts_text_only_fallback.sql`
12. `migrations/009_sos_assists.sql`
13. `migrations/010_mobile_api_contract.sql`
14. `migrations/011_country_channels.sql`
15. `migrations/012_sos_moderation_queue.sql`
16. `migrations/013_map_lost_items.sql`
17. `migrations/014_sos_audio_media.sql`
18. `migrations/015_marketplace_country_of_origin.sql`
19. `migrations/016_sponsored_pin_publication.sql`
20. `migrations/017_pro_offer_publication.sql`
21. `migrations/018_quartierplus_pro.sql`
22. `server/db/seeds.sql`
23. `migrations/019_quartierplus_voyage.sql`
24. `migrations/020_social_alliance_location.sql`
25. `migrations/021_post_comment_interactions.sql`
26. `migrations/022_user_blocks.sql`
27. `migrations/023_private_message_media.sql`
28. `migrations/024_community_alliances.sql`
29. `migrations/025_commerce_growth_offers.sql`
30. `migrations/026_user_profile_photos.sql`
31. `migrations/027_wholesaler_optional_registration_fields.sql`
32. `migrations/028_voyage_station_reservations.sql`
33. `migrations/029_post_media_carousel.sql`
34. `migrations/030_internal_post_shares.sql`
35. `migrations/031_pro_map_impressions.sql`
36. `migrations/032_pro_reviews.sql`
37. `migrations/033_sponsored_pin_impressions.sql`
38. `migrations/034_grin_live_moderation.sql`
39. `migrations/035_secure_admin_workspace.sql`
40. `migrations/036_post_upload_moderation.sql`
41. `migrations/037_public_text_conflicts.sql`
42. `migrations/038_legal_document_acceptances.sql`
43. `migrations/039_usage_limits.sql`
44. `migrations/040_account_deletion_retention.sql`

Pour une base Neon neuve, exécutez chaque fichier une seule fois dans l'éditeur
SQL, dans cet ordre. `auth-migration.sql` utilise des opérations idempotentes
et peut être relancé sans supprimer de données. Les migrations 006 et 007
dépendent des tables introduites par la migration 005. Ne relancez pas
`init.sql` sur une base déjà utilisée ; choisissez les migrations adaptées à
la version de cette base. `country-config-radius-migration.sql` est idempotente
et ajoute le rayon de quartier configurable (`default_radius_m`, 5 km par
défaut) aux configurations de pays existantes. Le seed est rejouable et active
notamment le Burkina Faso, la Côte d’Ivoire, le Sénégal et le Mali.
`posts-migration.sql` crée les publications média et leurs index sans modifier
les tables de la place de marché existantes. La migration 008 rend les colonnes
média facultatives pour autoriser une publication texte si Cloudinary échoue;
exécutez-la uniquement après `posts-migration.sql`. La migration 009 ajoute les
confirmations d’aide aux alertes SOS. La migration 010 ajoute les marqueurs
cartographiques, les conversations privées et le type d'annonce; elle est
idempotente et doit être appliquée avant le déploiement du contrat API v2.
La migration 011 ajoute l'identifiant de pays et l'unicité nécessaires aux
canaux par défaut ; 012 enregistre les alertes récentes de comptes à modérer ;
013 autorise les signalements « Objet perdu » et 014 ajoute le média audio
d'urgence facultatif. Le seed doit être appliqué après 011 afin que les deux
canaux soient créés pour chaque pays. Au démarrage, le
serveur les upsert à nouveau pour réparer les canaux manquants sans produire
de 404 pour un compte n'ayant encore aucune conversation.

La migration 038 enregistre les acceptations datées des documents légaux par
utilisateur, version et version de l’application. Appliquez-la avant de
déployer le parcours de consentement. Les variables `LEGAL_*_VERSION` du
serveur déterminent les versions en vigueur ; changer une valeur relance la
demande d’acceptation pour le document correspondant.

La migration 039 ajoute les compteurs quotidiens de SMS et de signatures
d’upload. La migration 040 permet d’anonymiser les références acheteur/livreur
et voyageur conservées pour les transactions lors de la suppression d’un
compte. Appliquez les deux avant de déployer les routes d’export et de
suppression, et avant d’activer les plafonds `SMS_DAILY_LIMIT` et
`UPLOADS_DAILY_LIMIT`.

Les migrations 015 à 017 ajoutent les champs utilisés par les publications
Made in, les épingles sponsorisées et les détails d'offres Pro. Appliquez-les
avant de déployer cette version de l'API. Les migrations 019 et 020 ajoutent
respectivement Voyage et les alliances, interactions du fil et positions
partagées avec consentement. La migration 021 ajoute les réponses, réactions
et dates de modification des commentaires; appliquez-la avant de déployer les
routes sociales correspondantes.
La migration 022 ajoute les blocages persistants et doit être appliquée avant
le déploiement des filtres du fil et de la messagerie.
La migration 023 ajoute les champs média aux messages privés; déployez-la avant
la version mobile qui permet d’y joindre des photos ou vidéos.
La migration 024 ajoute Alliance+ et commence le suivi des migrations dans
`app_migrations`. Les migrations antérieures ne sont pas enregistrées
rétroactivement ; l’endpoint de santé renvoie `null` tant que 024 n’a pas été
appliquée.
Les migrations 025 à 029 complètent les offres de croissance, les photos de
profil, l’inscription facultative des grossistes, les réservations en gare et
les médias multiples du fil. La migration 026 ajoute les colonnes de photo de
profil avec `IF NOT EXISTS` sans supprimer ni réécrire les données existantes ;
elle est nécessaire avant de déployer les routes de profil, d’alliances, de
messagerie et de fil qui lisent `users.profile_photo_url`. La migration 029
crée `post_media_items`, lue par le fil. Appliquez ces migrations dans l’ordre
avant de déployer cette version de l’API.
Les migrations 030 à 033 ajoutent les partages internes, les impressions de
carte Pro, les avis et les statistiques des épingles sponsorisées; appliquez-les
dans l'ordre avant 034.
La migration 034 crée la file de revue du Grin et les recours; elle ne stocke
ni image ni transcription. Appliquez-la avant d'activer la modération en direct.
La migration 035 ajoute les sanctions vérifiées, les recours sur les décisions
de modération, l'historique administratif et les messages flash différés.
Appliquez-la après 034 avant de déployer le nouvel espace administrateur.

## Espace Administrateur sécurisé

L'accès est désactivé tant qu'aucun UUID n'est explicitement autorisé. Après
avoir créé le compte `administrateurquartierplus@gmail.com`, vérifiez son
identité Google ou son e-mail, puis liez et vérifiez également un numéro de
téléphone par OTP. Relevez l'UUID du compte dans la base :

```sql
SELECT id FROM users
WHERE LOWER(email) = 'administrateurquartierplus@gmail.com';
```

Configurez ensuite `ADMIN_EMAIL=administrateurquartierplus@gmail.com` et
`ADMIN_USER_IDS=<UUID>` dans l'environnement serveur (UUID seulement, jamais
dans l'application mobile). L'API exige simultanément l'UUID autorisé, l'e-mail
vérifié, le téléphone vérifié et une session ouverte par OTP SMS;
l'adresse seule ou une session Google seule ne confère aucun privilège.
Pour ouvrir l'espace, l'administrateur doit donc se reconnecter avec son numéro
vérifié et le code SMS.
Ne réutilisez pas un jeton d'administration partagé. Toute action de
modération est journalisée; les comptes suspendus gardent accès au dépôt d'un
recours et aux fonctions SOS de sécurité.

Les messages flash utilisent les jetons Expo Push enregistrés par les
applications. La diffusion régionale cible un rayon géographique (centre +
rayon, de 1 à 300 km), les quartiers utilisent le nom de quartier enregistré,
et les pays le code ISO. Les envois programmés sont traités périodiquement par
l'API; l'historique indique les tickets acceptés et en échec par Expo. Une
absence de jetons d'appareil est enregistrée comme zéro destinataire, et ne
constitue pas une distribution réussie.

## Agent de modération du Grin (AWS)

La modération AWS en direct est désactivée par défaut et n'est pas nécessaire
pour compiler, tester ou mettre à jour l'application. Sans Rekognition,
le Grin reste utilisable et s'appuie sur les signalements manuels et la revue
humaine. Pour activer volontairement l'analyse AWS, déployez d'abord l'API et
la migration 034, puis l'agent LiveKit séparé :

1. Utilisez un compte LiveKit Cloud et installez LiveKit CLI (`lk`), puis
   authentifiez-le avec `lk cloud auth`.
2. Depuis `server/grin-moderator`, déployez l'agent avec `lk agent deploy`.
   L'agent doit être enregistré sous le nom exact `grin-moderator`.
3. Configurez `AWS_REKOGNITION_ENABLED=true` sur l'API et l'agent. Configurez
   `AWS_TRANSCRIBE_ENABLED=true` uniquement si vous activez aussi la modération
   vocale. Sans ces drapeaux, l'agent n'importe pas et n'appelle pas les
   clients AWS. Configurez sur le service de l'agent `AWS_REGION`,
   `GRIN_MODERATION_EVENT_URL` (URL HTTPS de l'API suivie de
   `/v1/livekit/moderation/events`), `GRIN_MODERATION_WEBHOOK_SECRET` et
   `GRIN_TRANSCRIBE_LANGUAGE=fr-FR`. Les clés AWS ne vont que dans le gestionnaire
   de secrets du service agent; préférez un rôle IAM plutôt que des clés IAM
   longues durées.
4. Accordez au rôle de l'agent uniquement les actions AWS correspondant aux
   fonctions activées (`rekognition:DetectModerationLabels` et, facultativement,
   `transcribe:StartStreamTranscription`) dans la région choisie.
   L'API et l'agent doivent avoir la même valeur secrète aléatoire de 32
   caractères minimum pour `GRIN_MODERATION_WEBHOOK_SECRET`.
5. Sur Render, configurez `GRIN_MODERATION_ENABLED=true`,
   `GRIN_MODERATION_WEBHOOK_SECRET` et `GRIN_MODERATOR_IDS` (UUID des comptes
   QuartierPlus autorisés à traiter la file). Appliquez la migration 034 avant
   d'activer cette variable.
6. Fermez la room LiveKit `grin` existante avant l'activation pour déconnecter
   les anciennes sessions qui ne portaient pas d'attribut de consentement.
   Quand la modération AWS est activée, les jetons sans consentement ne
   permettent pas de publier; quand elle est désactivée, le Grin utilise la
   modération manuelle et les signalements restent disponibles.
7. Recompilez puis distribuez un nouvel APK Android et vérifiez le Grin avec
   des comptes de test consentants et non consentants. Une OTA seule n'active
   pas les changements serveur.

Chaque participant choisit son consentement pour le salon courant. L'agent
s'abonne uniquement aux pistes des participants dont le jeton porte ce
consentement. Rekognition analyse une image réduite toutes les cinq secondes;
Transcribe traite l'audio en français (`fr-FR`). Aucun média ni texte transcrit
n'est écrit dans la base par l'agent; seule la catégorie, le score, la piste et
la décision sont conservés. Une détection visuelle à 95 % ou plus pour une
catégorie grave met temporairement la piste vidéo en sourdine et ouvre une revue
humaine. Les menaces et insultes reconnues dans une transcription alimentent
seulement la file : le contexte d'une phrase ne permet pas une suspension
vocale automatique fiable. Les autres détections admissibles alimentent aussi
la file sans couper le flux. Un modérateur autorisé peut confirmer ou lever la
sourdine; le participant peut faire appel depuis l'écran du Grin. Aucun contenu
n'est supprimé automatiquement.

L'analyse des propos publics est distincte et désactivée par défaut. Pour
l'activer, appliquez également la migration 037, configurez
`TEXT_MODERATION_ENABLED=true` sur l'API et l'agent, puis activez
`GRIN_MODERATION_ENABLED=true` avec un modérateur et un fournisseur e-mail
opérationnel. L'agent récupère le lexique administrable via l'API; il ne
conserve ni transcription ni extrait audio. Les publications et commentaires
affichent un avertissement avant confirmation. `CONFLICT_PROTECTION_ENABLED=true`
active en plus les pauses de 15 minutes après des propos hostiles répétés envers
le même compte et les alertes basées sur plusieurs signalements.
Les entrées mooré (`mos`), dioula (`dyu`) et fulfulde (`ff`) sont prises en
charge dans les textes saisis; la détection orale du live dépend toutefois des
langues effectivement prises en charge par AWS Transcribe et de
`GRIN_TRANSCRIBE_LANGUAGE`.

Cette première intégration ne constitue pas un classificateur sémantique
complet : les menaces vocales sont détectées par correspondance lexicale et
signalées pour revue.
L'agent ne détecte pas les comportements hors champ, le harcèlement répété
entre plusieurs salons ni la diffusion de contenus privés sans contexte de
consentement. Le traitement AWS implique un transfert temporaire des flux vers
AWS; validez les paramètres de conservation, la région et les obligations
applicables avant l'activation réelle.

## 2. Créer le service web Render

1. Ouvrez Render et connectez-vous avec GitHub.
2. Touchez **New +**, puis **Web Service**.
3. Sélectionnez le dépôt `Fondateur-Administrateur/QuartierPlus1` et la branche
   `main`.
4. Donnez un nom au service. Choisissez **Node** comme environnement.
5. Dans les réglages de construction, entrez :
   - **Root Directory** : `server`
   - **Build Command** : `npm ci`
   - **Start Command** : `npm start`
6. Indiquez le chemin du contrôle de santé : `/health`.
7. Ajoutez les variables de la section suivante, puis touchez **Create Web
   Service**. Render construit et démarre l'API.

Render fournit au service une valeur `PORT` et configure automatiquement le
certificat HTTPS pour son domaine `onrender.com`. Après le premier déploiement,
copiez l'adresse HTTPS affichée sur la page du service (par exemple
`https://<nom-du-service>.onrender.com`). C'est l'URL publique de l'API ; ne
rajoutez pas `/health` ni `/api/v1` à sa valeur de base.

## 3. Variables à configurer sur Render

Dans **Environment** du service Render, créez les variables suivantes. Saisissez
leurs vraies valeurs dans Render ; ne les inscrivez pas dans le dépôt.

### Réglages de déploiement

| Nom | Configuration |
| --- | --- |
| `NODE_VERSION` | `20`, pour utiliser la version Node des workflows du dépôt |
| `NODE_ENV` | `production` |
| `PGSSL` | `true` pour activer TLS vers PostgreSQL |

### Requis par l'API au démarrage en production

| Nom | Configuration |
| --- | --- |
| `DATABASE_URL` | URL PostgreSQL copiée depuis Neon ou Supabase |
| `JWT_SECRET` | Secret aléatoire d'au moins 32 caractères |
| `TICKET_QR_SECRET` | Autre secret aléatoire stable d'au moins 32 caractères |
| `GOOGLE_CLIENT_ID` | Identifiant OAuth client Web Google utilisé par l'application |
| `SMS_DELIVERY_URL` | URL HTTPS du relais SMS de production |
| `SMS_DELIVERY_TOKEN` | Jeton du relais SMS |
| `EMAIL_PROVIDER` | `resend` pour activer l’adaptateur e-mail |
| `EMAIL_API_KEY` | Clé API privée Resend |
| `EMAIL_FROM` | Expéditeur autorisé par Resend, par exemple `QuartierPlus <noreply@votre-domaine>` |

Créez ces trois variables dans **Render → service API → Environment**.
L’e-mail OTP reste désactivé tant que les trois valeurs ne sont pas présentes
et que l’expéditeur n’est pas autorisé chez Resend. Le parcours SMS continue de
fonctionner sans configuration e-mail.

L'application refuse de démarrer en production si un des éléments de la liste
des variables requises ci-dessus manque. `NODE_ENV` doit être défini sur
`production` pour activer ces vérifications, et `PGSSL=true` active le TLS vers
la base. `TICKET_QR_SECRET` doit rester stable après le déploiement : le changer
invaliderait les signatures des billets déjà émis.

### À ajouter seulement pour les fonctions utilisées

| Nom | Utilité |
| --- | --- |
| `GOOGLE_CLIENT_IDS` | Autres identifiants OAuth autorisés, séparés par des virgules |
| `JWT_EXPIRES_IN` | Durée de validité des jetons ; valeur par défaut : `7d` |
| `OTP_TEST_ALLOWLIST` | Numéros E.164 séparés par des virgules, uniquement pour le code OTP de test hors production |
| `IS_PROMO_FREE_ACCESS` | `true` ou `false` pour le mode découverte |
| `BILLING_ENABLED` | `false` (défaut) active gratuitement les offres; `true` utilise le paiement FedaPay |
| `FEDAPAY_SECRET_KEY` | Clé secrète FedaPay pour les paiements |
| `FEDAPAY_PUBLIC_KEY` | Clé publique FedaPay |
| `FEDAPAY_ENVIRONMENT` | `sandbox` pour les tests, `live` pour la production |
| `FEDAPAY_WEBHOOK_SECRET` | Secret HMAC-SHA256 du corps brut reçu via `X-FedaPay-Signature` |
| `SOCKET_CORS_ORIGIN` | Origines web autorisées, séparées par des virgules |
| `LIVEKIT_API_KEY` | Clé API LiveKit au format `API...` (`^API[A-Za-z0-9_-]+$`) |
| `LIVEKIT_API_SECRET` | Secret API correspondant de LiveKit |
| `LIVEKIT_URL` | URL WebSocket LiveKit en `wss://` |
| `AWS_REKOGNITION_ENABLED` | `false` par défaut; `true` active explicitement Rekognition sur l'API et l'agent |
| `AWS_TRANSCRIBE_ENABLED` | `false` par défaut; `true` active explicitement Transcribe sur l'agent |
| `GRIN_MODERATION_ENABLED` | `false` par défaut; effectif seulement si Rekognition est activé, l'agent est déployé et la migration 034 est appliquée |
| `GRIN_MODERATION_WEBHOOK_SECRET` | Secret aléatoire partagé API/agent, 32 caractères minimum |
| `GRIN_MODERATOR_IDS` | UUID de comptes QuartierPlus autorisés à examiner la file, séparés par des virgules |
| `CLOUDINARY_CLOUD_NAME` | Nom du cloud Cloudinary utilisé par l'API de publication |
| `CLOUDINARY_API_KEY` | Clé API Cloudinary |
| `CLOUDINARY_API_SECRET` | Secret API Cloudinary; reste uniquement sur Render |
| `POST_MAX_PHOTO_BYTES` | Taille maximale d’une photo en octets; défaut `10485760` (10 Mo) |
| `POST_MAX_VIDEO_SECONDS` | Durée maximale d’une vidéo; défaut `420` secondes |
| `POST_MAX_VIDEO_BYTES` | Taille maximale d’une vidéo en octets; défaut `104857600` (100 Mio) |
| `POST_DAILY_LIMIT` | Nombre maximal de publications par compte et par jour; défaut `10` |
| `MODERATION_UPLOADS_ENABLED` | `false` par défaut; n'analyse les médias que si `AWS_REKOGNITION_ENABLED=true` |
| `MODERATION_SERVICE_URL` | URL HTTPS du point `/v1/analyze-upload` servi par l'agent Grin |
| `MODERATION_DAILY_ANALYSIS_LIMIT` | Plafond d'analyses Rekognition par jour UTC; défaut `100` |
| `MODERATION_HIGH_THRESHOLD` / `MODERATION_MEDIUM_THRESHOLD` | Seuils de confiance en pourcentage; défaut `90` / `50` |
| `SUPPORT_NOTIFY_EMAIL` | Adresse destinataire des alertes de modération graves |
| `TEXT_MODERATION_ENABLED` | `false` par défaut; avertissement et revue lexicale des publications, commentaires et textes du Grin |
| `CONFLICT_PROTECTION_ENABLED` | `false` par défaut; exige la modération textuelle et active la mise en sourdine, les pauses de 15 minutes et la détection de signalements multiples |

Pour activer la modération média, configurez l'API avec
`MODERATION_UPLOADS_ENABLED=true`, une URL HTTPS publique vers l'agent et le
même secret fort `GRIN_MODERATION_WEBHOOK_SECRET` sur l'API et l'agent. Sur le
service de l'agent, configurez également `MODERATION_UPLOADS_WORKER_ENABLED=true`,
`MODERATION_HTTP_PORT` et `CLOUDINARY_CLOUD_NAME`. Configurez une livraison
SMTP ou Resend et `SUPPORT_NOTIFY_EMAIL` avant l'activation. Les échantillons
vidéo sont extraits à cinq instants en mémoire; les médias et images extraites
ne sont pas enregistrés par le worker. Pour la modération textuelle, configurez
aussi `TEXT_MODERATION_ENABLED=true` sur l'agent; la variable correspondante
doit être activée sur l'API et dépend de la migration 037.
| `PRO_ENABLED` | `false` par défaut; `true` active les catalogues, commandes et livraisons grossistes |
| `PRO_ADMIN_TOKEN` | Secret serveur indépendant, facultatif; protège la validation RCCM/IFU via l’API Pro |

Les trois variables `CLOUDINARY_*` doivent être configurées ensemble pour
activer les publications; aucune ne doit être copiée dans l'application mobile.
Les signatures sont émises par l'API avec un timestamp et des paramètres triés;
les vidéos de plus de 20 Mo sont téléversées par segments. En cas de refus
Cloudinary, l'API journalise le statut HTTP et le message renvoyé.
Les variables `POST_*` sont facultatives et remplacent les limites par défaut.
LiveKit est facultatif au démarrage : si sa configuration est absente ou
invalide, les journaux de l'API identifient les variables à corriger et le
service de jeton renvoie une erreur précise. Quand `BILLING_ENABLED=false`,
les offres sont activées
immédiatement et affichées comme gratuites pendant la phase de test; mettez-le
à `true` uniquement après avoir configuré FedaPay.

`PORT` est fourni par Render : ne le créez pas manuellement. `OTP_TEST_MODE`
doit être absent ou `false` en production ; le serveur refuse `true`, même si
`OTP_TEST_ALLOWLIST` est renseignée. Hors production, seul un numéro présent
dans cette liste reçoit le code fixe `123456`; les autres numéros exigent la
configuration SMS et reçoivent un code aléatoire.

Le HMAC des codes stockés dans `code_hash` utilise `JWT_SECRET` dans
`authController.js`; aucun `HMAC_SECRET` distinct n'est lu par l'API. Render
doit donc conserver le secret existant sous `JWT_SECRET` (sans rotation).

La migration 018 crée les tables du catalogue grossiste, des commandes et du
suivi QuartierPlus Pro. Le module n'encaisse aucun paiement : les modes
enregistrent seulement « paiement à la livraison » ou un acompte confirmé
directement par le grossiste. Les profils restent invisibles au catalogue tant
que RCCM et IFU ne sont pas vérifiés; une équipe autorisée peut mettre à jour
ces statuts avec `PATCH /v1/pro-commerce/admin/wholesalers/:wholesalerId/verification`
et le jeton `PRO_ADMIN_TOKEN`.

## Localisation des livraisons Pro

Le suivi Android utilise une tâche Expo en arrière-plan, les permissions
`ACCESS_BACKGROUND_LOCATION` et `FOREGROUND_SERVICE_LOCATION`, ainsi qu'une
notification persistante « Livraison en cours ». Toute modification des
permissions natives impose un nouveau build APK/AAB; une mise à jour OTA ne
suffit pas. La publication sur Google Play doit déclarer l'accès à la
localisation en arrière-plan dans **App content > Permissions** et fournir une
justification montrant que le suivi ne commence qu'avec le consentement du
livreur et s'arrête à la fin de la livraison. N'activez pas cette fonction en
production avant l'approbation de cette déclaration. Les positions sont
privées à la commande et supprimées 30 jours après livraison.

## 4. Vérifier et récupérer l'URL pour l'application

1. Attendez que le déploiement Render soit marqué **Live**.
2. Ouvrez l'adresse HTTPS du service suivie de `/health` dans le navigateur du
   téléphone. Le résultat attendu contient `status`, `commit` et
   `contractVersion`, par exemple
   `{"status":"ok","commit":"<sha>","contractVersion":2}`. Cette vérification
   confirme le démarrage HTTP, pas la disponibilité de PostgreSQL.
3. Copiez l'adresse de base HTTPS du service, sans `/health`, par exemple
   `https://<nom-du-service>.onrender.com`.
4. Définissez cette adresse comme `EXPO_PUBLIC_API_URL` pour la compilation
   mobile. L'application ajoute elle-même les chemins `/api/v1/...`.
5. Pour le workflow GitHub de génération APK, ajoutez aussi cette URL dans
   **Settings → Secrets and variables → Actions** sous le nom
   `EXPO_PUBLIC_API_URL`, puis relancez le workflow de build Android.

Le workflow `.github/workflows/render-keepalive.yml` vérifie l'endpoint
`/health` de l'API toutes les 10 minutes et peut aussi être lancé manuellement.
Il envoie également une requête à `https://onrender.com`, mais ce domaine
générique n'est pas l'URL du service QuartierPlus : seul le contrôle `/health`
sur le domaine du service cible l'API. Les exécutions planifiées GitHub Actions
peuvent être retardées ou omises; ce ping de meilleur effort ne garantit donc
pas que Render maintiendra le service éveillé.

`EXPO_PUBLIC_API_URL` est intégrée à l'application mobile et n'est pas une
variable à mettre sur le service backend Render. Les valeurs `EXPO_PUBLIC_*`
ne doivent pas contenir de secrets serveur.

Les nouveaux modules natifs `expo-video` et `expo-media-library` nécessitent un
nouveau build APK/AAB avant leur utilisation; FlashList et
`expo-image` seuls ne nécessitent pas de changement serveur.

## Builds APK Android preview

Le workflow `.github/workflows/build-apk.yml` construit deux APK release sans
client de développement : `arm64-v8a` et `armeabi-v7a`. R8/ProGuard et la
réduction des ressources sont activés par défaut; Hermes est le moteur JS et
les bibliothèques natives sont empaquetées compressées. Pour désactiver
temporairement les deux optimisations après un crash, définissez
`EXPO_ANDROID_MINIFY=false` dans **EAS > Project > Environment variables** pour
l'environnement `preview`, puis relancez le workflow; supprimez la variable
pour rétablir les valeurs par défaut. Les règles ProGuard conservent LiveKit,
WebRTC, Firebase, SQLite et Reanimated; tester chaque parcours natif
reste nécessaire, car le code invoqué par réflexion ou JNI peut être supprimé
par R8. Un APK par architecture évite d'inclure les bibliothèques x86 et réduit
la taille de téléchargement, au prix d'un artefact distinct par appareil.
Le nettoyage retire `expo-auth-session`, non référencé dans le code; aucune
police ou autre image inutilisée n'a été trouvée. L'icône du billet QR utilise
une vignette WebP de 1,5 Ko au lieu du PNG de 414 Ko; les PNG des icônes
d'installation restent requis.
Le résumé GitHub Actions publie la taille réelle, le top 10 des entrées APK et
vérifie l'ABI ainsi que la compression des `.so`; aucune taille release exacte
n'est connue avant une exécution EAS réussie.
