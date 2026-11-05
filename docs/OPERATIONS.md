# Exploitation et durabilité

## Sauvegardes Neon

- Vérifiez dans la console Neon le plan, la fenêtre de restauration/PITR et les
  limites de stockage réellement applicables au projet; elles varient selon le
  plan et ne sont pas garanties par le dépôt.
- Gardez la restauration dans le même compte contrôlé et donnez l’accès
  uniquement aux opérateurs autorisés. Ne copiez pas `DATABASE_URL` dans les
  tickets, journaux ou fichiers suivis par Git.
- Avant une migration ou une opération de maintenance risquée, créez un
  branchement Neon ou un instantané manuel si le plan le permet. Pour une copie
  indépendante, utilisez `pg_dump` depuis un environnement de confiance et
  chiffrez le fichier avant de le déplacer hors de l’environnement.
- Testez régulièrement une restauration sur un projet distinct, puis vérifiez
  les extensions PostGIS/uuid-ossp, les migrations et quelques parcours
  anonymisés. Une sauvegarde qui n’a jamais été restaurée n’est pas validée.
- Le dépôt ne crée pas de sauvegardes Neon, ne vérifie pas leur succès et ne
  configure pas la rétention du fournisseur. Ces opérations doivent être
  attribuées à un responsable et consignées dans le runbook privé de
  l’organisation.

## Environnement de test

- Utilisez un projet Neon séparé et un service Render de préproduction; ne
  reliez pas une application de test à la base de production.
- Réutilisez les migrations dans l’ordre décrit dans [DEPLOY.md](./DEPLOY.md),
  puis chargez uniquement des comptes et données synthétiques.
- Gardez distincts `DATABASE_URL`, clés Firebase/Google, LiveKit, Cloudinary,
  FedaPay, SMTP et le fournisseur SMS. N’activez pas de paiements réels,
  d’envoi SMS réel ou de modération facturée dans les tests automatisés.
- Réservez `OTP_TEST_MODE=true` à une API de test non publique et limitez
  `OTP_TEST_ALLOWLIST` à des numéros de test maîtrisés. Ne copiez jamais de
  données de production vers cet environnement.

## Drapeaux et plafonds serveur

Les contrôles suivants sont lus par le serveur au démarrage; les changer dans
Render permet de modifier le comportement sans publier un nouveau binaire
mobile. Après une modification, vérifiez l’API et ses journaux :

| Variable | Usage | Valeur de départ |
| --- | --- | --- |
| `MAINTENANCE_MODE` | Bloque les routes API pendant une intervention | `false` |
| `MINIMUM_APP_VERSION` | Refuse les clients plus anciens; `0.0.0` désactive le contrôle | `0.0.0` |
| `UPLOADS_DAILY_LIMIT` | Nombre quotidien de signatures d’upload par compte | `20` |
| `SMS_DAILY_LIMIT` | Plafond quotidien global d’envois SMS | `500` |
| `MODERATION_UPLOADS_ENABLED` | Active l’analyse des médias publiés | `false` |
| `MODERATION_DAILY_ANALYSIS_LIMIT` | Plafond quotidien d’analyses média | `100` |
| `TEXT_MODERATION_ENABLED` | Analyse des propos publics | `false` |
| `CONFLICT_PROTECTION_ENABLED` | Protections contre les conflits répétés | `false` |
| `GRIN_MODERATION_ENABLED` | Modération LiveKit via l’agent séparé | `false` |
| `BILLING_ENABLED` | Activation des opérations de paiement | `false` |
| `PRO_ENABLED` / `VOYAGE_ENABLED` | Activation des modules professionnels | `false` |
| `AUDIT_LOG_RETENTION_DAYS` | Rétention côté API du journal d’administration | `365` |

`POST_DAILY_LIMIT` et les limites `POST_MAX_*` encadrent aussi la publication.
Les rate limits des routes sensibles sont par instance serveur; un déploiement
multi-instance doit aussi configurer une limite distribuée si une protection
globale est requise. Les quotas de coût ne remplacent pas les alertes et
budgets du fournisseur Cloudinary, AWS, Firebase, LiveKit, SMS ou FedaPay.

Le nettoyage de `admin_audit_log` est exécuté au démarrage puis toutes les
24 heures. Il supprime les lignes antérieures au nombre de jours configuré;
une erreur est écrite dans les journaux Render et doit être traitée comme un
échec opérationnel.

## Vérification CI

Le workflow [ci.yml](../.github/workflows/ci.yml) s’exécute sur chaque push et
ne lance que les suites de tests serveur/mobile, `tsc --noEmit` et
`expo export`. Il ne produit pas d’APK/AAB et n’exécute aucune commande EAS
Build. Les exports sont écrits dans `/tmp`, pas dans le dépôt.

## Dossier Google Play

Avant une publication, préparer et faire valider par la personne responsable :

- le formulaire **Sécurité des données** d’après les versions réellement
  publiées, les SDK actifs, Firebase/Google, Render/Neon, Cloudinary, LiveKit,
  AWS et les fournisseurs de paiement/SMS effectivement configurés;
- la déclaration d’accès à la localisation en arrière-plan, la vidéo de
  démonstration et la justification du suivi de livraison Pro, qui ne doit
  démarrer qu’après consentement et s’arrêter à la fin de la livraison
  ([détails dans DEPLOY.md](./DEPLOY.md));
- les liens de confidentialité, les coordonnées de l’éditeur/support, la
  classification du contenu et les réponses aux questions de sécurité des
  enfants;
- la liste des permissions natives, les captures d’écran du parcours de
  permission au moment utile, et le comportement de la version installée.

Ne déclarez pas une collecte ou une rétention comme absente sans vérifier les
SDK, réglages de production et consoles fournisseurs. Les brouillons juridiques
restent à valider par un juriste avant publication.
