# Assets d'épisode pour Shenron

`src/shenron-episode.ts` transforme le manifeste complet Bun Video en brouillon
de recherche local ou en objet compatible avec le propriétaire d'intake Shenron.
Aucun appel éditorial, upload, ingestion RAG ou écriture de base n'est effectué.
Le skill `shenron:dragon-ball` reste un workflow de recherche publique sourcée.

## Contrat réel consulté

Le propriétaire est `packages/media/src/episode-video-delivery.ts` dans le
checkout Shenron sélectionné. `EpisodeVideoDelivery` attend exactement :

| Champ       | Format                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------- |
| `producer`  | `"bun-video"`                                                                                |
| `episodeId` | Identifiant numérique de la fiche wiki, distinct du numéro d'épisode                         |
| `source`    | `{url, sha256, bytes}` de la référence qualifiée                                             |
| `video`     | `{width, height, durationSeconds}`                                                           |
| `frames`    | 1 à 600 PNG originaux : `{url, sha256, bytes, width, height, timecodeSeconds, format:"png"}` |
| `subtitles` | Pistes externes normalisées : `{url, language, label, sha256}` ; URL `.vtt`                  |

Les URLs sont des HTTPS canoniques, sans query, fragment ou credentials. Les
frames et VTT appartiennent à l'origine publique custom-domain configurée ; une
URL R2 technique ne convient pas. L'adaptateur exige une table d'URLs qualifiées
par asset : il n'invente pas des emplacements de publication à partir des chemins.

L'appel pur `episodeVideoPatch` de Shenron convertit les frames vers son champ
éditorial `frames` et les pistes vers `{lang,label,src}`. Il arrondit sa colonne
entière `durationSec` par défaut inférieur ; la provenance conserve la durée
exacte. Bun Video conserve donc **1 397,688 s**, même si ce champ devient `1397`.
Le vieux type `EpisodeFrame` (`packages/db/src/bot-schema.ts`) décrit le pipeline
historique `source:"ffmpeg"` ; ne pas l'utiliser pour contourner le nouvel intake
`producer:"bun-video"` ni lui ajouter SVG/GIF arbitrairement.

Le catalogue `apps/site/src/lib/episode-series-catalogue.ts` distingue
`DBS_BEERUS` du premier anime `DBS`. La recherche publique Shenron
`dragonball_search("Le dieu de la Destruction")` a renvoyé le 13 octobre 2026 :
**fiche 875**, série `DBS_BEERUS`, épisode 1, titre « Le dieu de la Destruction ».
La [fiche publique](https://dragonballfr.com/wiki/episodes/875) est le point de
rattachement observé ; la référence média Crunchyroll est `GE00389313JAJP`.
Ce rattachement de catalogue n'est pas un verdict de canon.

## Brouillon local et manifeste complet

```ts
import { createShenronEpisodeDraft } from "../src/shenron-episode";
import type { EpisodePackageManifest } from "../src/episode-assets";

const manifest = (await Bun.file(
  ".local/episodes/beerus-01/package/manifest.json",
).json()) as EpisodePackageManifest;
const draft = createShenronEpisodeDraft(manifest, 240);
await Bun.write(
  ".local/episodes/beerus-01/shenron-episode-draft.json",
  JSON.stringify(draft, null, 2),
);
```

Le brouillon est explicitement `bun-video/shenron-episode-draft/v1`, un format
local Bun Video, et non un faux schéma Shenron. Il référence le contrat réel,
les hashes, les dimensions, le FPS rationnel et la continuité anime. Il ne
renseigne pas un verdict canon ni un ID wiki sans preuve.

La sélection de 240 frames est uniforme, déterministe et conserve les première
et dernière frames. Le timestamp est `(frameNumber-1) * fps.denominator /
fps.numerator` ; `frameNumber` démarre à 1 et le timecode démarre à 0. Les
33 511 frames restent présentes dans le manifeste intégral et ses archives.
Les frames réduites, GIFs, SVGs, posters, storyboards, hashes et reçus conservent
leurs types et leur provenance dans `package/manifest.json`, hors du sous-ensemble
PNG/VTT du contrat Shenron. Ne pas déclarer un SVG dérivé comme dessin canonique.

Les 177 cues français obtenus pour cette référence appartiennent au sidecar
provider normalisé ; les inscriptions déjà incrustées ne deviennent pas une
nouvelle piste sélectionnable. Garder les headers, cookies, URLs signées et
sessions de Crunchyroll dans leur store protégé, hors du manifeste et des archives.
Une collecte média n'autorise pas implicitement une publication ou une ingestion.

## Conversion après qualification des URLs

`createShenronEpisodeDelivery(manifest, options)` renvoie la forme d'intake réelle.
Fournir `episodeId`, `sourceUrl`, `publicAssetOrigin` et `assetUrls` uniquement
après vérification de la cible wiki et des assets correspondants. Les URLs sont
fournies explicitement, jamais dérivées automatiquement de l'origine. La fonction
effectue une conversion pure et ne publie rien. Le manifeste local peut donc
être livré sans prétendre disposer d'une publication publique qualifiée.

Pour vérifier la compatibilité du propriétaire actuel, résoudre le checkout
Shenron dans le contexte courant puis lancer :

```powershell
$env:BUN_VIDEO_SHENRON_ROOT = '<checkout Shenron sélectionné>'
bun test test/shenron-episode.test.ts
```

Le test charge uniquement `packages/media/src/episode-video-delivery.ts` de ce
checkout et appelle son convertisseur pur avec une fixture. Quatre tests et
26 assertions passent sur le checkout consulté : timing fractionnaire, sélection
bornée, refus des URLs signées/non qualifiées et acceptation par le contrat réel.
Cette qualification ne prouve ni upload, ni lecture publique, ni écriture CMS.
