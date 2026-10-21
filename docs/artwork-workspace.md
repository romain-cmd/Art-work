# Parcours artwork

## Choisir les devis à suivre

- Dans **Dossiers artwork**, cliquer sur **Ajouter un devis Shopify**, rechercher le devis et l’ajouter au suivi. L’application ajoute le tag `ARTWORK_REQUIRED` au devis.
- Ou ajouter ce tag directement dans Shopify. L’index artwork récupère uniquement les devis portant ce tag, classés par date de dernière modification Shopify décroissante. **Actualiser Shopify** force la synchronisation.
- Les dossiers ayant déjà des personnalisations sont conservés automatiquement, même sans tag. Aucun fichier, lien client ou accord existant n’est supprimé par la migration.
- Dans le dossier, qualifier chaque article : **BAT requis**, **Sans BAT requis** ou **À qualifier**. Une nouvelle ligne Shopify commence à qualifier. Les articles sans BAT sont exclus des validations et des travaux de production.
- **Retirer du suivi artwork** retire le tag et archive le dossier. Les fichiers et l’historique restent accessibles dans **Archives**. La réactivation est explicite.

## Préparer et faire valider

Chaque dossier réunit les articles, leurs caractéristiques, leurs logos, leurs BAT et l’historique. La variante Shopify indique la taille du vêtement ; les dimensions du marquage ont leur propre champ. Les logos sources peuvent être des images, PDF, AI ou EPS. Les BAT à présenter au client doivent être PNG, JPG, WebP ou PDF, 20 Mo maximum par fichier.

Un même article peut recevoir plusieurs personnalisations, par exemple 20 polos avec une broderie poitrine et une impression dos. **Ajouter une personnalisation** crée un marquage indépendant. **Dupliquer cette personnalisation** ouvre un formulaire reprenant les caractéristiques, la quantité concernée et le logo du marquage choisi, même sans logo. Modifier les champs puis enregistrer pour créer la nouvelle personnalisation sur le même article. Les accords clients, transmissions et états de production ne sont pas dupliqués. Les artworks sont présentés une seule fois dans **BAT communs**, même lorsqu’ils couvrent plusieurs tailles. Les caractéristiques restent accessibles dans **Vêtements et marquages**. Un seul fichier peut couvrir tous ses marquages. Lors de l’import, les marquages sont tous sélectionnés par défaut ; on peut limiter cette association si le fichier ne les représente pas tous.

Chaque marquage est identifié par sa technique, son emplacement et une référence stable, dans le dossier, les emails, la page client et la production. Les quantités représentent les pièces concernées par chaque marquage : 20 broderies et 20 impressions sur 20 polos restent **20 polos à livrer**. Les bons de livraison continuent à lire les lignes de commande Shopify, indépendamment des personnalisations.

Les paramètres et le logo peuvent être copiés vers d’autres articles du même dossier. Les BAT et les accords clients ne sont jamais copiés. Plusieurs vues peuvent être ajoutées et doivent toutes être approuvées. Un artwork commun est compté et envoyé une seule fois, même s’il couvre plusieurs marquages. La page client montre le fichier et les caractéristiques de chaque marquage ; la réponse et les commentaires portent sur cette version complète.

**Remplacer l’artwork** crée une nouvelle version sans effacer l’ancienne. **Modifier les marquages associés** permet de rattacher un artwork existant à plusieurs marquages du même article, avec une nouvelle validation obligatoire. **Supprimer l’artwork** le retire du suivi actif pour tous ses marquages, désactive son lien client et remet la production concernée à revoir ; une trace reste dans l’historique. Cette suppression n’efface pas le fichier source hébergé dans Shopify Files. Une modification des caractéristiques ou d’une quantité/titre synchronisé depuis Shopify crée aussi une nouvelle version à envoyer et faire valider. Le BAT précédent conserve son image, ses caractéristiques, sa réponse et son lien historique.

L’envoi et la relance sont distincts. Avant confirmation, l’application affiche le destinataire, le contenu de l’email et les versions concernées. Les versions envoyées sont vérifiées à nouveau côté serveur. Une validation reçue par email, WhatsApp ou téléphone peut être enregistrée avec son canal. Les réponses via le lien client et les demandes de correction apparaissent dans l’historique.

La page client est en anglais, présente le yacht/devis et l’avancement, permet d’ouvrir le fichier en grand et conserve le récapitulatif des réponses. Un lien vers une version remplacée ne permet plus de la valider.

## Produire

Les travaux apparaissent lorsque le devis Shopify devient une commande. Tout le dossier doit être qualifié et tous ses BAT actuels approuvés avant le démarrage, la clôture ou la transmission au partenaire. Les articles sans BAT restent hors de ce parcours.

Le suivi propose une vue tableau et une vue liste, la recherche, les filtres, les échéances et les archives. Les travaux sont classés par échéance, avec indication des retards. Les fichiers transmis comprennent les BAT actuels validés et le logo source, en conservant leur format. La date et le destinataire du dernier envoi sont mémorisés. Changer le partenaire par défaut nécessite de cocher l’option correspondante. Un travail terminé peut être archivé.

Ajouter un marquage après démarrage ou transmission inscrit une alerte dans l’historique du dossier et bloque la poursuite tant que ses BAT ne sont pas validés. Modifier les caractéristiques ou ajouter/remplacer un BAT d’un marquage remet sa carte à **À faire** et la réactive si elle était archivée. Les dates, le dernier destinataire et la dernière transmission sont conservés pour contacter le partenaire ; les autres marquages conservent leurs accords et leur avancement. Toute modification de quantité/titre synchronisée depuis Shopify applique cette règle à chaque marquage concerné.

## Vérification de la livraison

- Tests unitaires : statuts et conditions d’approbation, instantanés, formats, synchronisation des lignes Shopify, pagination, remappages ambigus et isolation boutique/devis.
- Migration SQL testée sur PostgreSQL embarqué avec données anciennes : dossiers, accords, tokens et instantanés conservés.
- Parcours navigateur sur données de test, ordinateur et mobile : fil, recherche Shopify, dossier, aperçu email, garde des modifications non enregistrées, blocage production et page client, sans débordement horizontal ni erreur JavaScript.
- Build client/serveur, lint, vérification TypeScript et validation des opérations GraphQL sur l’API Shopify 2026-07.

Les essais navigateur utilisent des données de test et des actions simulées. Ils n’envoient aucun email réel et ne modifient aucun devis marchand. La première utilisation réelle permet de vérifier les fichiers et emails avec les paramètres de la boutique.

## Vérifier les personnalisations multiples

- `npm run test:artwork` : tests des caractéristiques, statuts, synchronisation et actions réelles de formulaire (duplication, validation client, production, révision, sources interdites). Le test de parcours utilise des doubles isolés pour la base, Shopify, le stockage des fichiers et les emails ; il ne vérifie pas PostgreSQL ni un compte marchand réel.
- `node scripts/artwork-browser-check.mjs` : parcours avec les vrais composants et actions, sur 1440 et 390 pixels. Nécessite Playwright et Chromium de test ; `ARTWORK_PLAYWRIGHT_MODULE` permet d’utiliser une installation externe et `PLAYWRIGHT_BROWSERS_PATH` son dossier de navigateurs. Les captures sont écrites dans `test-results/artwork/`.
- Vérifier ensuite en environnement de recette un article à deux marquages avec logo réel, ses deux BAT, une réponse partielle, une correction et deux partenaires. La migration `20261020160000_shared_artwork` ajoute les associations entre artworks et marquages. Les anciens liens, tokens, fichiers et réponses sont conservés, avec chaque ancien artwork rattaché à son marquage d’origine. Pour un ancien fichier représentant déjà plusieurs marquages, utiliser « Modifier les marquages associés ».

Limites des outils sur cette évolution : le lint du périmètre modifié, les types du projet et le build passent. Le lint global conserve des erreurs préexistantes dans les fichiers de livraison. Le validateur statique du Toolkit Shopify remonte les mêmes neuf erreurs de typage sur la page avant et après modification (notamment les composants React Router et le typage App Bridge) ; ce contrôle n’est donc pas vert. Les tests de parcours et le contrôle TypeScript du projet utilisent les dépendances réelles de l’application.

### Contrôles des artworks communs

Les tests vérifient deux broderies ou une broderie et une impression sur un article, l’envoi unique, les commentaires et la validation commune, le remplacement, le retrait et la désactivation des anciens liens, la réouverture de production et l’absence de versions doublonnées lors d’une synchronisation Shopify. Les tests PostgreSQL utilisent uniquement une base jetable avec `DELIVERY_TEST_DATABASE=1` et vérifient la migration des anciens tokens/accords et la relation plusieurs-à-plusieurs avec Prisma.

### Regrouper des tailles dans un BAT

Dans **Préparer un BAT**, choisir les vêtements avant les marquages et le fichier. Pour un BAT existant, ouvrir **Autres actions → Modifier les marquages associés** et sélectionner les autres tailles du même produit dans **Regrouper d’autres tailles dans ce BAT**. Les lignes Shopify restent distinctes. Les lignes sans marquages reprennent les caractéristiques de référence, avec leur propre quantité ; les lignes déjà préparées doivent présenter les mêmes marquages (technique, emplacement, dimensions, couleur du marquage, texte, logo). Les différences sont refusées, sans création partielle. Une couleur de vêtement différente reste un choix explicite, jamais un regroupement automatique.

La liste des tailles, couleurs, références et quantités Shopify est figée dans chaque version d’artwork. Elle apparaît côté équipe et client, et dans un **récapitulatif PDF joint à l’email client et à la transmission partenaire**, également téléchargeable à côté du fichier original. Les caractéristiques et quantités des marquages figurent séparément ; le total des articles n’est jamais multiplié par le nombre de marquages. Le fichier graphique importé n’est pas retouché.

Décocher une taille dans une nouvelle version la dissocie : ses marquages demandent ensuite un BAT distinct si aucun autre artwork actuel ne les couvre. Un changement Shopify de taille, couleur, référence ou quantité impose une nouvelle validation. Les anciennes versions conservent leur récapitulatif d’origine. Les options Shopify `Size`/`Taille` et `Color`/`Colour`/`Couleur` sont reconnues ; sinon le titre complet de la variante est affiché pour éviter de deviner une taille.


## Interface de préparation et de validation

- Le dossier s’ouvre sur **BAT communs** : chaque artwork actuel apparaît une seule fois, avec les vêtements couverts, les quantités par taille, les marquages, son état et le récapitulatif PDF. Les anciennes versions sont repliées. Les marquages existants restent modifiables par taille dans **Vêtements et marquages**.
- **Préparer un BAT** suit quatre étapes : **Vêtements → Marquages → Artwork → Vérification**. Le regroupement des tailles de même produit et couleur est proposé, jamais imposé. Les autres couleurs demandent une confirmation explicite. L’assistant conserve les textes et fichiers entre étapes tant qu’il reste ouvert ; fermer ou quitter un brouillon modifié demande confirmation. Il ne restaure pas une préparation après fermeture du navigateur.
- Chaque nouveau marquage concerne initialement tous les vêtements choisis. **Seulement certaines pièces ?** permet une quantité distincte par taille. Les quantités des marquages déjà existants ne sont pas écrasées par le regroupement. Un conflit avec leurs caractéristiques ou quantités est refusé.
- L’enregistrement est transactionnel pour les marquages, leur regroupement, le suivi de production et les nouveaux BAT. Aucun email n’est envoyé par l’assistant. Une modification Shopify ou d’un marquage depuis l’ouverture impose de vérifier à nouveau la préparation. Les fichiers Shopify, stockés avant la transaction, ne sont pas effacés si une transaction échoue.
- **Enregistrer comme modèle réutilisable** conserve un nom, les caractéristiques et le logo d’un marquage dans la boutique. Les modèles sont disponibles entre dossiers ; aucune quantité, validation ou progression de production n’est copiée. Leur suppression ne modifie pas les marquages déjà créés. Les modèles se gèrent dans l’onglet **Modèles**.
- Les éléments manquants avant envoi sont nommés individuellement et disposent d’un accès **Compléter**. L’aperçu d’envoi montre les visuels, variantes et pièces jointes. **Voir comme le client** utilise le même composant que la page publique, sans boutons de validation. L’email et la page client restent en anglais ; cette langue est indiquée avant l’envoi.
- La page client affiche d’abord le visuel, puis un résumé du périmètre. Les caractéristiques sont dépliables. Le visuel peut être agrandi dans une fenêtre avec focus géré par le navigateur ; les PDF restent consultables avec leurs commandes natives et un lien vers l’original. Chaque décision porte sur le BAT complet.
- Une correction peut cibler un marquage et, sur une image, comporter un repère facultatif. Le commentaire conserve son marquage et les coordonnées relatives du point ; le repère est visible au rechargement et dans le dossier interne. Pour un PDF, le client décrit la page et la zone dans son commentaire. La comparaison interne propose les deux fichiers côte à côte lors d’un remplacement et entre versions liées ; elle ne calcule pas une différence graphique automatique.
- Les actions de suppression sont secondaires et demandent confirmation. Remplacer ou modifier le périmètre continue d’exiger une nouvelle validation et de réouvrir la production concernée.
- La liste des dossiers propose cinq files de travail, la recherche par responsable et le nombre de jours depuis le plus ancien envoi encore en attente. Le responsable est un nom libre, facultatif, modifiable dans **Informations et actions du dossier** ; ce champ ne change pas les droits d’accès.

La migration additive `20261020180000_artwork_workspace` ajoute le responsable facultatif et les modèles par boutique. Elle ne modifie pas les fichiers, liens, associations, quantités ou accords existants.


## Corriger une personnalisation et transmettre au prestataire

Depuis un BAT à corriger, **Préparer la correction** ouvre tous ses marquages : technique, emplacement, dimensions, couleur, texte, quantités par taille et remplacement facultatif des logos sources. Un nouvel artwork corrigé est requis. **Autres actions → Modifier les personnalisations et le BAT** permet la même reprise d’un BAT déjà validé ou en attente.

Les marquages identiques regroupés sur plusieurs tailles sont modifiés ensemble, avec leurs quantités propres. L’enregistrement est transactionnel et vérifie que les données n’ont pas changé pendant le formulaire et l’import. Une seule nouvelle version du BAT principal est créée ; les autres vues qui partagent des caractéristiques modifiées sont aussi révisées une fois. Les anciennes réponses, fichiers et liens historiques sont conservés. La production concernée repasse à revoir et les partenaires déjà destinataires restent identifiables. Aucun email client n’est envoyé par cette opération : utiliser ensuite l’aperçu et l’envoi client pour obtenir une nouvelle validation.

Depuis un BAT actuel validé, **Envoyer au prestataire** permet de sélectionner les marquages confiés à ce destinataire, son email et éventuellement sa mémorisation par technique. Une transmission peut couvrir plusieurs tailles et plusieurs marquages dans un seul email. Le fichier BAT validé et son récapitulatif PDF sont joints une seule fois ; les logos sources sélectionnés sont dédupliqués par URL. Le corps du message détaille uniquement les caractéristiques et quantités par taille des marquages confiés à ce prestataire, et précise que le fichier commun peut comporter d’autres marquages.

La qualification et tous les BAT du dossier doivent être finalisés avant transmission, conformément au blocage de production existant. La transmission depuis le dossier est possible dès validation d’un devis, même avant sa conversion en commande ; le démarrage de production conserve sa condition de commande Shopify. Le dernier destinataire et la date sont enregistrés sur cette version de BAT et sur les cartes existantes des seuls marquages transmis ; chaque envoi est inscrit à l’historique du dossier. Les nouvelles versions ne reprennent pas ces dates comme si elles avaient déjà été transmises. Dans le Kanban, l’adresse proposée vient du partenaire par défaut de la technique actuelle ; une ancienne adresse n’est pas reprise automatiquement après un changement de technique.

La migration additive `20261021090000_artwork_partner` ajoute uniquement deux champs facultatifs de dernière transmission au BAT. Les tests couvrent la correction technique/emplacement sur deux tailles, les vues partagées, les anciens accords, les sélections étrangères/périmées, deux prestataires distincts et les pièces jointes, avec envois simulés uniquement.
