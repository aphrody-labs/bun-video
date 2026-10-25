# Analyse, assets et thème d’un épisode

Le workbench conserve la vidéo et les résultats dans `.local/episodes/`, ignoré
par Git. Le déplacement de la source n’altère pas ses octets. Les commandes
partent du checkout Bun Video sélectionné, sur Windows natif.

```powershell
bun scripts/episode-assets.ts --help
bun scripts/episode-package.ts --help
bun src/apps/episode-studio/server.ts --episode-dir .local/episodes/beerus-01
```

`episode-assets.ts` utilise exclusivement `Bun.Video` et `Bun.Image` natifs.
Il analyse le conteneur, extrait chaque PNG RGBA ou WebP sans perte à la résolution
d’origine, préserve les access units dans un remux MP4 et produit les GIF. La
vérification compare **toutes** les frames RGBA et les fenêtres WAV PCM16 de la
source et du remux, avec cadence, compte, dimensions et timeline contrôlés.
Chaque batch contient au plus huit frames et 64 MiB, une opération à la fois.
Les fenêtres audio font vingt secondes au maximum. `--frame-limit` reste partiel.
Une extraction déjà présente n’est pas écrasée. Les artifacts de la première
analyse conservent leur provenance historique ; aucun nouveau résultat natif
intégral n’est affirmé sans son reçu.
Changer le conteneur ne restaure pas une information déjà perdue dans le H.264.
Les GIF ont une palette limitée ; leur résolution et leur cadence sont distinctes
des images de référence.

`Bun.Image` possède les métadonnées, les vignettes, les affiches et les WebP sans
perte. Sharp n’entre pas dans ce pipeline. Les API TypeScript publiques sont
`@aphrody/bun-video/episode-assets`, `/episode-dataset`, `/pixel-svg`,
`/frame-theme`, `/episode-unpack` et `/shenron-episode`.

## Images et M3

La page React utilise le plugin `@aphrody/m3-bun`, les composants
`@aphrody/m3-primitives`, les styles `@aphrody/m3-theme` et les tokens
`@aphrody/m3-tokens`. L’image courante fournit une couleur de départ réelle ;
le propriétaire M3 génère les rôles sémantiques. Les rôles changent pendant la
lecture et après un seek. Les formes et la typographie viennent du système M3.
Une frame d’animé ne constitue pas une preuve des paramètres d’un système UI.

Les SVG de personnages stylisés et les SVG de pixels exacts sont deux exports
distincts. Les seconds reproduisent leur référence **redimensionnée** sans
image raster embarquée ; le reçu indique la résolution et la différence mesurée.
[SVG et comparaison](episode-svg.md), [page](../src/apps/episode-studio/README.md).

## Dataset et Shenron

Les pistes françaises fournisseur et les transcriptions japonaises ASR gardent
leur provenance propre. Une transcription n’est pas une piste officielle
Crunchyroll. Les partitions train/validation/test restent issues d’un seul
épisode ; les métriques de détail visuel ne valident ni le personnage visible,
ni la traduction, ni le meilleur moment narratif. Aucun entraînement n’est lancé.
[Dataset](episode-dataset.md), [contrat Shenron](shenron-episode-assets.md).

## Package complet

```powershell
bun scripts/episode-package.ts images .local/episodes/beerus-01
bun scripts/episode-package.ts index .local/episodes/beerus-01
bun scripts/episode-package.ts pack .local/episodes/beerus-01
# Après ajout de fichiers : réutilise les assets inchangés et les volumes qualifiés.
bun scripts/episode-package.ts refresh .local/episodes/beerus-01
bun scripts/episode-package.ts pack .local/episodes/beerus-01
# Destination explicite vide ; vérifie chaque volume et chaque asset reconstruit.
bun scripts/episode-package.ts unpack .local/episodes/beerus-01 D:\exports\episode
```

`package/manifest.json` couvre chaque asset : chemin relatif, type MIME, taille,
SHA-256, provenance, dimensions, numéro d’image et timecode. `packed` désigne un
blob dédupliqué ; `parts` décrit les morceaux ordonnés des gros fichiers. Les
volumes tar.gz utilisent `Bun.Archive`, 64 MiB de contenu au maximum, gzip niveau 1
et date déterministe. Chaque entrée est relue et comparée par SHA-256 avant
validation. `SHA256SUMS` liste les hashes des volumes. La reconstruction maintient
une seule archive en mémoire et vérifie aussi le hash final des fichiers découpés.

`rehydrateEpisodeVolume(root, manifest, bundle, options)` recrée uniquement un
volume manquant depuis ses références `packed` et `parts`. Les blobs sont relus
avec leur SHA-256 ; les grands fichiers fournissent seulement la tranche déclarée,
vérifiée par son SHA-256 propre. L’ordre des premières références est conservé,
les doublons partagent une entrée, puis `createVideoArchive` produit le tar.gz
original avec niveau 1 et mtime zéro. Taille et SHA-256 du volume doivent égaler
le descripteur immuable avant publication atomique sans remplacement.
`created: true` dans le reçu identifie une création de ce helper ; un fichier
préexistant qualifié retourne `existing-verified`. Le budget est plafonné à
128 MiB, les liens symboliques/jonctions sont refusés et un signal peut annuler
les lectures. Un volume original divergent n’est jamais écrasé.
Après retrait d’un volume, les prochains noms suivent le plus grand ordinal
existant, ce qui conserve les trous sans écraser les autres archives.
La page sert ces volumes à la demande et distingue archives reconstructibles,
fichiers réellement présents et livraison R2 incomplète.

Les cookies, tokens, sessions fournisseur, modèles et journaux privés restent
dans leurs stores protégés. Les datasets finaux autorisés peuvent être livrés.
La publication R2 utilise un namespace immuable et un reçu ; le catalogue CDN
et son pointer appartiennent au publisher Infra unique.

Le skill existant [video-pixel-perfect](../../../.claude/skills/video-pixel-perfect/SKILL.md)
décrit le replay de même durée avec FPS rationnel, source encodée préservée et
mesures RGBA/PCM natives. Le provider n’expose pas d’encodeur arbitraire de
séquence RGBA ; une composition indépendante reste une portée distincte.
Le replay complet d’un épisode doit être qualifié
par ses propres mesures ; la seule présence du skill ne prouve pas ce rendu.

Les nouveaux thumbnails sont décodés exclusivement par `Bun.Image.rgba()` avec
un budget de 256 × 256 pixels. `measureFrameDetail` est désormais asynchrone et
délègue luminance, contraste, Laplacien, contours et score à `analyzeFrameRgba`.
Le workflow choisit explicitement le backend Chromium ; une indisponibilité GPU
interrompt l’analyse, sans calcul CPU de substitution. Chaque nouvelle métrique
conserve l’adaptateur, le nombre de pixels et la preuve WGSL du même dispatch.
Les anciens datasets qualifiés restent inchangés, avec leurs mesures et SHA-256
d’origine ; cette évolution du code ne les réanalyse pas.
