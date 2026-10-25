# yt-dlp dans le binaire Bun Video

`scripts/ytdlp-assets-plugin.ts` embarque les sources Python du propriétaire
`yt-dlp/yt_dlp` et ses données runtime distribuées, dont les trois
scripts du solveur JavaScript upstream. Les tests, caches Python et dossiers
de dépendances ne sont pas embarqués. Aucun cookie ou profil utilisateur n'est
collecté pour ce build.

Le module virtuel `bun-video:ytdlp-vendor` expose `vendorRoot` et un inventaire
`{files, bytes}`. L'import est différé au premier appel yt-dlp dans le binaire
autonome. Les fichiers sont alors extraits dans un répertoire temporaire possédé
par ce processus ; son chemin absolu et son préfixe sont vérifiés avant nettoyage.
Le bridge désactive l'écriture du bytecode Python.

L'ordre de sélection reste explicite : `options.vendorRoot`, puis
`BUN_VIDEO_YTDLP_VENDOR_ROOT`, puis `BUN_VIDEO_PACKAGE_ROOT/packages/yt-dlp`.
Sans override, le binaire autonome utilise ses assets embarqués et l'exécution
source utilise le package du checkout. Le runtime CPython et sa bibliothèque
hôte native restent des fournisseurs distincts à qualifier.

Après compilation, vérifier `ytDlpRuntimeInfo()`, `listYtDlpExtractors()` et le
CLI `--version` avec les overrides de source désactivés. Un inventaire de
fichiers ou un chargement Python réussi ne prouve pas l'extraction d'un site.
