# Replay natif d’un épisode

Le replay conserve la source encodée dans un nouveau MP4 avec `Bun.Video.remux`.
Le propriétaire FilmCraft copie les access units audio/vidéo et leurs horloges,
sans encodeur vidéo ni commande externe. Il refuse les configurations qu’il ne
peut pas préserver et n’écrase aucune sortie existante.

```powershell
bun scripts/episode-replay.ts replay --episode-dir .local/episodes/episode-1 --timeout-ms 14400000
bun scripts/episode-replay.ts verify --episode-dir .local/episodes/episode-1 --timeout-ms 14400000
```

Le runtime doit inclure les API natives `Bun.Video` et `Bun.Image.rgba` qualifiées.
Dans le checkout, utiliser `bun bd` pour vérifier le binaire modifié. Exécuter les
longues opérations en arrière-plan ; aucun nouveau replay intégral n’est prouvé
par la seule présence du code ou des tests de petits fixtures.

Le manifeste déclare source, SHA-256, dimensions, nombre d’images et FPS rationnel.
`verification/episode-replay.json` contient la portée effective et les mesures :

- dimensions, cadence rationnelle, nombre de frames et durées source/sortie ;
- comparaison RGBA de chaque frame via `Bun.Video.frames` et `Bun.Image.rgba`,
  tolérance zéro, avec SHA-256 global des pixels et liste des frames différentes ;
- timestamps source/sortie avec borne de 1 ms et contrôle de la timeline CFR ;
- comparaison de toutes les fenêtres WAV PCM16 natives, par piste et au même
  sample rate ; la dernière fenêtre couvre exactement la fin déclarée ;
- hashes des fichiers encodés, qui ne remplacent pas la mesure des pixels.

La vérification conserve une seule opération native à la fois. Chaque batch
contient au plus huit frames et 64 MiB d’octets PNG ; les dimensions plus grandes
réduisent ce nombre. Les fenêtres audio font au plus vingt secondes. L’égalité
PCM mesurée reste distincte de la préservation des access units garantie par
le remux natif. Un reçu incomplet ne qualifie jamais un replay intégral.

## Portée des images extraites

`scripts/episode-assets.ts extract` produit des PNG ou WebP sans perte à la
résolution native avec `Bun.Video.frames` et `Bun.Image`. `--frame-limit` produit
un lot explicitement `partial`. Une destination qui contient déjà des frames
est refusée, afin de préserver les références qualifiées et leurs SHA-256.

Le replay actuel ne réencode pas cette séquence en un nouveau codec vidéo et
ne crée pas de scènes indépendantes. L’égalité entre une ancienne extraction
et un nouveau décodeur doit être mesurée séparément ; elle n’est jamais inférée
par l’égalité source/remux obtenue avec le même propriétaire natif.

## Composition indépendante

Utiliser les propriétaires Remotion/HyperFrames existants pour produire des
frames déterministes, puis comparer chaque frame de composition à la référence
avec `compareRGBAFrames`, à dimensions et timestamps identiques. Conserver
crop, couleurs, typographie, audio et rythme ; une modification reste une différence.

Le provider natif présent expose extraction, WAV, GIF et remux. Il n’expose pas
un encodeur vidéo de séquence RGBA arbitraire. Le code source primaire FilmCraft
pinné a été inspecté : `filmcraft-avi` est un demuxer, `filmcraft-apv` un décodeur,
et `filmcraft-h264enc` est un encodeur H264 ; leur présence ne qualifie pas une
reconstruction RGBA sans perte. Aucun appel `encodeFrames` n’est inventé.
Livrer les frames mesurées et leur manifeste jusqu’à qualification d’un encodeur
natif réellement capable de préserver ce contrat.

Les artifacts de la première analyse, produits avant la migration native,
conservent leur provenance historique et leurs propres reçus. Le pipeline et
le replay actuels n’invoquent aucun FFmpeg/FFprobe.
