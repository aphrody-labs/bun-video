# Source, workers et qualification vidéo

Le catalogue SQLite décrit les sources, capacités, tâches et résultats. Il ne
prouve pas l'accès à un site : distinguer catalogue d'extracteurs, extraction
d'une URL, lecture navigateur, décodage, capture composition et encodage final.
Les sessions et médias privés restent dans le magasin Aphrody protégé.

## Pool de tâches et SQLite

Depuis `packages/bun-video`, le point d'entrée est `src/apps/video-workers-cli.ts` :

```sh
bun src/apps/video-workers-cli.ts init
bun src/apps/video-workers-cli.ts sources
bun src/apps/video-workers-cli.ts apis
bun src/apps/video-workers-cli.ts apis --probe ytdlp
bun src/apps/video-workers-cli.ts import-capture "C:/Users/aphro/src/www.crunchyroll.com.har"
bun src/apps/video-workers-cli.ts run jobs.json --workers 2 --timeout-ms 300000
bun src/apps/video-workers-cli.ts sites sites.json
bun src/apps/video-workers-cli.ts archive-capture https://web.archive.org/ --cdx-url https://www.crunchyroll.com/
```

`--db` choisit un chemin SQLite explicite ; par défaut
`~/.aphrody/data/bun-video/video.sqlite`. Garder la DB d'exécution et les plans
privés hors du dépôt si les sources contiennent des URLs signées ou données
personnelles. `init` initialise le schéma et le catalogue ; `sources` expose
les entrées et `apis` les API enregistrées sans charger tous les fournisseurs
natifs. Lire `--help` pour les options et defaults exacts du CLI installé.

`import-capture <har>` inspecte une capture réelle existante et enregistre ses
sources et sa qualification ; préserver l'original et garder les ressources
extraites dans les magasins protégés. Une capture MPD DASH avec CENC et réponses
206 partielles fournit de la découverte réseau, pas un média déchiffré complet.
Ne jamais présenter ces octets comme une lecture, un rendu ou une comparaison
pixel-perfect réussis.

Le propriétaire applicatif unifié est `src/video-workflow.ts` :
`createUnifiedVideoPipeline()` expose `.apis()` (familles du registre courant), `.api(family)`
(chargement paresseux du propriétaire natif), `.render(task)` (pool de processus),
`.catalog`, `.capture()` (Chrome actif), `.qualifySites()` et `.close()`.
`.archiveCapture(options)` capture le graphe HTTP Archive explicite ;
`.queryDataset(query)` interroge les métadonnées autorisées et
`.exportDataset(options)` produit JSON, JSONL, SQL ou wiki curaté.
`.dataSite(options)` crée le site Bun avec le même catalogue.
`.inspectCookies(privateSQLitePath)` sélectionne les cookies Crunchyroll privés
et enregistre seulement leur référence ; `.probeCookies()` inspecte la vraie
page HTTP sans preuve implicite d'authentification ou de lecture DRM.
Le CLI `archive-capture` importe aussi le HAR obtenu dans le catalogue SQLite.
La couverture HTTP est distincte du trafic JavaScript du navigateur.
Charger une API ne prouve ni acquisition ni lecture. Réutiliser ce propriétaire
pour brancher une application ou un agent, plutôt qu'assembler un autre pipeline.

Pour exporter dans le magasin privé sur Windows :

```powershell
$videoDatasetPath = Join-Path $env:USERPROFILE '.aphrody/data/bun-video/dataset.json'
bun src/apps/video-workers-cli.ts export $videoDatasetPath --format json --include-text
```

`--format` accepte `json`, `jsonl`, `sql` et `wiki`. `--source-id` restreint la
source exportée. Le texte est optionnel (`--include-text`) et curaté ; les
colonnes privées, cookies et en-têtes bruts ne sont pas exposés par ce contrat.

`run` attend un tableau JSON de tâches : chaque tâche indique `source`
(`kind: "file"`, `"direct"`, `"page"` ou `"capture"`, et `value`), `engine` (`"remotion"`
ou `"hyperframes"`), `output`, `width`, `height`, `fps` et `durationFrames`.
`fps` accepte un nombre ou un rationnel `{ "num": 30000, "den": 1001 }`,
avec un débit maximal de 240 FPS. Les options comprennent `frameWorkers`, `composition` (`entry` et `id`),
`browserExecutable`, `ffmpegExecutable` et `engineExecutable`. Résoudre les
exécutables sur l'hôte actuel. Une composition existante permet de reconstruire
la scène ; la composition automatique place le média acquis dans le renderer.
Pour `capture`, `value` est le chemin absolu de l'index privé normalisé et
`requestId` sélectionne une seule requête média. L'acquisition refuse les
sources ambiguës, incomplètes ou chiffrées ; une ressource image peut servir
de référence graphique, sans être annoncée comme la vidéo du lecteur.
`videoFrameFormat` sélectionne explicitement `png` (défaut) ou `jpg` pour
l'extraction HyperFrames ; JPEG est lossy et n'autorise aucune promesse de pixels
exacts. Les sources alpha restent soumises au PNG imposé par le propriétaire.
Une sortie `.mov` choisit le mode ProRes des renderers ; ce mode n'est pas FFV1
et ne prouve pas l'exactitude RGBA. Le fournisseur FFmpeg doit supporter les
encodeurs de sortie et les codecs d'image de la capture, notamment PNG.
Pour une source à FPS rationnel, par exemple `30000/1001`, conserver le couple
numérateur/dénominateur et les timestamps de référence. Le propriétaire de tâche
transmet le rationnel à HyperFrames et sa valeur numérique non arrondie à
Remotion, puis contrôle le débit du fichier avec FFprobe. Ne pas arrondir
silencieusement à 30. Une sortie explicitement rééchantillonnée ne prouve pas
une correspondance temporelle exacte de la source.

Une sortie `.mkv` sélectionne le chemin sans perte : Remotion rend avec
`--sequence --image-format png`, HyperFrames avec `--format png-sequence`,
puis le FFmpeg natif encode les frames réellement rendues en FFV1 niveau 3
BGRA. Le propriétaire vérifie le nombre, l'ordre et la continuité des PNG
avant encodage. Le codec préserve ces pixels rendus ; la comparaison à la
référence reste nécessaire pour prouver que la composition les reproduit.

Le chemin MKV conserve le sidecar audio composé `audio.m4a` de HyperFrames.
Pour Remotion, une source audio ou une composition personnalisée déclenche
un rendu audio WAV séparé ; les compositions personnalisées imposent une piste
audio, silencieuse si nécessaire. FFmpeg multiplexe cette piste sans réencodage.
L'absence d'audio composé pour une source qui contient de l'audio fait échouer
la tâche. Qualifier trims, synchronisation et durée séparément des pixels.

Exemple de `jobs.json` (adapter les chemins absolus aux entrées et sorties
autorisées sur l'hôte courant) :

```json
[
  {
    "source": { "kind": "file", "value": "C:/media/reference.mp4" },
    "engine": "remotion",
    "output": "C:/media/render/reference.mp4",
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "durationFrames": 90,
    "frameWorkers": 1
  }
]
```

Le runtime Bun, le navigateur et les CLI des renderers doivent être disponibles
et qualifiés. Le fournisseur média doit pouvoir décoder la source et encoder
la sortie ; les DLL/exécutables requis ne sont pas installés par la DB.
Les exécutables de renderer peuvent être sélectionnés via `BUN_VIDEO_REMOTION`
et `BUN_VIDEO_HYPERFRAMES`, ou `BUN_VIDEO_ENGINE` pour le CLI unifié. Les champs
`browserExecutable` et `ffmpegExecutable` de tâche sélectionnent leurs fournisseurs.
La comparaison de frames exige aussi un `ffprobeExecutable` explicite.
`BUN_VIDEO_PACKAGE_ROOT` résout les sources possédées si le package est déplacé.

`--workers` borne les tâches concurrentes de 1 à 4 ; `frameWorkers` borne le
parallélisme du renderer d'une tâche de 1 à 4, avec un produit maximal de 8.
Chaque tâche possède un processus Bun distinct pour ses API natives de thread
principal. Le pool appelle le CLI complet Remotion ou HyperFrames, puis vérifie
l'artefact ; il ne substitue pas une capture native sans décodage vidéo au
renderer média. Commencer par deux tâches avec peu de frame workers. Le délai termine les
processus possédés et conserve le résultat d'échec, sans répéter indéfiniment
une extraction ou lancer implicitement un autre hôte.

`sites` qualifie une liste explicite de sources. La DB conserve les statuts
`passed`, `failed`, `blocked` et `not_tested` selon les observations. Conserver
la date et le stade réellement testé ; l'extraction passée n'est pas un rendu
pixel-perfect. Ne pas importer une liste d'extracteurs comme autant de sites
testés avec succès.

## Inspection de la source

Depuis `packages/bun-video`, sur un runtime Aphrody qualifié :

```sh
bun src/apps/network-window.tsx https://www.crunchyroll.com/
```

Chrome/Edge installé et les API natives `bun:chromium`/`bun:windows` sont requis.
L'acquisition du site utilise le profil Chrome actif et son `userDataDir`
original : attacher la session existante, sans mode invité, nouveau profil ni
copie du profil. Les cookies restent dans leur magasin original. L'outil doit
supporter cet attachement avant de qualifier le site ; un lancement sur profil
isolé ne valide pas cette session utilisateur. Les exports observés restent
dans les magasins protégés, jamais dans le catalogue public.
Le sélecteur DevTools permet de relier l'élément vidéo à `currentSrc`, au cadre
et aux requêtes manifestes/segments. L'export reste dans
`$APHRODY_HOME/cookies/network-window/<session>` ; voir
[le contrat de capture](network-window.md). Un export réseau contient seulement
le trafic observé et les corps effectivement récupérables.

Pour une vidéo locale, conserver les métadonnées du conteneur et les timestamps
de référence. Pour HLS/DASH, sélectionner variante vidéo et piste audio ; les
manifestes peuvent demander cookies, CORS ou DRM. Les catalogues de yt-dlp
énumèrent des extracteurs, pas une preuve de fonctionnement de tous leurs sites.

## Composition et capture

Le contrat de capture existant est `FramePlan`, dans `src/frame-plan.ts` :

`src/hyperframes-native.ts` possède la capture HyperFrames et la validation des
PNG ; l'export du moteur absorbé réutilise cette même fonction. Le rendu Remotion,
les workers et les captures HyperFrames partagent les délais et l'annulation de
`src/frame-plan.ts`. Les exports `/engine`, `/encode` et `/computer` pointent
directement vers leurs propriétaires sous `src/`.

Le générateur historique `scripts/owned-paths.ts` a été retiré : ses manifestes
`remotion/UPSTREAM.json` et `hyperframes/UPSTREAM.json` ne correspondent plus
aux sources absorbées sous `packages/`, et son parcours global incluait les
assets privés de `.local`. Les assets d'épisode sont recensés et empaquetés par
`scripts/episode-package.ts` depuis leur manifeste dédié.

```ts
import { captureParallelFrames } from "@aphrody/bun-video";

const plan = {
  kind: "remotion" as const,
  compositionUrl: "http://127.0.0.1:3000",
  composition: "ReferenceVideo",
  fps: { num: 30000, den: 1001 },
  startFrame: 0,
  endFrame: 30,
  width: 1920,
  height: 1080,
  workers: 2,
  timeoutMs: 30000,
  allowPrivateNetwork: true,
};

for await (const { frame, png } of captureParallelFrames(plan)) {
  await Bun.write(`frames/${String(frame).padStart(6, "0")}.png`, png);
}
```

Créer le répertoire de sortie avant la capture. `endFrame` est exclusif. La
composition doit être servie et supporter le rendu déterministe ; une page
vidéo quelconque n'est pas une composition Remotion. HyperFrames utilise
`kind: "hyperframes"` et son adaptateur de timeline, sans composition ID Remotion.
Le fournisseur navigateur natif doit être qualifié sur l'hôte choisi.
`allowPrivateNetwork` autorise ici le serveur de composition local sélectionné.
Le renderer peut posséder un profil pour sa composition locale ; cela ne remplace
pas le profil actif utilisé pour acquérir la source Crunchyroll.

`captureParallelFrames` conserve l'ordre des frames, borne les données en vol
et valide les dimensions PNG. `encodeVideo(plan, options, signal)` utilise
un exécutable média explicite et un chemin de sortie absolu. FFV1 conserve
l'exactitude RGBA 8 bits ; `nvenc`, `qsv` et `amf` nécessitent `allowLossy: true`.
Cette capture de frames ne garantit pas le multiplexage audio : qualifier
l'audio dans le pipeline d'encodage choisi et contrôler le fichier final.

## Carte des API possédées

Lire les types et les guides correspondants avant de brancher une famille :

| Famille               | Export/API du package                                                                                        | Rôle et qualification                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Normalisation         | `/source`: `resolveVideoSource`, `materializeVideoSource`                                                    | Fichiers, URL et octets ; flux mémoire bornés à 512 Mio                 |
| Pipeline natif        | `/pipeline`: `createVideo`, `openVideoPipeline`                                                              | `Bun.Video`, FFmpeg, mpv optionnel, GPU qualifié séparément             |
| Catalogue extracteurs | `/ytdlp`: `extractYtDlp`, `listYtDlpFormats`, `downloadYtDlp`, `extractYtDlpPlaylist`, `listYtDlpExtractors` | Acquisition autorisée via bridge natif `bun:python` et buv              |
| Options yt-dlp        | `/ytdlp`: `normalizeYtDlpOptions`, `parseYtDlpOptions`, `runYtDlpCli`, `ytDlpRuntimeInfo`                    | Vérifier runtime et options du fournisseur possédé avant extraction     |
| HLS                   | `/hls`: `attachVideoHlsPlayback`, `getHlsBrowserAssetPath`                                                   | Lecture navigateur et ressources hls.js possédées                       |
| DASH/MPD              | `/dash`: `inspectDashManifest`, `attachDashPlayback`                                                         | Inspection manifeste et lecture dash.js                                 |
| HAR                   | `/har`: `CapturedHar`, `loadHarCapture`                                                                      | Recherche dans une capture privée fournie                               |
| Lecteurs              | `/bitmovin`, `/crunchyroll`, `/mpv`                                                                          | Licence, authentification et environnement séparément qualifiés         |
| Métadonnées/auth      | `/crunchyroll/api`, `/oauth`, `/secrets`                                                                     | Les secrets restent dans leurs magasins isolés                          |
| React preview         | `/studio`: `VideoStudio`; `/studio-remotion`: `StudioRemotionComposition`                                    | Lecture React et placement dans une composition                         |
| React rendu           | `/remotion`, `/remotion/renderer`; `loadRemotionCore`, `loadRemotionRenderer`                                | Sources épinglées dans `remotion/`                                      |
| HTML rendu            | `/hyperframes`, `/hyperframes/engine`; `loadHyperframesCore`, `loadHyperframesEngine`                        | Sources épinglées dans `hyperframes/`                                   |
| Frames/encodage       | `captureCompositionFrames`, `captureParallelFrames`, `/encode`: `encodeVideo`                                | Fournisseurs navigateur et encodeur explicites                          |
| Demux/mux Web         | `/mediabunny`                                                                                                | WebCodecs et conteneurs ; disponibilité des codecs du moteur à vérifier |
| Images/formats        | `/image`: `transformImage`; `/formats`                                                                       | Conversion native et listes de formats, sans preuve d'un codec installé |
| GPU                   | `/webgpu`: `nativeWebGpuInfo`, `probeChromiumWebGpu`, `runWebGpuJob`                                         | Compute distinct de lecture DRM et encodage vidéo                       |
| Archives/cache        | `/archive`: `writeVideoArchive`; `/cache`: `CrawlerCache`                                                    | Stockage explicite, limites et confidentialité des entrées              |
| Agent                 | `/mcp`: `registerVideoTools`; `/capabilities`: `capabilities`                                                | Enregistrer auprès du propriétaire canonique, sans alias MCP legacy     |
| Workflow unifié       | `/workflow`: `createUnifiedVideoPipeline`; `/api`, `/catalog`, `/workers`                                    | Propriétaires de routage, SQLite et subprocess pool                     |
| Capture privée        | `/video-capture`                                                                                             | Import HAR réel, ressources et index normalisé protégés                 |
| Comparaison           | `/pixel-verify`: `compareRGBAFrames`, `verifyPixelFrames`                                                    | Mesure des frames décodées, exactitude et tolérance explicite           |

Les sources Remotion possédées contiennent leurs guides dans
`remotion/docs/docs/`. Pour HyperFrames, lire les références
d'auteur sous `hyperframes/`. Conserver licences et provenance ; ne pas
installer une deuxième copie upstream pour contourner un fournisseur manquant.

## Critère pixel-perfect

Comparer les frames décodées RGBA aux mêmes timestamps, avec mêmes dimensions,
rotation et conversion colorimétrique. Enregistrer le nombre de pixels différents,
erreur maximale et moyenne par canal, et produire une image de différence.
Documenter échantillons et intervalle : quelques frames égales ne prouvent pas
toute la vidéo. Vérifier séparément coupe audio, synchronisation et durée.
Une différence nulle permet une affirmation limitée aux frames et conditions
mesurées. Un rendu H264 lossy ou une simple capture PNG réussie ne prouve pas
l'exactitude des pixels du fichier final.

Les snapshots et mesures sont propres au navigateur, polices et codecs du
host qualifié. Une mesure locale ne constitue pas une garantie universelle.

Pour une source FFV1 locale, le compositor Remotion épinglé ne possède pas le
décodeur. Le worker utilise FFmpeg natif pour décoder le nombre borné de vraies
frames PNG, puis React `Img`, `useCurrentFrame` et `staticFile` pour les placer.
Une piste audio présente est décodée en WAV et composée par `Audio`; la référence
artistique qualifiée n'en contient aucune. Les sources vidéo prises en charge
par le compositor utilisent `OffthreadVideo`. Ce placement et cet échantillonnage
ne reconstituent pas une scène créative ni un film complet.

`src/pixel-verify.ts` possède `compareRGBAFrames(reference, candidate, limits)`
pour les octets déjà décodés et `verifyPixelFrames(input)` pour les fichiers
de frames. Les seuils `channelTolerance` et `maxDifferingPixelRatio` sont nuls
par défaut et doivent être explicites pour une comparaison tolérante. `exact`
indique zéro différence, tandis que `passed` peut simplement satisfaire les
seuils. Le résultat porte sur `selected-reference-frames` ; il ne prouve pas
les frames non mesurées, le déchiffrement ni la qualité audio.

Les fichiers image sont décodés avec `Bun.Image.rgba()` et les fichiers vidéo
avec `Bun.Video.frame(0).rgba()`, sans redimensionnement. Les paramètres historiques
des exécutables média sont facultatifs et ignorés. Le délai borne l'attente du
résultat ; une opération native déjà lancée termine dans son worker.

Les fixtures déterministes servent uniquement aux tests unitaires et de protocoles.
La qualification d'un site utilise de vrais sites choisis par l'utilisateur,
dont `https://www.crunchyroll.com/`, dans le profil Chrome actif. La qualification
du rendu réel part des captures ou médias accessibles de cette session lorsque
l'accès et le décodage sont supportés. Conserver statut, stade, horodatage et
erreur ; une fixture n'est pas un test Crunchyroll, et aucun test fini ne couvre
« tous les sites ».
