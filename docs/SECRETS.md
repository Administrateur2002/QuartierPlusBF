# Configuration et secrets

Ne mettez jamais les secrets serveur dans l'app, GitHub Actions logs, ni dans
les variables `EXPO_PUBLIC_*`.

## Render — API serveur

Variables obligatoires en production :

```text
DATABASE_URL
JWT_SECRET
TICKET_QR_SECRET
GOOGLE_CLIENT_ID
SMS_DELIVERY_URL
SMS_DELIVERY_TOKEN
```

Variables supplémentaires à créer pour activer les fonctions correspondantes :

```text
ADMIN_EMAIL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
LIVEKIT_URL
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
BILLING_ENABLED
VOYAGE_ENABLED
TICKET_SIGNING_PRIVATE_KEY_B64
TICKET_SIGNING_KID
FEDAPAY_SECRET_KEY
FEDAPAY_PUBLIC_KEY
FEDAPAY_ENVIRONMENT
FEDAPAY_WEBHOOK_SECRET
GOOGLE_CLIENT_IDS
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASS
MAIL_FROM
EMAIL_PROVIDER
EMAIL_API_KEY
EMAIL_FROM
ADMIN_TEST_EMAIL_TOKEN
IS_PROMO_FREE_ACCESS
PGSSL
JWT_EXPIRES_IN
OTP_TEST_MODE
OTP_TEST_ALLOWLIST
POST_MAX_PHOTO_BYTES
POST_MAX_VIDEO_SECONDS
POST_MAX_VIDEO_BYTES
POST_DAILY_LIMIT
SOCKET_CORS_ORIGIN
```

`LIVEKIT_API_KEY` doit correspondre à `^API[A-Za-z0-9_-]+$`. `LIVEKIT_URL` doit
être une URL `wss://`. Cloudinary et FedaPay sont configurés exclusivement sur
Render. Ne transmettez jamais `LIVEKIT_API_SECRET`, `CLOUDINARY_API_SECRET`,
`FEDAPAY_SECRET_KEY` ni `FEDAPAY_WEBHOOK_SECRET` à EAS.

QuartierPlus Voyage reste désactivé par défaut (`VOYAGE_ENABLED=false`). Pour
préparer la signature des billets, générer une paire Ed25519 hors du dépôt :

```sh
openssl genpkey -algorithm ED25519 -out "$HOME/ticket_private.pem"
openssl pkey -in "$HOME/ticket_private.pem" -pubout -out mobile/assets/ticket_public.pem
base64 -w0 "$HOME/ticket_private.pem"
```

Enregistrer la sortie base64 uniquement dans le secret serveur
`TICKET_SIGNING_PRIVATE_KEY_B64`; configurer `TICKET_SIGNING_KID` (défaut `v1`)
pour la rotation. Ne jamais déposer la clé privée ou la valeur base64 dans Git,
EAS, un log CI ou une variable `EXPO_PUBLIC_*`. La clé publique PEM dans
`mobile/assets/ticket_public.pem` est publique.

Les transactions FedaPay actuellement intégrées sont créées par le compte
plateforme (`amount`, devise et client), sans bénéficiaire compagnie ni partage
de fonds. Les paiements Voyage payants sont donc refusés tant qu’un produit de
versement vendeur n’est pas configuré; aucun fonds n’est ainsi détenu par
QuartierPlus. Le champ de commission est prévu à 3 %, mais aucun paiement ou
prélèvement de commission n’est activé dans cette intégration.

Configurer l'URL FedaPay publique suivante et une signature HMAC-SHA256 du corps
HTTP brut dans `X-FedaPay-Signature` :

```text
https://quartierplus-api.onrender.com/api/v1/payments/fedapay-webhook
```

La signature attendue est l'hexadécimal HMAC-SHA256 de l'octet exact envoyé,
calculé avec `FEDAPAY_WEBHOOK_SECRET` (préfixe `sha256=` accepté). La route
n'exige pas de jeton utilisateur.

## GitHub Actions et environnement EAS `preview`

Créez les éléments suivants dans **GitHub → Settings → Secrets and variables
→ Actions**. Pour une variable non confidentielle, privilégiez **Variables** ;
les secrets doivent rester dans **Secrets**.

| Nom | Emplacement |
|---|---|
| `EXPO_TOKEN` | Secret GitHub Actions du dépôt, jeton d'accès EAS |
| `GOOGLE_SERVICES_JSON` | Secret GitHub Actions du dépôt, contenu du fichier Firebase Android |
| `GOOGLE_SERVICES_JSON_B64` | Secret GitHub Actions du dépôt, alternative Base64 à `GOOGLE_SERVICES_JSON` |
| `EXPO_PUBLIC_API_URL` | Variable GitHub Actions et environnement EAS `preview` |
| `EXPO_PUBLIC_FIREBASE_API_KEY` | Variable GitHub Actions et environnement EAS `preview` |
| `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN` | Variable GitHub Actions et environnement EAS `preview` |
| `EXPO_PUBLIC_FIREBASE_PROJECT_ID` | Variable GitHub Actions et environnement EAS `preview` |
| `EXPO_PUBLIC_FIREBASE_APP_ID` | Variable GitHub Actions et environnement EAS `preview` |
| `EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Variable GitHub Actions et environnement EAS `preview` |
| `EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID` | Variable GitHub Actions et environnement EAS `preview` |
| `EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET` | Variable GitHub Actions et environnement EAS `preview` |
| `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` | Variable GitHub Actions et environnement EAS `preview` |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Environnement EAS `preview` ; le workflow de build l'extrait aussi de Firebase |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` | Environnement EAS `preview` ; le workflow de build l'extrait aussi de Firebase |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | Variable GitHub Actions et environnement EAS `preview`, si iOS est activé |
| `EXPO_PUBLIC_EAS_PROJECT_ID` | Variable GitHub Actions et environnement EAS `preview`, uniquement si absent de `app.json` |
| `EXPO_PUBLIC_LIVEKIT_URL` | Variable GitHub Actions et environnement EAS `preview` |

Les variables `EXPO_PUBLIC_*` sont intégrées à l'application et ne doivent
jamais contenir de secret serveur. Les clés API Firebase et Maps sont des
identifiants client : appliquez leurs restrictions dans les consoles Google.
L'URL API peut utiliser la valeur de production par défaut du workflow ; créez
la variable uniquement si une autre URL est requise.
Le préflight du workflow Android exige `EXPO_TOKEN`, l'un de
`GOOGLE_SERVICES_JSON` ou `GOOGLE_SERVICES_JSON_B64`, et
`EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` (variable ou secret GitHub). Il vérifie aussi
le package Android et la présence des clients OAuth Android et Web dans le JSON,
sans afficher leur contenu. Les clients Google Android/Web et le projet Firebase
sont extraits de ce fichier ; les autres variables client ne sont pas des
secrets requis par le préflight. Configurez les valeurs utilisées par l'OTA dans
l'environnement EAS `preview`.
`ADMIN_EMAIL` se configure dans l'environnement du service Render et doit
correspondre à l'adresse vérifiée du compte portant le rôle `admin` en base.

Les variables suivantes sont intégrées au client ; ce ne sont pas des secrets :

```text
EXPO_PUBLIC_API_URL
EXPO_PUBLIC_FIREBASE_API_KEY
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN
EXPO_PUBLIC_FIREBASE_PROJECT_ID
EXPO_PUBLIC_FIREBASE_APP_ID
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
EXPO_PUBLIC_EAS_PROJECT_ID
EXPO_PUBLIC_LIVEKIT_URL
```

Les workflows acceptent les valeurs client comme GitHub Actions Variables ou
Secrets, à l'exception des identifiants Google Android/Web et du project ID
Firebase : le workflow APK les extrait de `mobile/google-services.json` et
remplace les valeurs GitHub présentes.
Pour une mise à jour OTA, configurez aussi les valeurs client dans
l'environnement EAS `preview` utilisé par `eas update --environment preview`.
`mobile/app.json` contient déjà l'identifiant EAS à
`expo.extra.eas.projectId` ; c'est la source prioritaire pour les builds et les
mises à jour OTA. `EXPO_PUBLIC_EAS_PROJECT_ID` n'est nécessaire que si cet
identifiant est absent du fichier.

Secrets GitHub réservés aux workflows :

```text
GOOGLE_SERVICES_JSON
GOOGLE_SERVICES_JSON_B64
EXPO_TOKEN
```

Pour la configuration Firebase Android du workflow APK, fournissez soit
`GOOGLE_SERVICES_JSON` avec le contenu JSON brut, soit
`GOOGLE_SERVICES_JSON_B64` avec le fichier JSON encodé en base64 standard.
Si les deux secrets sont définis, `GOOGLE_SERVICES_JSON_B64` est essayé en
premier ; en cas d'invalidité, le workflow essaie `GOOGLE_SERVICES_JSON`.
Le workflow détecte aussi un JSON encodé en Base64 accidentellement placé dans
`GOOGLE_SERVICES_JSON`. Il retire les caractères Unicode de format (dont
U+200E/U+200F) et le BOM du JSON brut/décodé ; les espaces internes du Base64
sont ignorés pour permettre son formatage sur plusieurs lignes. Un parseur JSON
valide le contenu, puis le workflow exige `project_info.project_number`,
`project_info.project_id`,
`client_info.android_client_info.package_name`,
`client_info.mobilesdk_app_id` et `api_key[].current_key` sur le client Android
dont le package correspond exactement à `expo.android.package`.
Pour remplacer une configuration incorrecte, ouvrez le dépôt GitHub puis
**Settings → Secrets and variables → Actions**, sélectionnez le secret
`GOOGLE_SERVICES_JSON` (ou `GOOGLE_SERVICES_JSON_B64` si vous utilisez Base64),
choisissez **Update secret** et collez le nouveau fichier téléchargé depuis
Firebase Console ou son encodage Base64. Si vous changez de format, supprimez
l'autre secret pour éviter que le secret `_B64` prioritaire soit utilisé.
N'inventez ni ne modifiez manuellement les valeurs Firebase.
En cas d'échec, le workflow n'affiche jamais le contenu du secret. La valeur
normalisée est écrite temporairement dans `mobile/google-services.json` sans
être imprimée.
Le client OAuth Android client_type 1 du package `expo.android.package`, le
client Web client_type 3, `project_number` et `project_id` de ce fichier font
autorité. Les deux identifiants Google et `EXPO_PUBLIC_FIREBASE_PROJECT_ID`
sont exportés depuis ce fichier et leur origine est consignée sans afficher
leur valeur.
Le workflow EAS Update essaie, dans l'ordre, le secret Base64, le secret JSON
brut, puis `mobile/google-services.json` du dépôt. Il détecte aussi un JSON brut
placé par erreur dans le secret Base64 ou un JSON encodé en Base64 dans le
secret brut. Chaque candidat est validé (structure Firebase et client OAuth
Android correspondant au package) avant usage ; un secret invalide n'empêche
pas d'utiliser un autre candidat valide. Ainsi, un fichier du dépôt valide peut
être utilisé même si les secrets sont absents ou mal formés. Le candidat retenu
est normalisé à `mobile/google-services.json` avant l'export Android. La
publication est bloquée uniquement si aucune configuration valide n'est
disponible.
`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` absent ou mal formé n'est qu'un avertissement :
l'authentification Google iOS est omise et la publication Android continue.
`EXPO_TOKEN` est passé à EAS et n'est pas affiché. Les workflows ne doivent jamais
activer `set -x` ou imprimer une valeur de secret.
Le workflow APK écrit le secret après le checkout et valide ensuite ce fichier ;
la présence de `mobile/google-services.json` dans le dépôt ne remplace donc pas
la valeur fournie par le secret pendant le build. La connexion Google iOS est
facultative pour le build Android : l'absence ou l'invalidité de
`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` génère un avertissement et la valeur n'est pas
transmise.
`EXPO_PUBLIC_EAS_PROJECT_ID`, lorsqu'il est défini dans GitHub, ne doit pas être
une valeur d'exemple. Le workflow consigne uniquement si chaque identifiant
Google/EAS provient d'une variable GitHub, d'un secret GitHub ou de `app.json`,
jamais sa valeur.

Les mises à jour OTA ne peuvent pas installer de changements natifs. Avant de
publier, le workflow EAS Update compare l'empreinte native Android de chaque ABI
avec celle du dernier APK `preview-arm64` et `preview-armv7`. Une empreinte
différente ou indisponible bloque la publication : lancez d'abord
« Build Android Preview APK ». La politique `runtimeVersion: appVersion`
continue également d'exiger que le binaire installé et l'OTA ciblent la même
version runtime.

## Configuration Google requise

Dans Firebase Console, activez Google dans Authentication, vérifiez l'app
Android `com.administrateur.quartierplus`, puis ajoutez les empreintes SHA-1 et
SHA-256 du certificat de signature EAS de chaque profil distribué. Obtenez-les
dans `eas credentials -p android` pour le profil EAS concerné ; l'empreinte du
keystore debug local n'est pas celle de l'APK EAS. Si l'application est aussi
distribuée via Google Play, ajoutez également les SHA-1 et SHA-256 du certificat
de signature Play (Play Console → Intégrité de l'application), qui peuvent être
différents du certificat EAS. Après modification, téléchargez le nouveau
`google-services.json` et remplacez le secret GitHub `GOOGLE_SERVICES_JSON`.
Un nouveau build natif est nécessaire pour prendre en compte ces certificats ;
une publication OTA seule ne suffit pas.

Dans Google Cloud Console → API et services → Identifiants, créez/vérifiez le
client OAuth Android avec le package et le SHA-1 exacts, ainsi qu'un client OAuth
Web. `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` doit contenir le client Web ;
`GOOGLE_CLIENT_ID` sur Render doit accepter ce même ID.
Les workflows de build utilisent le profil EAS `preview` et les variables de
son environnement. Pour éviter qu'une ancienne valeur EAS ne prenne le dessus
sur les identifiants extraits par GitHub Actions, supprimez ou corrigez dans
expo.dev (environnement `preview`, ainsi que les variables au niveau compte si
elles s'appliquent) les variables `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`,
`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` et `EXPO_PUBLIC_FIREBASE_PROJECT_ID`.
Le client Android du bon package est exigé dans le fichier ; les erreurs dues
aux IDs Web/iOS vides ou invalides restent limitées à la connexion Google.
Le client Web est utilisé comme audience du jeton d'identité ; le client Android
et son certificat sont configurés nativement via `google-services.json`.
iOS n'est pas publié pour le moment ; si un build iOS est ajouté, configurez
`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` comme client OAuth iOS associé. Pour iOS,
`mobile/app.config.js` dérive le schéma URL de retour Google de cet ID et
l'ajoute au binaire. Pour le build Android, son absence reste un avertissement
et la variable n'est pas transmise aux commandes Expo/EAS lorsqu'elle est vide.
L'erreur Android `10` / `DEVELOPER_ERROR` indique généralement un client OAuth,
un package ou une empreinte SHA manquante/incohérente. Ne transmettez pas le
keystore ni sa clé privée à Firebase, GitHub variables ou au dépôt.

`GOOGLE_CLIENT_IDS` sur Render est facultatif et permet d'ajouter des audiences
OAuth autorisées séparées par des virgules. `EXPO_PUBLIC_*` ne contient jamais
de secret serveur.

### Livraison des codes OTP

Sur Render, le SMS passe par un relais HTTPS configurable, pas par un adaptateur
Twilio intégré. Créez `SMS_DELIVERY_URL` (URL HTTPS du relais) et
`SMS_DELIVERY_TOKEN` (jeton que ce relais accepte). Le relais doit accepter un
POST JSON `{ "to": "+...", "message": "..." }` avec le jeton d'autorisation.
Il n'existe pas de variable `TWILIO_*` ou `SMS_PROVIDER` dans le code actuel.

Pour Gmail SMTP, créez toutes ces variables Render :

```text
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=<adresse Gmail complète>
SMTP_PASS=<mot de passe d'application Google>
MAIL_FROM=<expéditeur autorisé pour cette adresse>
```

Le port `587` est aussi accepté. `SMTP_PASS` doit être un mot de passe
d'application Google créé après activation de la validation en deux étapes,
jamais le mot de passe normal du compte. Le code exige `MAIL_FROM` pour valider
la configuration SMTP.

Alternative prise en charge : Resend avec `EMAIL_PROVIDER=resend`,
`EMAIL_API_KEY` (clé privée Resend) et `EMAIL_FROM` (expéditeur vérifié).
Ne configurez pas `EMAIL_PROVIDER=resend` pour un SMTP Gmail. Tant que les
variables requises par le fournisseur choisi manquent, la demande d'OTP e-mail
renvoie une erreur de configuration au lieu d'envoyer un code.

Le code fixe `123456` est réservé à un service de test isolé :
`NODE_ENV=test`, `OTP_TEST_MODE=true` et `OTP_TEST_ALLOWLIST` contenant le
numéro de test en format E.164. Le code refuse `OTP_TEST_MODE=true` avec
`NODE_ENV=production`. Ne définissez jamais ces paramètres sur le service
Render de production. L'allowlist seule ne crée ni ne rattache un compte : le
numéro doit déjà être associé à la ligne du compte administrateur dans la base
de test. L'accès admin dépend de `ADMIN_EMAIL`, du rôle `admin` en base et des
vérifications d'e-mail et de téléphone.
