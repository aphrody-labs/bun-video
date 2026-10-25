# Capture vidéo HAR privée

`importCapturedVideoNetwork(path, { catalog?, outputDirectory? })` lit le HAR original sans le modifier ni le copier. L'import ne contacte aucun site. Les corps enregistrés de toutes les réponses sont extraits dans `bodies/` : HTML, JavaScript, CSS, JSON, images, polices, sous-titres, manifests, médias et réponses de licences.

Par défaut les sorties restent sous `APHRODY_HOME/cookies/bun-video/captures/<uuid>` (`~/.aphrody` si cette variable est absente). `capture-index.json` conserve les URLs, headers, cookies et métadonnées HAR dans cet espace privé ; il ne doit jamais être publié. Les corps base64 sont décodés en octets. Le fichier brut reste une référence à son chemin d'origine.

L'index normalisé contient `requests`, `requestId` égal à l'index HAR, `bodyFile` relatif, MIME/status, plages demandées/reçues et classifications. `CapturedHar` valide les entrées et les manifests DASH utilisent `inspectDashManifest`. `ContentProtection`, chemins `cenc` et liens aux manifests chiffrés restent signalés. Une réponse 206, une plage `Content-Range` ou un segment reconnu n'est jamais marqué comme vidéo complète. `renderable` exige un média complet et non chiffré ; ce drapeau n'est pas une qualification de lecture ou d'encodage.

Le catalogue SQLite optionnel ajoute `capture_entries` et `captured_resources` avec références privées, host, méthode, MIME, statut, tailles et flags. Aucune URL complète, query signée, valeur de header/cookie ni corps n'est stocké dans ces tables. Le catalogue garde la source comme référence à l'index privé, sans job artificiel.

Les posters, images, styles, scripts, sous-titres et données JSON capturés restent utilisables comme références d'auteur pour une nouvelle animation React ou HyperFrames. Leur extraction ne transforme pas les fragments MP4 chiffrés en vidéo source décodée.

Les licences sont des ressources documentées ; elles ne sont pas proposées au renderer. L'import n'obtient pas de clés et ne déchiffre pas DRM. La présence de fragments MP4 et d'un MPD ne prouve pas une vidéo complète exploitable.
