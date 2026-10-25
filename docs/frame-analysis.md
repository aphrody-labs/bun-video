# Analyse de frames avec le propriétaire WebGPU

`analyzeFrameRgba` exécute un shader WGSL via `runWebGpuJob`. Il réutilise le
propriétaire wgpu de `@aphrody/bun-runtime-sdk/gpu` ou le WebGPU réel de Chromium
piloté par `bun:chromium`. Aucun moteur, crate, codec ou repli CPU n’est ajouté.

```ts
import { analyzeFrameRgba } from "@aphrody/bun-video/frame-analysis";

const pixels = await new Bun.Video(source).frame(10).resize(160, 90).rgba();
const analysis = await analyzeFrameRgba(pixels, {
  backend: "chromium",
  chromiumExecutable: qualifiedChromiumPath,
  timeout: 5000,
});
```

Cette API serveur reçoit des pixels RGBA8 `Uint8Array`, avec des dimensions
entières de 4 à 256 et au plus 65 536 pixels. Elle copie l’entrée dans un unique
buffer de stockage d’au plus 271 440 octets, largement sous la limite de 16 MiB
du propriétaire. Les buffers partagés sont refusés. Un seul dispatch de 64
invocations traite au plus 1 024 pixels par invocation ; histogrammes, sommes,
variances, énergie des contours et couleur dominante sont calculés sur le GPU.
La référence CPU existe uniquement dans les tests.

Le résultat contient les histogrammes de luminance (256 cases) et RGB quantifié
sur trois bits par canal (512 cases). `dominantColor` représente la moyenne RGB
réelle de la case la plus fréquente. Les pixels d’alpha inférieur à 128 et la
bordure d’un pixel sont exclus. Par défaut, les 28 % inférieurs contenant les
sous-titres incrustés sont également exclus ; `excludeCaptionRegion: false`
permet d’analyser tout l’intérieur de la frame.

Les métriques sont des heuristiques appliquées aux valeurs RGB de la source :
elles ne constituent ni une conversion ICC, ni un détecteur de flou calibré,
ni une sélection sémantique des meilleurs moments. `elapsedMs` vient du
propriétaire et comprend l’attente et la lecture du résultat ; ce n’est pas
une mesure par requête de timestamps GPU.

`adapter` provient du même propriétaire que le dispatch. Le backend doit être
choisi explicitement lorsqu’un artefact natif manque ; aucun changement de
backend ni calcul CPU ne masque une erreur. Le délai accepté est de 1 à
30 000 ms. Chromium utilise un profil temporaire isolé, attend le chargement du
document sécurisé local, puis ferme le navigateur dans tous les cas. Une
application doit limiter les jobs en vol et ignorer les réponses après un seek.
La disponibilité du calcul WebGPU ne prouve pas un décodage vidéo sur GPU.

Les tests GPU sont activés explicitement avec `BUN_FRAME_ANALYSIS_GPU_TEST=1` et
un `BUN_CHROMIUM_PATH` qualifié. Les tests ordinaires n’utilisent pas le réseau
public et ne nécessitent aucun adaptateur.
