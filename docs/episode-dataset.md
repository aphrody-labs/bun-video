# Dataset de l’épisode : sous-titres et images

`bun src/episode-dataset.ts .local/episodes/beerus-01` prépare le dataset privé
à partir des PNG originaux, des sous-titres réellement fournis par Crunchyroll
et du catalogue visuel des personnages. Les médias et données dérivées restent
dans le dossier ignoré. Aucun entraînement ni écriture dans Shenron n’est effectué.

La source possède déjà la piste audio japonaise. Le français est incrusté dans
l’image. La version japonaise référence les mêmes octets : elle conserve ce texte
incrusté et ne prétend pas créer un autre doublage.

## Sous-titres japonais et reconnaissance vocale

`bun scripts/episode-subtitles.ts --locale ja-JP` consulte les pistes de
sous-titres et de captions réellement présentes dans les réponses capturées pour
cet épisode. `result-ja.json` conserve les listes de langues proposées et le
statut HTTP du contrôle direct, sans exposer les URL signées ou l’authentification.
Un japonais reconnu ou traduit n’est jamais présenté comme une piste officielle.

Le modèle multilingue `whisper-large-v3-turbo-q8` est installé dans le magasin
protégé par `aphrody model pull`. Son SHA-256 est vérifié contre le catalogue
et les métadonnées primaires Hugging Face. Le runtime Windows CUDA officiel
Whisper.cpp est vérifié contre le digest GitHub et installé dans le magasin
de runtimes géré par Aphrody. Aucun build de dépendance n’est nécessaire.

Bun Video utilise la copie de travail WAV mono PCM à 16 kHz déjà extraite de
l’audio japonais original. `bun src/episode-dataset.ts --asr-windows` découpe
ses samples avec les octets et en-têtes WAV natifs de Bun, sans lancer FFmpeg.
Chaque fenêtre de vingt secondes est reconnue par `aphrody voice transcribe`.
Le frontal conserve le texte mais omet les segments : les minutages livrés
correspondent aux bornes mesurées des fenêtres audio, jamais à des mots
prétendument alignés. `timingMethod: fixed-source-audio-window` et
`wordTimestampsVerified: false` conservent cette distinction. La dernière
fenêtre s’arrête au dernier sample réellement présent dans la piste.

`bun src/episode-dataset.ts --finalize-asr` normalise la transcription native,
écrit `ja-JP.asr.vtt`, `ja-JP.asr.srt` et `ja-JP.asr.jsonl`, puis régénère
le dataset. La source porte toujours le libellé
`native-ASR-from-Crunchyroll-Japanese-audio` et
`officialProviderTrack: false`. Les probabilités natives ne représentent pas
une précision calibrée. Les segments sans intervalle exploitable sont conservés
dans `ja-JP.asr.untimed.jsonl` sans inventer de timestamps. Le reçu distingue
traitement de tout l’audio et exactitude de chaque phrase. Les résultats natifs
dominés par une longue phrase répétée sont rejetés ; cette vérification ne
garantit pas la justesse de toutes les autres phrases. Les sorties brutes et
journaux des jobs restent dans le magasin vocal protégé d’Aphrody.

## Images et alignement

Tous les dialogues français du fichier ASS fournisseur entrent dans
`all-cues.jsonl`. L’ASS conserve styles et placement ; VTT/SRT conservent texte
et minutages. Les identifiants de piste absents de l’API restent null : une clé
locale et un hash identifient le contenu récupéré.

L’alignement FR/JA conserve les intervalles qui se chevauchent, leur durée et
leurs taux de couverture. Un chevauchement ne prouve pas l’équivalence de
traduction ou l’identité du locuteur. Sans piste ni ASR exploitable, le japonais
reste explicitement null.

Chaque dialogue mesure trois images originales à l’intérieur de son intervalle.
`Bun.Image` produit des vignettes de 160×90 pixels et `.rgba()` les décode via
le propriétaire natif, avec un budget maximal de 256×256 pixels. Aucun parseur
PNG ni décompresseur n’est réimplémenté dans le dataset.
Le codec natif suit son contrat de décodage sans validation des CRC PNG ;
l’intégrité des assets repose sur les SHA-256 du manifeste.
`measureFrameDetail` renvoie désormais une promesse et délègue les métriques à
`analyzeFrameRgba` : un seul dispatch WGSL mesure luminance, contraste, arêtes,
variance du Laplacien et score. Le workflow sélectionne explicitement Chromium,
avec un timeout de cinq secondes par image, et conserve l’adaptateur réellement
utilisé. `BUN_VIDEO_CHROMIUM_EXECUTABLE` permet de choisir le Chrome natif installé.
Un adaptateur indisponible interrompt le calcul sans substitution CPU silencieuse.
Le bas de l’image est exclu pour limiter le biais des contours des sous-titres.
Ces métriques sont des heuristiques de détail, pas des classifications de scène.
Les datasets produits avant cette consolidation conservent leurs métriques,
leur provenance et leurs SHA-256 ; cette modification ne les réanalyse pas.

L’image sélectionnée garde son chemin PNG original, sa résolution 1920×1080,
son index et son SHA-256. Les vignettes ne la remplacent pas.
`best-frames.json` classe le détail visuel mesuré ; il ne prétend pas reconnaître
le meilleur moment dramatique. Les preuves de personnages proches dans le temps
restent du contexte, sans devenir des détections dans l’image choisie.

## Découpage et provenance Shenron

Les partitions JSONL train/validation/test regroupent des blocs de trente
secondes avec un hash stable et une répartition approximative 80/10/10. Elles
proviennent toutes du même épisode. Le reçu indique cette limite et conserve
`readyForUnreviewedFineTuning: false`. Des épisodes indépendants et la
qualification des locuteurs, personnages visibles et associations image/dialogue
permettent d’évaluer la généralisation. Ces données d’animé ne deviennent pas
automatiquement du canon manga.

Les noms japonais proviennent uniquement des réponses réelles en lecture seule
de `shenron-mcp:dragonball.lexicon_search`. `lexicon.json` conserve les
identifiants et graphies retournées. Les lectures absentes restent null :
aucun kana, kanji ou romaji n’est déduit.
