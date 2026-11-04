import { GOLDEN_RULES } from "./goldenRules";

export const LEGAL_DOCUMENTS = [
  {
    id: "terms",
    title: "Conditions générales d’utilisation",
    body: "En utilisant QuartierPlus, vous vous engagez à fournir des informations exactes, à respecter les autres membres et à ne publier que des contenus que vous êtes autorisé à partager. Vous restez responsable de vos publications, messages, annonces et échanges. L’accès à certaines fonctions nécessite un compte. Les fonctions communautaires et les mises en relation sont fournies sans garantie de disponibilité continue. Toute décision de modération peut être contestée ; les sanctions sont graduées. Les présentes conditions ne limitent pas les droits prévus par la loi.",
  },
  {
    id: "privacy",
    title: "Politique de confidentialité",
    body: "QuartierPlus traite les données nécessaires à votre compte et aux fonctions choisies : identité et coordonnées, contenu publié, messages, position lorsqu’une fonction la nécessite, données de transaction, préférences, signalements et journaux techniques. Ces données peuvent être traitées par les prestataires d’hébergement, stockage média, vidéo, notifications, paiement et analyses décrits dans la politique de confidentialité. Vous pouvez demander l’accès, la rectification, la suppression ou l’export de vos données via le support. Les durées et exceptions légales applicables sont précisées dans la politique complète.",
  },
  {
    id: "golden_rules",
    title: "Règles d’or",
    body: GOLDEN_RULES.map((rule, index) => `${index + 1}. ${rule}`).join("\n\n"),
  },
  {
    id: "pro_terms",
    title: "Conditions Pro",
    body: "Les commerçants, grossistes, compagnies et mairies doivent fournir des informations exactes, des prix transparents et des offres disponibles. Ils restent responsables de leurs biens, services, autorisations, livraisons, remboursements et obligations légales. Les paiements peuvent être traités par FedaPay. Aucun produit ou service illégal ne peut être proposé. Les fonctions Pro peuvent être suspendues en cas de non-respect des règles ou de fraude.",
  },
  {
    id: "sos_safety",
    title: "Conditions SOS et sécurité",
    body: "Le SOS est réservé aux urgences réelles et peut transmettre aux personnes concernées les informations et la position que vous choisissez de partager. Une fausse alerte peut entraîner des sanctions. QuartierPlus ne remplace ni les services publics d’urgence, ni les professionnels de santé, ni les secours : appelez directement le numéro officiel local. La disponibilité du réseau, du GPS et des services tiers n’est pas garantie.",
  },
  {
    id: "automated_moderation",
    title: "Information sur la modération automatisée",
    body: "Certains textes, images, vidéos ou échanges audio peuvent être analysés automatiquement pour détecter les contenus interdits et protéger la communauté. Un résultat automatisé peut être erroné et ne constitue pas à lui seul un jugement définitif. La modération humaine peut examiner un contenu signalé ou détecté, et une décision peut être contestée. Les traitements et prestataires utilisés sont décrits dans la politique de confidentialité.",
  },
] as const;

export type LegalDocumentId = (typeof LEGAL_DOCUMENTS)[number]["id"];

export const FALLBACK_LEGAL_VERSION = "2026-11-04.1";
