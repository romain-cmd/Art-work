# Parcours artwork

## Choisir les devis à suivre

- Dans **Dossiers artwork**, cliquer sur **Ajouter un devis Shopify**, rechercher le devis et l’ajouter au suivi. L’application ajoute le tag `ARTWORK_REQUIRED` au devis.
- Ou ajouter ce tag directement dans Shopify. L’index artwork récupère uniquement les devis portant ce tag, classés par date de dernière modification Shopify décroissante. **Actualiser Shopify** force la synchronisation.
- Les dossiers ayant déjà des personnalisations sont conservés automatiquement, même sans tag. Aucun fichier, lien client ou accord existant n’est supprimé par la migration.
- Dans le dossier, qualifier chaque article : **BAT requis**, **Sans BAT requis** ou **À qualifier**. Une nouvelle ligne Shopify commence à qualifier. Les articles sans BAT sont exclus des validations et des travaux de production.
- **Retirer du suivi artwork** retire le tag et archive le dossier. Les fichiers et l’historique restent accessibles dans **Archives**. La réactivation est explicite.

## Préparer et faire valider

Chaque dossier réunit les articles, leurs caractéristiques, leurs logos, leurs BAT et l’historique. La variante Shopify indique la taille du vêtement ; les dimensions du marquage ont leur propre champ. Les logos sources peuvent être des images, PDF, AI ou EPS. Les BAT à présenter au client doivent être PNG, JPG, WebP ou PDF, 20 Mo maximum par fichier.

Les paramètres et le logo peuvent être copiés vers d’autres articles du même dossier. Les BAT et les accords clients ne sont jamais copiés. Plusieurs vues de BAT peuvent être ajoutées à une personnalisation et doivent toutes être approuvées.

Une nouvelle version remplace le BAT actuel sans effacer l’ancien. Une modification des caractéristiques ou d’une quantité/titre synchronisé depuis Shopify crée aussi une nouvelle version à envoyer et faire valider. Le BAT précédent conserve son image, ses caractéristiques, sa réponse et son lien historique.

L’envoi et la relance sont distincts. Avant confirmation, l’application affiche le destinataire, le contenu de l’email et les versions concernées. Les versions envoyées sont vérifiées à nouveau côté serveur. Une validation reçue par email, WhatsApp ou téléphone peut être enregistrée avec son canal. Les réponses via le lien client et les demandes de correction apparaissent dans l’historique.

La page client est en anglais, présente le yacht/devis et l’avancement, permet d’ouvrir le fichier en grand et conserve le récapitulatif des réponses. Un lien vers une version remplacée ne permet plus de la valider.

## Produire

Les travaux apparaissent lorsque le devis Shopify devient une commande. Tout le dossier doit être qualifié et tous ses BAT actuels approuvés avant le démarrage, la clôture ou la transmission au partenaire. Les articles sans BAT restent hors de ce parcours.

Le suivi propose une vue tableau et une vue liste, la recherche, les filtres, les échéances et les archives. Les travaux sont classés par échéance, avec indication des retards. Les fichiers transmis comprennent les BAT actuels validés et le logo source, en conservant leur format. La date et le destinataire du dernier envoi sont mémorisés. Changer le partenaire par défaut nécessite de cocher l’option correspondante. Un travail terminé peut être archivé.

## Vérification de la livraison

- Tests unitaires : statuts et conditions d’approbation, instantanés, formats, synchronisation des lignes Shopify, pagination, remappages ambigus et isolation boutique/devis.
- Migration SQL testée sur PostgreSQL embarqué avec données anciennes : dossiers, accords, tokens et instantanés conservés.
- Parcours navigateur sur données de test, ordinateur et mobile : fil, recherche Shopify, dossier, aperçu email, garde des modifications non enregistrées, blocage production et page client, sans débordement horizontal ni erreur JavaScript.
- Build client/serveur, lint, vérification TypeScript et validation des opérations GraphQL sur l’API Shopify 2026-07.

Les essais navigateur utilisent des données de test et des actions simulées. Ils n’envoient aucun email réel et ne modifient aucun devis marchand. La première utilisation réelle permet de vérifier les fichiers et emails avec les paramètres de la boutique.
