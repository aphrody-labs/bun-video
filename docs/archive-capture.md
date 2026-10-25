# Capture Internet Archive

`captureArchiveHTTP()` dans `src/archive-capture.ts` écrit un HAR standard 1.2
réutilisable par les autres processus. Par défaut : vraie URL
`https://web.archive.org/`, magasin privé
`~/.aphrody/cookies/archive-capture/web.archive.org.har`.

La couverture déclarée est **HTTP** : URLs explicites, redirections et ressources
statiques HTML/CSS découvertes depuis `archive.org`, y compris leurs domaines
HTTPS publics nécessaires. Les contenus `data:` restent présents dans les corps
HTML/CSS et ne constituent pas des requêtes omises. Aucune
exécution JavaScript, récupération de cache navigateur, cookie utilisateur ou
attachement à Chrome n'est prétendu. Un HAR navigateur complet requiert un
fournisseur CDP réellement qualifié sur le profil Chrome original.

Les requêtes et réponses observées incluent en-têtes, status, corps base64 et
durées fetch/réception. DNS, TCP et TLS non mesurables sont marqués `-1`.
Le fetch Bun peut décompresser les réponses ; les corps sont ceux livrés par
fetch, pas une capture des octets TLS. Les tailles d'en-têtes sont inconnues.

Limites : 250 requêtes, seize domaines, 32 Mio par corps, 128 Mio au total,
20 secondes par requête. Les statuts HTTP d'erreur, troncatures, ressources
hors périmètre et limites sont conservés explicitement. `complete` porte
uniquement sur le périmètre HTTP déclaré, jamais sur le graphe JavaScript.
La sortie stable est remplacée atomiquement sans archive de versions.

`cdxURLs` accepte au plus trois URLs exactes choisies par le propriétaire,
avec au plus trois captures CDX par URL et champs metadata explicites.
Si la requête CDX échoue, une requête exacte au timemap JSON officiel est tentée
une seule fois, avec les mêmes limites ; les échecs restent dans le HAR.
Le collector n'énumère pas tout Internet et ne télécharge pas automatiquement
les instantanés trouvés. Référence du propriétaire :
[CDX Server API Internet Archive](https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md).

```ts
import { captureArchiveHTTP } from "@aphrody/bun-video/archive-capture";
const summary = await captureArchiveHTTP({
  cdxURLs: ["https://www.crunchyroll.com/"],
});
console.log(summary); // Metadata et chemin uniquement, aucun corps ni cookie.
```
