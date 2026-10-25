# Références SVG exactes

`rgbaToPixelSVG` convertit une grille RGBA de 256 × 256 pixels au maximum
en paths SVG remplis. Les runs horizontaux identiques partagent un path par
couleur RGBA. Il conserve chaque valeur de couleur et d’alpha, sans quantification,
autotrace approximatif ni image PNG incorporée. La grille SVG utilise
`shape-rendering="crispEdges"` et les coordonnées entières de la référence.

```powershell
bun scripts/episode-svg.ts .local/episodes/beerus-01
bun test test/pixel-svg.test.ts
bun scripts/episode-svg.ts --handoff-themes .local/episodes/beerus-01
```

La commande relit les preuves visuelles des personnages du manifeste. Elle
produit une frame vectorielle complète de référence par personnage, cinq
frames de moments et les portraits recadrés vérifiés visuellement de Beerus
et Whis. Les 26 icônes stylisées existantes restent distinctes.

Les recadrages utilisent `Bun.Image.extract`, puis `Bun.Image` génère une référence
PNG sans perte à la dimension choisie. `Bun.Image.rgba` fournit le RGBA du même PNG encodé
en paths. Le manifeste `icons/exact/manifest.json` conserve source, SHA-256,
numéro d’image, temps, rectangle, résolution, méthode et statut de vérification.
Le runtime doit être qualifié avec ces deux méthodes natives. La première série
déjà produite avant cette migration utilisait le décodeur FFmpeg ; ses reçus
conservent cette provenance. Le CLI actuel n’exécute aucune commande externe.

L’exactitude concerne la référence PNG redimensionnée. Le portrait recadré
conserve le cadrage visible dans l’anime, y compris les parties déjà coupées
par le cadre source. Une frame complète n’est pas présentée comme un portrait
détouré. La référence est le dessin de l’anime Dragon Ball Super ; aucun dessin
personnel d’Akira Toriyama n’est affirmé.

Le navigateur doit rendre SVG et PNG sur deux canvas de mêmes dimensions.
`compareRGBAFrames` contrôle les buffers décodés avec tolérance zéro et inscrit
le résultat dans le manifeste. Les couleurs RGB invisibles lorsque alpha = 0
restent dans le SVG, mais un canvas rend ces pixels transparents sous la forme
RGBA zéro, comme pour le PNG. Les mesures portent sur ce rendu navigateur.

Le mode `--handoff-themes` traite les six frames du handoff local Shenron.
`Bun.Image` les redimensionne à 64 pixels de largeur avec filtre `bilinear`.
`Bun.Image.rgba` décode le PNG en RGBA ; `frameThemeFromRGBA` produit tous les
rôles avec la variante `fidelity` sombre. Le handoff conserve la version effective
de `@aphrody/m3-tokens`, le filtre, les dimensions, la source et son hash.
