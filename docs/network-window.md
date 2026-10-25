# Fenêtre réseau Windows

`src/apps/network-window.tsx` ouvre le vrai site dans une fenêtre Chrome Windows,
avec le profil Chrome actif, ou le dernier profil original si Chrome est fermé, et ses données existantes. URL par défaut :
`https://www.crunchyroll.com/`. Aucun profil invité, copie de profil, serveur
de démonstration ou redémarrage Chrome n'est utilisé.

```sh
bun src/apps/network-window.tsx https://www.crunchyroll.com/
network-window.exe --check
network-window.exe https://www.crunchyroll.com/ --endpoint http://127.0.0.1:9222
```

L'ouverture utilise le plan propriétaire Chrome et `Bun.spawn` natif. L'inspection requiert
un endpoint CDP déjà vivant dans le profil actif : `DevToolsActivePort` ou
`--endpoint`. Le port doit appartenir au processus Chrome actif identifié.
Sans CDP, la vraie fenêtre s'ouvre puis l'outil signale précisément que
l'inspection et les exports sont indisponibles. Il ne change aucun flag,
paramètre de débogage ou politique du navigateur.

Depuis Chrome 136, les commutateurs de débogage distant ne fonctionnent plus
sur le répertoire de données par défaut ; voir la
[documentation officielle Chrome](https://developer.chrome.com/blog/remote-debugging-port).
La disponibilité CDP du profil courant reste une qualification distincte.

Le panneau React est rendu dans un Shadow DOM et un monde CDP isolé. L'outil
attache uniquement la nouvelle fenêtre du site et ses sous-cibles. Aucun
onglet déjà ouvert n'est choisi comme cible de secours. Le sélecteur DevTools
affiche l'élément, son cadre, son HTML et son `currentSrc`. Les flux candidats
HLS/DASH, vidéo/audio et segments se filtrent par URL et cadre ; cette
correspondance reste un indice, pas une preuve de causalité.

« Exporter » écrit dans `$APHRODY_HOME/cookies/network-window/<session>`
(défaut `~/.aphrody/cookies/network-window/<session>`) :

- `cookies.json` : cookies applicables au site et aux URLs observées, avec
  HttpOnly et partitionnement ; aucun transfert entre profils.
- `network.json` et `network.ndjson` : événements et requêtes observés après
  l'attachement, redirections, initiateurs, réponses, corps et erreurs.
- `site.html`, `site.mhtml`, `resources/*` : DOM, archive et corps récupérables.

Les corps évincés, réponses en cours, flux infinis et contenus DRM ne sont pas
garantis récupérables. Les tampons CDP limitent chaque ressource à 32 Mio et
le total à 128 Mio. Ces fichiers privés restent hors Git.

`--check` inspecte et exporte la vraie page ouverte, avec un délai CDP borné.
Il ne simule ni lecteur ni cookies et ne prouve pas la lecture vidéo. La
fenêtre réelle reste ouverte après la vérification. « Fermer » ferme seulement
la cible créée par l'outil ; aucun Job Windows ne possède le Chrome utilisateur.
