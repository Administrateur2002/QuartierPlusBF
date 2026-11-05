# Politique de confidentialité — brouillon

**Document de travail — À valider par un juriste avant publication.**

Version de travail : `2026-11-04.1`. Une version publiée doit être identifiée
par `LEGAL_PRIVACY_VERSION` dans la configuration serveur.

## Responsable du traitement et contact

Le responsable du traitement, son adresse et son représentant éventuel doivent
être identifiés par l’éditeur avant publication. L’adresse de support n’est pas
configurée dans le code au moment de ce brouillon : **la renseigner et la
publier avant toute collecte en production**. La variable `SUPPORT_NOTIFY_EMAIL`
sert aux notifications opérationnelles de modération et ne doit pas être
présentée comme un contact public sans validation de l’éditeur.

## Données traitées d’après l’application

Selon les fonctions utilisées, le code de QuartierPlus traite :

- **Compte et connexion** : nom, prénom, téléphone, e-mail, identifiant Google,
  pays, quartier, données de vérification et photo de profil. Les codes OTP
  sont hachés côté serveur et expirent après cinq minutes ; un compte peut
  aussi être authentifié par Google.
- **Contenus et échanges** : publications, annonces, commentaires, réactions,
  signalements, blocages, messages de canaux et messages privés, pièces jointes
  et médias envoyés.
- **Localisation et sécurité** : coordonnées utilisées pour les cartes et
  fonctions de proximité, position des marqueurs et des alertes SOS, type et
  statut d’alerte, médias d’urgence éventuellement joints, confirmations et
  événements d’assistance. La position n’est demandée que lorsqu’une fonction
  qui en a besoin est utilisée ; les partages de position sont soumis aux
  choix de l’utilisateur.
- **Services Pro et transactions** : informations d’offres, éléments de
  publication, coordonnées communiquées au paiement, identifiants de
  transaction, montants, devise et statut. Les coordonnées de livraison ou
  d’assistance peuvent être utilisées par les fonctions Pro correspondantes.
- **Appareil et fonctionnement** : jeton de notification si l’utilisateur
  l’autorise, préférences et contacts de confiance conservés localement,
  éléments hors ligne, données techniques de requête et rapports de panne
  Crashlytics. Le cache local et les éléments hors ligne peuvent persister sur
  l’appareil jusqu’à leur synchronisation ou leur effacement.
- **Acceptation et modération** : document et version acceptés, date, version
  de l’application, confirmation de l’âge minimum, contenu signalé, résultats
  de modération et éléments nécessaires à l’examen ou au recours.

L’application contient des outils de statistiques d’usage de fonctions Pro,
mais ce brouillon n’affirme pas l’existence d’un profil publicitaire ni d’un
suivi publicitaire inter-applications.

## Finalités et bases à confirmer

Les données sont utilisées pour créer et sécuriser le compte, fournir les
fonctions demandées, acheminer les messages et alertes, traiter les
transactions, prévenir les abus, modérer les contenus, gérer les recours,
assurer le fonctionnement technique et répondre aux demandes. Les bases
juridiques exactes (exécution du service, consentement, obligation légale ou
intérêt légitime) doivent être confirmées par le responsable et son conseil
juridique pour chaque finalité et territoire.

Les autorisations système de position, caméra, microphone et notifications
sont demandées au moment d’une fonction qui les utilise, avec une explication
contextuelle. Le refus peut empêcher cette fonction sans empêcher les autres
fonctions qui n’en dépendent pas. L’autorisation peut être retirée dans les
réglages du téléphone.

## Destinataires et prestataires identifiés

Les données nécessaires peuvent être communiquées aux catégories de
prestataires suivantes, selon les fonctions activées :

| Prestataire | Usage visible dans le code | Données susceptibles d’être traitées |
|---|---|---|
| Render | Hébergement de l’API | Requêtes et données envoyées à l’API ; journaux d’exploitation selon la configuration Render |
| Neon | PostgreSQL de production documenté | Comptes, contenus, coordonnées, SOS, transactions et acceptations conservés dans la base |
| Cloudinary | Téléversement et diffusion d’images/vidéos | Photos de profil, médias de publications, annonces, messages et médias associés |
| LiveKit | Salons audio/vidéo en direct | Identifiants de participant et flux audio/vidéo nécessaires au salon |
| Firebase / Google | Connexion Google, notifications et Crashlytics selon configuration | Identifiant et profil Google, jetons de notification, rapports techniques/pannes |
| AWS | Agent de modération du Grin utilisant Rekognition et Transcribe lorsqu’il est déployé et activé | Échantillons d’images vidéo et audio nécessaires à la détection/transcription ; résultats de modération |
| FedaPay | Paiement Mobile Money/carte lorsque le paiement est activé | Identité et coordonnées de paiement, montant et état de transaction |
| Prestataire SMS ou e-mail configuré | Vérification de compte et notifications | Numéro ou adresse e-mail et code de vérification/message |

Le service de modération AWS est déployé séparément et n’est pas nécessairement
activé pour chaque instance. Pour le Grin, le code prévoit l’envoi
d’échantillons vidéo à Rekognition et la transcription temporaire du flux par
Transcribe après l’information et le consentement affichés dans l’application.
L’agent n’écrit pas les images ou transcriptions dans sa base ; le serveur
conserve toutefois les événements/résultats de modération nécessaires à la
revue. Les paramètres et durées applicables chez AWS, Firebase/Google,
Cloudinary, LiveKit, Render, Neon et FedaPay doivent être vérifiés dans les
contrats et consoles de l’éditeur avant publication.

Les transferts internationaux, régions d’hébergement, sous-traitants ultérieurs
et garanties de transfert doivent être renseignés à partir des configurations
de production effectivement utilisées. La présence d’un fournisseur dans le
code ne signifie pas que sa fonction est activée dans chaque environnement.

## Durées de conservation — état vérifiable du code

Le code vérifie l’expiration d’un OTP après **5 minutes**. Cette échéance
invalide le code ; le code seul ne garantit pas l’effacement immédiat de sa
ligne de base de données. Le compte et les contenus liés ne disposent pas tous
d’une durée d’expiration automatique. Ils restent donc conservés jusqu’à
suppression par l’utilisateur, exécution de règles d’exploitation ou obligation
légale applicable. Le compte peut être supprimé depuis l’application ; la
suppression efface le profil, les contenus reliés avec suppression en cascade
et les médias Cloudinary associés au compte. Pour préserver les opérations
commerciales et les droits des autres parties, certaines données métier ne
sont pas supprimées en bloc : les commandes Pro conservent les montants et
articles, mais le lien vers l’acheteur, l’adresse, la position, les notes et le
code de remise sont effacés; le compte grossiste est désactivé et ses photos
produit sont supprimées. Les billets de voyage sont annulés et dissociés du
voyageur; un colis en cours est annulé, dissocié de l’expéditeur et son code de
retrait est invalidé. Des informations d’entreprise, de produits ou de
destinataires peuvent donc subsister; leur nécessité et leur durée doivent
être validées par un juriste avant publication.

Les fichiers et rapports hébergés par des prestataires, les journaux
d’infrastructure et les sauvegardes peuvent suivre des délais distincts. Les
durées de rétention des journaux Render, sauvegardes Neon, données Firebase,
Cloudinary, LiveKit, AWS et FedaPay ne sont pas fixées par le code de cette
application. Elles doivent être vérifiées et indiquées par l’éditeur. Les
délais de conservation comptable, de preuve de consentement et de traitement
des recours sont aussi à valider juridiquement.

## Droits et exercice des demandes

Sous réserve de la loi applicable, la personne peut demander l’accès, la
rectification, l’effacement, la limitation, l’opposition et, lorsque
applicable, la portabilité de ses données, ainsi que retirer un consentement.
Les données de profil peuvent être modifiées dans le profil. L’export des
données et la suppression du compte sont accessibles depuis Profil >
Confidentialité. Pour les autres demandes, utilisez le support dont les
coordonnées doivent être publiées avant lancement. Une vérification
raisonnable de l’identité peut être nécessaire pour protéger le compte.

Une demande d’effacement peut être différée ou limitée pour respecter une
obligation légale, traiter une contestation, prévenir une fraude ou établir,
exercer ou défendre un droit. Les données restantes doivent être limitées à
cette finalité et supprimées ensuite conformément à une durée documentée.

## Sécurité, mineurs et mises à jour

Des mesures techniques et organisationnelles sont mises en œuvre, notamment
l’authentification, les contrôles d’accès et la protection des transmissions.
Aucune mesure ne garantit une sécurité absolue. Le service n’est pas destiné
aux moins de 16 ans.

Cette politique peut évoluer. Une modification de sa version peut déclencher
une nouvelle demande d’acceptation dans l’application. La date d’entrée en
vigueur et l’historique des versions devront être publiés avec la politique.

## À compléter avant publication

1. Raison sociale, coordonnées et représentant du responsable du traitement.
2. Adresse publique du support et, le cas échéant, contact du délégué à la
   protection des données.
3. Bases juridiques par finalité et territoire, autorités de contrôle et
   procédure de réclamation.
4. Régions, contrats, sous-traitants ultérieurs et durées exactes des
   sauvegardes/journaux pour chaque prestataire réellement activé.
5. Durées de conservation métier pour SOS, signalements, contenus, transactions,
   recours et preuves d’acceptation.
6. Vérification des pratiques de l’agent AWS et des options de conservation
   choisies dans les consoles fournisseurs.
