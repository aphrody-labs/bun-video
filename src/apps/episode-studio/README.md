# Atelier épisode

Page React locale pour explorer les ressources produites avec Bun Video.
Le lecteur, les chapitres, les images, les GIF et les icônes utilisent
le `manifest.json` de l’épisode. Les fichiers en préparation restent signalés.

Depuis `packages/bun-video` :

```powershell
bun src/apps/episode-studio/server.ts
bun src/apps/episode-studio/server.ts --episode-dir .local/episodes/beerus-01 --port 3217
bun test src/apps/episode-studio/server.test.ts
bun src/apps/episode-studio/browser-check.ts
bun src/apps/episode-studio/browser-check.ts --check-only
bun check --project src/apps/episode-studio/tsconfig.json --noEmit
```

Le serveur écoute uniquement sur `127.0.0.1`. `--port 0` choisit un port libre.
Il compile React avec le plugin propriétaire `m3Bun` et `Bun.build` en mémoire,
sans générer de bundle dans le dépôt. Les composants viennent de
`@aphrody/m3-primitives` et les feuilles de `@aphrody/m3-tokens` et `@aphrody/m3-theme`.
Le plugin M3 est résolu depuis l’intégration M3 installée dans ce même checkout.
Les médias restent dans le dossier ignoré de l’épisode. Il sert seulement les
ressources déclarées et les images numérotées déjà extraites. Les liens et jonctions
sortant du dossier sont refusés. Les requêtes HTTP Range permettent le seek vidéo.

Le manifeste suit les types de `manifest.ts`. `frames.count` indique le nombre
d’images disponibles ; `frameCount` indique le nombre attendu dans la source.
Une compression est annoncée vérifiée seulement si `compression.verified` est vrai.
Les pistes WebVTT alimentent le lecteur ; les pistes SRT restent téléchargeables.
Les volumes et métadonnées du package, les données bilingues et les références
SVG sont accessibles lorsqu’ils sont déclarés. Une transcription japonaise ASR
reste distinguée des sous-titres officiels ; ses fenêtres temporelles et son
statut de reconnaissance automatique non relue sont visibles.

Les GIF utilisent une palette limitée et ne sont pas des exports sans perte.
La page permet de comparer les images originales et de télécharger leurs fichiers.

Le thème provient des pixels décodés de l’image vidéo courante via
`src/frame-theme.ts`. Un canvas de 64 pixels au maximum échantillonne l’image
une fois par seconde et lors des seeks ou pauses. M3 génère les rôles sémantiques
avec la variante `content` sombre. L’affiche fournit la couleur avant le décodage
vidéo. Aucune palette locale n’est fixée dans la page. Son CSS ne définit que la
mise en page et emploie les tokens M3 pour les couleurs, formes et textes.

La dominante et les mesures de détail peuvent ensuite provenir d’un calcul WGSL
sur le GPU Chromium, via `POST /api/frame-analysis`. Cette route accepte seulement
des pixels RGBA de 4 à 256 pixels par côté, un seul calcul à la fois, borné à cinq
secondes. La page échantillonne au plus une fois toutes les trois secondes pendant
la lecture et écarte les réponses d’une image devenue obsolète. Le GPU analyse les
pixels ; le décodage vidéo reste celui du lecteur. Si l’adaptateur est indisponible,
le thème depuis les pixels locaux reste actif. `BUN_VIDEO_CHROMIUM_EXECUTABLE`
peut sélectionner le navigateur propriétaire installé ; aucun chemin n’est reçu
du client. M3 seul transforme la dominante mesurée en rôles de couleur.

`browser-check.ts` utilise le Chrome natif installé dans Program Files avec
un profil temporaire isolé. Il vérifie la lecture, les chapitres, le pas d’image,
les ressources présentes, les composants M3 et le débordement mobile. Deux scènes
réelles, à 480 et 780 secondes, doivent produire des couleurs M3 différentes.
Il enregistre un rapport et quatre captures dans `browser-test/`, dans le dossier
ignoré de l’épisode. Le profil
est supprimé à la fermeture. Deux arguments optionnels choisissent le dossier
d’épisode puis le chemin du navigateur. Le processus est borné à 60 secondes.
Le mode `--check-only` conserve tous les assets existants et leurs SHA-256.
Le mode normal réécrit les reçus SVG et les cinq snapshots M3 ; il doit être
exécuté avant l’indexation et l’empaquetage. Les téléchargements déclarés du
dataset et du package sont contrôlés par des requêtes HEAD.

Une archive déclarée mais absente renvoie HTTP 404 en HEAD : la page ne prétend
pas qu’elle existe localement. Son GET déclenche `rehydrateEpisodeVolume` depuis
le manifeste immuable, avec un seul calcul d’archive simultané, un budget maximal
de 128 MiB et une borne de 60 secondes. La taille et le SHA-256 originaux doivent
correspondre avant création atomique ; un fichier existant n’est jamais remplacé.
Le statut `archives-reconstructible-r2-incomplete` distingue cette situation d’une
livraison complète. Une reconstruction occupée renvoie HTTP 429 ; une source
altérée renvoie HTTP 503.
